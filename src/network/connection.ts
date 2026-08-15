import {
	ClientType,
	Packet,
	AirportState,
	AirportObject,
	MultiStateUpdateItem,
	HEARTBEAT_INTERVAL,
	HEARTBEAT_TIMEOUT,
	OnlinePilot,
	type JsonObject,
	type JsonValue,
} from '../types';
import { AuthService } from '../services/auth';
import { VatsimService } from '../services/vatsim';
import { PointsService } from '../services/points';
import { IDService } from '../services/id';
import { DivisionService } from '../services/divisions';
import { DatabaseContextFactory } from '../services/database-context';
import { PostHogService, type AnalyticsProperties, type AnalyticsPropertyValue } from '../services/posthog';
import {
	buildPointStateTemplate,
	chunkStateUpdates,
	getGeneratedAliasUpdates,
	selectCanonicalEquivalentState,
	type OfflineStateTemplate,
} from './point-state-equivalence';

const MAX_STATE_SIZE = 1000000; // 1MB limit for persisted payloads
const MAX_MESSAGE_SIZE = 64000;
const MAX_SHARED_PATCH_SIZE = 10240;
const MAX_MULTI_STATE_UPDATES = 200;
const MAX_REJECTED_PACKET_LOG_CHARACTERS = 4096;
const MAX_REJECTED_PACKET_TYPE_LOG_CHARACTERS = 256;
const OBJECT_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const STATE_FLUSH_DEBOUNCE_MS = 1500;
const ACTIVE_OBJECT_TOUCH_INTERVAL_MS = 60_000;
const SOCKET_STATUS_CHECK_INTERVAL_MS = 120000;
const MAX_CONSECUTIVE_STATUS_FAILURES = 2;
const OFFLINE_STATE_CACHE_TTL_MS = 300000;
const SEND_FAILURE_LIMIT = 3;
const EFFECTIVE_HEARTBEAT_TIMEOUT = Math.max(HEARTBEAT_TIMEOUT, HEARTBEAT_INTERVAL * 3);
const STALE_STATE_TIMEOUT_MS = 120_000;
const PACKET_DECODER = new TextDecoder();
const PACKET_ENCODER = new TextEncoder();
const SERIALIZED_HEARTBEAT = JSON.stringify({ type: 'HEARTBEAT' });
const SENSITIVE_LOG_KEY_REGEX =
	/^(?:authorization|proxy-authorization|cookie|set-cookie|key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password)$/i;
const VALID_PACKET_TYPES = new Set<string>([
	'HEARTBEAT',
	'HEARTBEAT_ACK',
	'STATE_UPDATE',
	'MULTI_STATE_UPDATE',
	'CLOSE',
	'SHARED_STATE_UPDATE',
	'INITIAL_STATE',
	'CONTROLLER_CONNECT',
	'CONTROLLER_DISCONNECT',
	'ERROR',
	'GET_STATE',
	'STATE_SNAPSHOT',
	'GET_ONLINE_PILOTS',
	'ONLINE_PILOTS',
	'STOPBAR_CROSSING',
]);

type StructuredValue = JsonValue;
type StructuredObject = JsonObject;
type RuntimeCandidate = StructuredValue | undefined | ArrayBuffer | MultiStateUpdateItem | NonNullable<Packet['data']>;
type RejectedPacketLog = {
	packet?: StructuredValue;
	packetPreview?: string;
	packetLogTruncated: boolean;
};
type WebSocketErrorDetails = {
	eventType: string;
	readyState: number;
	controllerId?: string;
	clientType?: ClientType;
	airport?: string;
	message?: string;
	filename?: string;
	lineno?: number;
	colno?: number;
	error?: AnalyticsProperties | string;
};
type SocketDebugDetails = {
	connectionId?: string;
	controllerId?: string;
	callsign?: string;
	clientType?: ClientType;
	airport?: string;
	readyState: number;
	socketCount: number;
	connectedForMs?: number;
	lastMessageAgoMs?: number;
	lastHeartbeatAgoMs?: number;
	receivedPackets?: number;
	sentPackets?: number;
	receivedBytes?: number;
	sentBytes?: number;
	sendFailures?: number;
};

const createNullObject = (): StructuredObject => Object.create(null);
const createAirportObjectDictionary = (): Record<string, AirportObject> => Object.create(null);
const isDisallowedKey = (key: string): boolean => key === '__proto__' || key === 'constructor' || key === 'prototype';

function isStructuredObject(value: RuntimeCandidate): value is StructuredObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function isMergeDictionary(value: RuntimeCandidate): value is StructuredObject {
	if (!isStructuredObject(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isAnalyticsProperties(value: AnalyticsPropertyValue): value is AnalyticsProperties {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function isStringValue(value: RuntimeCandidate): value is string {
	return value === String(value);
}

function isNumberValue(value: RuntimeCandidate): value is number {
	return Object.prototype.toString.call(value) === '[object Number]' && (value === Number(value) || Number.isNaN(value));
}

function isBooleanValue(value: RuntimeCandidate): value is boolean {
	return value === true || value === false;
}

function isSupportedPacketType(value: StructuredValue): value is Packet['type'] {
	return isStringValue(value) && VALID_PACKET_TYPES.has(value);
}

function getStructuredValueKind(value: StructuredValue | undefined): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (Array.isArray(value)) return 'array';
	if (isStringValue(value)) return 'string';
	if (isNumberValue(value)) return 'number';
	if (isBooleanValue(value)) return 'boolean';
	return 'object';
}

type SocketInfo = {
	connectionId: string;
	controllerId: string;
	callsign: string;
	type: ClientType;
	airport: string;
	connectedAt: number;
	lastHeartbeat: number;
	lastMessageAt: number;
	lastStatusCheck: number;
	statusCheckInFlight: boolean;
	consecutiveVatsimFailures: number;
	sendFailures: number;
	receivedPackets: number;
	sentPackets: number;
	receivedBytes: number;
	sentBytes: number;
};

type SocketTerminationRecord = {
	info: SocketInfo;
	reason: string;
	details: AnalyticsProperties;
	clean: boolean;
	startedAt: number;
	completedAt?: number;
	task?: Promise<void>;
};

type SocketTerminationOptions = {
	clean?: boolean;
	details?: AnalyticsProperties;
};

type ConnectionStatus = {
	banned: boolean;
	status: { cid: string; callsign: string; type: string } | null;
};

export type ConnectionStateSnapshot = {
	airport: string;
	controllers?: string[];
	pilots?: string[];
	objects: AirportObject[];
	offline: boolean;
};

function isSafeNestedValue(value: StructuredValue, maxDepth = 20, maxProperties = 100): boolean {
	const seen = new WeakSet<object>();
	const walk = (current: StructuredValue, depth: number): boolean => {
		if (!isStructuredObject(current) && !Array.isArray(current)) return true;
		if (depth > maxDepth || seen.has(current)) return false;
		seen.add(current);
		if (Array.isArray(current)) {
			return current.length <= 1000 && current.every((item) => walk(item, depth + 1));
		}
		const keys = Object.keys(current);
		return (
			keys.length <= maxProperties && keys.every((key) => key.length <= 100 && !isDisallowedKey(key) && walk(current[key], depth + 1))
		);
	};
	return walk(value, 0);
}

function describeErrorForLog(cause: unknown): AnalyticsProperties | string {
	if (cause instanceof Error) {
		return {
			name: cause.name,
			message: cause.message,
			stack: cause.stack,
		};
	}

	if (cause === null || cause === undefined) {
		return String(cause);
	}

	if (cause instanceof Object) {
		try {
			return JSON.parse(JSON.stringify(cause));
		} catch {
			return Object.prototype.toString.call(cause);
		}
	}

	return String(cause);
}

function sanitizeForDebugLog(value: AnalyticsProperties, depth?: number, seen?: WeakSet<object>): AnalyticsProperties;
function sanitizeForDebugLog(value: StructuredValue, depth?: number, seen?: WeakSet<object>): StructuredValue;
function sanitizeForDebugLog(
	value: AnalyticsPropertyValue,
	depth?: number,
	seen?: WeakSet<object>,
): AnalyticsPropertyValue;
function sanitizeForDebugLog(
	value: AnalyticsPropertyValue,
	depth = 0,
	seen = new WeakSet<object>(),
): AnalyticsPropertyValue {
	if (depth > 20) return '[maximum depth reached]';
	if (!isAnalyticsProperties(value) && !Array.isArray(value)) return value;
	if (seen.has(value)) return '[circular]';
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeForDebugLog(item, depth + 1, seen));
	}

	const sanitized: AnalyticsProperties = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		sanitized[key] = SENSITIVE_LOG_KEY_REGEX.test(key) ? '[redacted]' : sanitizeForDebugLog(nestedValue, depth + 1, seen);
	}
	return sanitized;
}

function describeRejectedPacketForLog(packet: StructuredValue): RejectedPacketLog {
	const sanitized = sanitizeForDebugLog(packet);
	let serialized: string;
	try {
		serialized = JSON.stringify(sanitized) ?? String(sanitized);
	} catch {
		serialized = String(sanitized);
	}

	if (serialized.length <= MAX_REJECTED_PACKET_LOG_CHARACTERS) {
		return { packet: sanitized, packetLogTruncated: false };
	}

	return {
		packetPreview: serialized.slice(0, MAX_REJECTED_PACKET_LOG_CHARACTERS),
		packetLogTruncated: true,
	};
}

function describeWebSocketErrorEvent(
	evt: ErrorEvent,
	socket: WebSocket,
	socketInfo?: { controllerId: string; type: ClientType; airport: string },
): WebSocketErrorDetails {
	const details: WebSocketErrorDetails = {
		eventType: evt.type,
		readyState: socket.readyState,
	};

	if (socketInfo) {
		details.controllerId = socketInfo.controllerId;
		details.clientType = socketInfo.type;
		details.airport = socketInfo.airport;
	}

	if (evt.message) details.message = evt.message;
	if (evt.filename) details.filename = evt.filename;
	if (evt.lineno) details.lineno = evt.lineno;
	if (evt.colno) details.colno = evt.colno;
	if (evt.error !== undefined && evt.error !== null) details.error = describeErrorForLog(evt.error);

	return details;
}

// Add recursive merge utility function with safety checks
function recursivelyMergeObjects(target: StructuredValue, source: StructuredValue, depth = 0): StructuredValue {
	// Prevent infinite recursion and overly deep nesting
	const MAX_DEPTH = 20;
	if (depth > MAX_DEPTH) {
		throw new Error('Maximum recursion depth exceeded in merge operation');
	}

	if (!isStructuredObject(source) && !Array.isArray(source)) {
		return source; // Return the source value if it's a primitive
	}

	// Handle arrays - replace the entire array
	if (Array.isArray(source)) {
		// Limit array size to prevent memory issues
		const MAX_ARRAY_SIZE = 1000;
		if (source.length > MAX_ARRAY_SIZE) {
			throw new Error(`Array size exceeds maximum allowed size of ${MAX_ARRAY_SIZE}`);
		}
		return [...source];
	}
	if (!isMergeDictionary(source)) {
		throw new Error('Merge source must be a plain or null-prototype object');
	}

	// Handle objects - lazily clone properties when needed
	const MAX_PROPERTIES = 100;
	const sourceKeys = Object.keys(source);
	if (sourceKeys.length > MAX_PROPERTIES) {
		throw new Error(`Object has too many properties (${sourceKeys.length} > ${MAX_PROPERTIES})`);
	}

	const targetRecord = isMergeDictionary(target) ? target : undefined;
	let result: StructuredObject;
	let cloned = false;

	if (targetRecord) {
		result = targetRecord;
	} else {
		result = createNullObject();
		cloned = true;
	}

	const ensureClone = () => {
		if (!cloned) {
			if (targetRecord) result = Object.assign(createNullObject(), targetRecord);
			cloned = true;
		}
	};

	for (const key of sourceKeys) {
		if (key.length > 100) {
			throw new Error('Invalid property key');
		}

		if (isDisallowedKey(key)) {
			throw new Error('Prototype pollution key rejected');
		}

		const sv = source[key];
		const rv = targetRecord && Object.prototype.hasOwnProperty.call(targetRecord, key) ? targetRecord[key] : undefined;

		if (isMergeDictionary(sv)) {
			if (isMergeDictionary(rv)) {
				const merged = recursivelyMergeObjects(rv, sv, depth + 1);
				if (merged !== rv) {
					ensureClone();
					result[key] = merged;
				}
			} else {
				ensureClone();
				result[key] = recursivelyMergeObjects(createNullObject(), sv, depth + 1);
			}
		} else if (sv !== rv) {
			ensureClone();
			result[key] = sv;
		}
	}

	return result;
}

export class Connection {
	private sockets = new Map<WebSocket, SocketInfo>();

	private airportStates = new Map<string, AirportState>();
	private airportSharedStates = new Map<string, StructuredObject>(); // New shared state storage
	private objectId: string; // Store the DO's ID
	private lastActiveObjectsUpdate = 0; // Throttle D1 updates
	private activeObjectTouchInFlight = false;
	private airportStateFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private airportSharedStateFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private dirtyAirportStates = new Set<string>();
	private dirtySharedStates = new Set<string>();
	private socketQueues = new Map<WebSocket, Promise<void>>();
	private socketTerminations = new WeakMap<WebSocket, SocketTerminationRecord>();
	private controllerSockets = new Map<string, Map<string, Set<WebSocket>>>();
	private pilotConnectionCounts = new Map<string, Map<string, { count: number; callsign: string }>>();
	private pendingConnectionStatusChecks = new Map<string, Promise<ConnectionStatus>>();
	private offlineStateCache = new Map<
		string,
		{
			template?: OfflineStateTemplate;
			expiresAt: number;
			inFlight?: Promise<OfflineStateTemplate>;
			version: number;
		}
	>();
	private offlineStateTemplateVersions = new Map<string, number>();
	private connectionCounts = {
		controllers: 0,
		pilots: 0,
		observers: 0,
	};
	private posthog: PostHogService;
	private lastKnownAirport = 'unknown';
	private readonly debugEnabled: boolean;

	constructor(
		private env: Env,
		private auth: AuthService,
		private vatsim: VatsimService,
		private state: DurableObjectState,
	) {
		this.objectId = state.id.toString();
		this.posthog = new PostHogService(env);
		this.debugEnabled = env.DEBUG.trim().toLowerCase() === 'true';
		this.debugLog('durable_object_initialized', {
			debugEnabled: this.debugEnabled,
		});
		this.state.blockConcurrencyWhile(async () => {
			await this.loadPersistedState();
		});
	}

	private debugLog(event: string, details: AnalyticsProperties = {}) {
		if (!this.debugEnabled) return;
		console.log({
			level: 'debug',
			subsystem: 'websocket',
			event,
			timestamp: new Date().toISOString(),
			durableObjectId: this.objectId,
			...sanitizeForDebugLog(details),
		});
	}

	private getSocketDebugDetails(socket: WebSocket, info = this.sockets.get(socket)): SocketDebugDetails {
		return {
			connectionId: info?.connectionId,
			controllerId: info?.controllerId,
			callsign: info?.callsign,
			clientType: info?.type,
			airport: info?.airport,
			readyState: socket.readyState,
			socketCount: this.sockets.size,
			connectedForMs: info ? Date.now() - info.connectedAt : undefined,
			lastMessageAgoMs: info ? Date.now() - info.lastMessageAt : undefined,
			lastHeartbeatAgoMs: info ? Date.now() - info.lastHeartbeat : undefined,
			receivedPackets: info?.receivedPackets,
			sentPackets: info?.sentPackets,
			receivedBytes: info?.receivedBytes,
			sentBytes: info?.sentBytes,
			sendFailures: info?.sendFailures,
		};
	}

	private registerSocket(
		socket: WebSocket,
		info: { controllerId: string; callsign?: string; type: ClientType; airport: string; lastHeartbeat: number },
	) {
		const socketInfo: SocketInfo = {
			...info,
			connectionId: crypto.randomUUID(),
			callsign: info.callsign ?? info.controllerId,
			connectedAt: Date.now(),
			lastMessageAt: info.lastHeartbeat,
			lastStatusCheck: 0,
			statusCheckInFlight: false,
			consecutiveVatsimFailures: 0,
			sendFailures: 0,
			receivedPackets: 0,
			sentPackets: 0,
			receivedBytes: 0,
			sentBytes: 0,
		};
		this.sockets.set(socket, socketInfo);
		this.adjustConnectionCount(socketInfo.type, 1);
		this.lastKnownAirport = socketInfo.airport;
		if (socketInfo.type === 'controller') {
			this.addControllerSocket(socket, socketInfo);
		} else if (socketInfo.type === 'pilot') {
			this.adjustPilotConnectionCount(socketInfo.airport, socketInfo.controllerId, socketInfo.callsign, 1);
		}
		this.debugLog('socket_registered', this.getSocketDebugDetails(socket, socketInfo));
	}

	private unregisterSocket(socket: WebSocket) {
		const info = this.sockets.get(socket);
		if (!info) {
			return undefined;
		}

		this.debugLog('socket_unregistering', this.getSocketDebugDetails(socket, info));
		this.adjustConnectionCount(info.type, -1);
		this.sockets.delete(socket);
		this.socketQueues.delete(socket);
		if (info.type === 'controller') {
			this.removeControllerSocket(socket, info);
		} else if (info.type === 'pilot') {
			this.adjustPilotConnectionCount(info.airport, info.controllerId, info.callsign, -1);
		}
		if (this.sockets.size === 0) {
			this.lastKnownAirport = 'unknown';
		} else if (info.airport === this.lastKnownAirport) {
			this.refreshLastKnownAirport();
		}

		return info;
	}

	private refreshLastKnownAirport() {
		for (const entry of this.sockets.values()) {
			this.lastKnownAirport = entry.airport;
			return;
		}
		this.lastKnownAirport = 'unknown';
	}

	private adjustConnectionCount(type: ClientType, delta: number) {
		switch (type) {
			case 'controller':
				this.connectionCounts.controllers = Math.max(0, this.connectionCounts.controllers + delta);
				break;
			case 'pilot':
				this.connectionCounts.pilots = Math.max(0, this.connectionCounts.pilots + delta);
				break;
			case 'observer':
				this.connectionCounts.observers = Math.max(0, this.connectionCounts.observers + delta);
				break;
		}
	}

	private addControllerSocket(socket: WebSocket, info: SocketInfo) {
		let airportControllers = this.controllerSockets.get(info.airport);
		if (!airportControllers) {
			airportControllers = new Map();
			this.controllerSockets.set(info.airport, airportControllers);
		}

		let controllerSockets = airportControllers.get(info.controllerId);
		if (!controllerSockets) {
			controllerSockets = new Set();
			airportControllers.set(info.controllerId, controllerSockets);
		}

		controllerSockets.add(socket);
		this.getOrCreateAirportState(info.airport).controllers.add(info.controllerId);
	}

	private removeControllerSocket(socket: WebSocket, info: SocketInfo) {
		const airportControllers = this.controllerSockets.get(info.airport);
		const controllerSockets = airportControllers?.get(info.controllerId);
		if (!airportControllers || !controllerSockets) return;

		controllerSockets.delete(socket);
		if (controllerSockets.size === 0) {
			airportControllers.delete(info.controllerId);
		}
		if (airportControllers.size === 0) {
			this.controllerSockets.delete(info.airport);
		}
	}

	private hasOtherControllerSocket(airport: string, controllerId: string, currentSocket: WebSocket): boolean {
		const sockets = this.controllerSockets.get(airport)?.get(controllerId);
		if (!sockets) return false;
		for (const socket of sockets) {
			if (socket !== currentSocket) {
				return true;
			}
		}
		return false;
	}

	private hasLiveControllers(airport: string): boolean {
		return (this.controllerSockets.get(airport)?.size ?? 0) > 0;
	}

	private getLiveControllerIds(airport: string): string[] {
		const airportControllers = this.controllerSockets.get(airport);
		return airportControllers ? Array.from(airportControllers.keys()) : [];
	}

	private adjustPilotConnectionCount(airport: string, pilotId: string, callsign: string, delta: number) {
		let airportPilots = this.pilotConnectionCounts.get(airport);
		if (!airportPilots) {
			if (delta <= 0) return;
			airportPilots = new Map();
			this.pilotConnectionCounts.set(airport, airportPilots);
		}

		const current = airportPilots.get(pilotId);
		const nextCount = (current?.count ?? 0) + delta;
		if (nextCount > 0)
			airportPilots.set(pilotId, { count: nextCount, callsign: delta > 0 ? callsign : (current?.callsign ?? callsign) });
		else airportPilots.delete(pilotId);
		if (airportPilots.size === 0) this.pilotConnectionCounts.delete(airport);
	}

	private getLivePilotIds(airport: string): string[] {
		const airportPilots = this.pilotConnectionCounts.get(airport);
		return airportPilots ? Array.from(airportPilots.keys()) : [];
	}

	private getLivePilots(airport: string): OnlinePilot[] {
		const airportPilots = this.pilotConnectionCounts.get(airport);
		return airportPilots ? Array.from(airportPilots, ([cid, pilot]) => ({ cid, callsign: pilot.callsign })) : [];
	}

	private updatePilotCallsign(airport: string, pilotId: string, callsign: string) {
		const pilot = this.pilotConnectionCounts.get(airport)?.get(pilotId);
		if (pilot) pilot.callsign = callsign;
	}

	private createOnlinePilotsPacket(airport: string, requestedAt: number, now = Date.now()): Packet {
		return {
			type: 'ONLINE_PILOTS',
			airport,
			data: {
				pilots: this.getLivePilots(airport),
				requestedAt,
			},
			timestamp: now,
		};
	}

	private emitAnalytics(event: string, properties: AnalyticsProperties) {
		const filtered = this.filterAnalyticsProperties(properties);
		try {
			this.posthog.track(event, filtered);
		} catch {
			// ignore analytics failures
		}
	}

	private filterAnalyticsProperties(properties: AnalyticsProperties): AnalyticsProperties {
		const filtered: AnalyticsProperties = {};
		for (const [key, value] of Object.entries(properties)) {
			if (value !== undefined) {
				filtered[key] = value;
			}
		}
		return filtered;
	}

	private emitAnalyticsBatch(events: readonly { event: string; properties: AnalyticsProperties }[]) {
		try {
			this.posthog.trackBatch(
				events.map((item) => ({
					event: item.event,
					properties: this.filterAnalyticsProperties(item.properties),
				})),
			);
		} catch {
			// ignore analytics failures
		}
	}

	private deserializeAirportState(airport: string, stored: StructuredValue): AirportState {
		const airportState = isStructuredObject(stored) ? stored : {};
		const storedObjects = isStructuredObject(airportState.objects) ? airportState.objects : {};
		const objects = new Map<string, AirportObject>();
		for (const [id, storedObject] of Object.entries(storedObjects)) {
			if (!isStructuredObject(storedObject)) continue;
			const rawState = storedObject.state;
			let normalizedState: boolean | StructuredObject;
			if (isBooleanValue(rawState)) {
				normalizedState = rawState;
			} else if (isStructuredObject(rawState)) {
				normalizedState = rawState;
			} else {
				normalizedState = {};
			}

			objects.set(id, {
				id,
				state: normalizedState,
				controllerId: isStringValue(storedObject.controllerId) ? storedObject.controllerId : undefined,
				timestamp: isNumberValue(storedObject.timestamp) ? storedObject.timestamp : Date.now(),
			});
		}

		const controllers = Array.isArray(airportState.controllers)
			? airportState.controllers.filter((controller): controller is string => isStringValue(controller))
			: [];

		return {
			airport,
			objects,
			lastUpdate: isNumberValue(airportState.lastUpdate) ? airportState.lastUpdate : Date.now(),
			controllers: new Set(controllers),
		};
	}

	private async loadPersistedState() {
		const states = new Map<string, AirportState>();
		const sharedStates = new Map<string, StructuredObject>();
		const startedAt = Date.now();
		this.debugLog('persisted_state_load_started');

		try {
			const [stateEntries, sharedEntries] = await Promise.all([
				this.state.storage.list<StructuredValue>({ prefix: 'airport_state:' }),
				this.state.storage.list<StructuredValue>({ prefix: 'airport_shared_state:' }),
			]);

			for (const [key, stored] of stateEntries) {
				const airport = key.slice('airport_state:'.length);
				if (!airport) continue;
				states.set(airport, this.deserializeAirportState(airport, stored));
			}

			for (const [key, stored] of sharedEntries) {
				const airport = key.slice('airport_shared_state:'.length);
				if (!airport) continue;
				if (isStructuredObject(stored)) {
					sharedStates.set(airport, stored);
				}
			}
			this.airportStates = states;
			this.airportSharedStates = sharedStates;
			this.debugLog('persisted_state_load_completed', {
				durationMs: Date.now() - startedAt,
				airportStateCount: states.size,
				sharedStateCount: sharedStates.size,
				objectCount: Array.from(states.values()).reduce((total, airportState) => total + airportState.objects.size, 0),
			});
		} catch (error) {
			console.error('Failed to load persisted state:', error);
			this.debugLog('persisted_state_load_failed', {
				durationMs: Date.now() - startedAt,
				error: describeErrorForLog(error),
			});
		}
	}

	private async persistAirportState(airport: string) {
		const state = this.airportStates.get(airport);
		const storageKey = `airport_state:${airport}`;

		if (!state) {
			try {
				this.debugLog('airport_state_delete_started', { airport, storageKey });
				await this.state.storage.delete(storageKey);
				this.debugLog('airport_state_delete_completed', { airport, storageKey });
			} catch (error) {
				console.error(`Failed to delete airport state for ${airport}:`, error);
				this.debugLog('airport_state_delete_failed', { airport, storageKey, error: describeErrorForLog(error) });
			}
			return;
		}

		const objects = createAirportObjectDictionary();
		for (const [id, object] of state.objects) {
			objects[id] = {
				id: object.id,
				state: object.state,
				controllerId: object.controllerId,
				timestamp: object.timestamp,
			};
		}

		const serialized = {
			airport: state.airport,
			objects,
			lastUpdate: state.lastUpdate,
			controllers: Array.from(state.controllers),
		};

		try {
			const serializedString = JSON.stringify(serialized);
			const serializedBytes = PACKET_ENCODER.encode(serializedString).byteLength;
			this.debugLog('airport_state_persist_started', {
				airport,
				storageKey,
				objectCount: state.objects.size,
				controllerCount: state.controllers.size,
				serializedCharacters: serializedString.length,
				serializedBytes,
			});
			if (serializedString.length > MAX_STATE_SIZE) {
				console.warn(
					`State size (${serializedString.length}) exceeds maximum (${MAX_STATE_SIZE}), skipping persistence for ${airport}`,
				);
				this.debugLog('airport_state_persist_skipped_size_limit', {
					airport,
					storageKey,
					objectCount: state.objects.size,
					serializedCharacters: serializedString.length,
					serializedBytes,
					maxCharacters: MAX_STATE_SIZE,
				});
				return;
			}

			await this.state.storage.put(storageKey, serialized);
			this.debugLog('airport_state_persist_completed', {
				airport,
				storageKey,
				objectCount: state.objects.size,
				serializedCharacters: serializedString.length,
				serializedBytes,
			});
		} catch (error) {
			console.error(`Failed to persist airport state for ${airport}:`, error);
			this.debugLog('airport_state_persist_failed', {
				airport,
				storageKey,
				objectCount: state.objects.size,
				error: describeErrorForLog(error),
			});
		}
	}

	private async persistSharedState(airport: string) {
		const sharedState = this.airportSharedStates.get(airport) ?? {};
		try {
			const serializedString = JSON.stringify(sharedState);
			if (serializedString.length > MAX_STATE_SIZE) {
				console.warn(
					`Shared state size (${serializedString.length}) exceeds maximum (${MAX_STATE_SIZE}), skipping persistence for ${airport}`,
				);
				return;
			}

			await this.state.storage.put(`airport_shared_state:${airport}`, sharedState);
		} catch (error) {
			console.error(`Failed to persist shared state for ${airport}:`, error);
		}
	}

	private markAirportStateDirty(airport: string, immediate = false) {
		this.dirtyAirportStates.add(airport);
		if (immediate) {
			this.state.waitUntil(this.flushAirportState(airport));
			return;
		}
		if (this.airportStateFlushTimers.has(airport)) return;
		const timer = setTimeout(() => {
			this.state.waitUntil(this.flushAirportState(airport));
		}, STATE_FLUSH_DEBOUNCE_MS);
		this.airportStateFlushTimers.set(airport, timer);
	}

	private markSharedStateDirty(airport: string, immediate = false) {
		this.dirtySharedStates.add(airport);
		if (immediate) {
			this.state.waitUntil(this.flushSharedState(airport));
			return;
		}
		if (this.airportSharedStateFlushTimers.has(airport)) return;
		const timer = setTimeout(() => {
			this.state.waitUntil(this.flushSharedState(airport));
		}, STATE_FLUSH_DEBOUNCE_MS);
		this.airportSharedStateFlushTimers.set(airport, timer);
	}

	private async flushAirportState(airport: string) {
		const timer = this.airportStateFlushTimers.get(airport);
		if (timer) {
			clearTimeout(timer);
			this.airportStateFlushTimers.delete(airport);
		}
		if (!this.dirtyAirportStates.has(airport)) return;
		this.debugLog('airport_state_flush_started', {
			airport,
			dirtyAirportCount: this.dirtyAirportStates.size,
		});
		this.dirtyAirportStates.delete(airport);
		await this.persistAirportState(airport);
		this.debugLog('airport_state_flush_completed', {
			airport,
			becameDirtyDuringFlush: this.dirtyAirportStates.has(airport),
		});
		if (this.dirtyAirportStates.has(airport) && !this.airportStateFlushTimers.has(airport)) {
			this.markAirportStateDirty(airport);
		}
	}

	private async flushSharedState(airport: string) {
		const timer = this.airportSharedStateFlushTimers.get(airport);
		if (timer) {
			clearTimeout(timer);
			this.airportSharedStateFlushTimers.delete(airport);
		}
		if (!this.dirtySharedStates.has(airport)) return;
		this.dirtySharedStates.delete(airport);
		await this.persistSharedState(airport);
		if (this.dirtySharedStates.has(airport) && !this.airportSharedStateFlushTimers.has(airport)) {
			this.markSharedStateDirty(airport);
		}
	}

	private async flushAirportDurableState(airport: string) {
		await Promise.all([this.flushAirportState(airport), this.flushSharedState(airport)]);
	}

	private resolvePacketAirport(packet: Packet, connectionAirport: string): string {
		if (packet.airport !== undefined && packet.airport !== connectionAirport) {
			throw new Error('Packet airport does not match connected airport');
		}
		return connectionAirport;
	}

	private broadcast(packet: Packet, sender?: WebSocket, trackAnalytics = true): number {
		const airport = packet.airport;
		if (!airport) {
			console.warn('Attempted to broadcast packet without airport identifier');
			return 0;
		}

		let packetString: string;
		try {
			packetString = JSON.stringify(packet);
		} catch (error) {
			console.error('Failed to serialize packet for broadcast:', error);
			return 0;
		}

		let recipients = 0;

		for (const [socket, client] of this.sockets) {
			if (socket !== sender && socket.readyState === WebSocket.OPEN && client.airport === airport) {
				recipients++;
				this.sendSerializedPacket(socket, packetString, 'broadcast');
			}
		}

		if (trackAnalytics) this.trackBroadcast(packet.type, airport, recipients);
		this.debugLog('packet_broadcast_completed', {
			direction: 'outbound',
			packetType: packet.type,
			airport,
			recipients,
			senderConnectionId: sender ? this.sockets.get(sender)?.connectionId : undefined,
		});
		return recipients;
	}

	private createStateUpdatePackets(updates: readonly MultiStateUpdateItem[], airport: string, timestamp: number): Packet[] {
		return chunkStateUpdates(updates, MAX_MULTI_STATE_UPDATES).map((chunk) =>
			chunk.length === 1
				? { type: 'STATE_UPDATE', airport, data: chunk[0], timestamp }
				: { type: 'MULTI_STATE_UPDATE', airport, data: { updates: chunk }, timestamp },
		);
	}

	private broadcastStateUpdates(updates: readonly MultiStateUpdateItem[], airport: string, timestamp: number, sender: WebSocket): number {
		let recipients = 0;
		for (const packet of this.createStateUpdatePackets(updates, airport, timestamp)) {
			recipients = Math.max(recipients, this.broadcast(packet, sender, false));
		}
		return recipients;
	}

	private sendStateUpdatesToSocket(
		socket: WebSocket,
		updates: readonly MultiStateUpdateItem[],
		airport: string,
		timestamp: number,
	): boolean {
		if (updates.length === 0) return false;
		return this.createStateUpdatePackets(updates, airport, timestamp).every((packet) =>
			this.sendPacket(socket, packet, 'duplicate_state_alias'),
		);
	}

	private getOrCreateAirportState(airport: string): AirportState {
		let state = this.airportStates.get(airport);
		if (!state) {
			state = {
				airport,
				objects: new Map(),
				lastUpdate: Date.now(),
				controllers: new Set(),
			};
			this.airportStates.set(airport, state);
		}
		return state;
	}
	private applyStateUpdateToAirport(
		state: AirportState,
		update: MultiStateUpdateItem,
		controllerId: string,
		now: number,
	): MultiStateUpdateItem {
		const objectId = update.objectId;

		if (!OBJECT_ID_REGEX.test(objectId)) {
			throw new Error('Invalid objectId format');
		}

		const hasPatch = Object.prototype.hasOwnProperty.call(update, 'patch');
		const hasState = Object.prototype.hasOwnProperty.call(update, 'state');

		if (!hasPatch && !hasState) {
			throw new Error(`Missing both patch and state data for object ${objectId}`);
		}

		let newState: boolean | StructuredObject | null;
		let normalized: MultiStateUpdateItem = { objectId };

		const existingObject = state.objects.get(objectId) || {
			id: objectId,
			state: {},
			controllerId: controllerId,
			timestamp: now,
		};

		if (hasPatch) {
			const patch = update.patch;
			if (patch === undefined) {
				throw new Error(`Missing patch data for object ${objectId}`);
			}
			if (patch !== null && !isStructuredObject(patch)) {
				throw new Error(`Patch data must be an object or null for object ${objectId}`);
			}

			if (patch === null) {
				state.objects.delete(objectId);
				state.lastUpdate = now;
				return { objectId, patch: null };
			}

			const baseState = isStructuredObject(existingObject.state) ? existingObject.state : {};
			const merged = recursivelyMergeObjects(baseState, patch);
			if (!isStructuredObject(merged)) {
				throw new Error(`Patch merge did not produce an object for object ${objectId}`);
			}
			newState = merged;
			normalized = { objectId, patch };
		} else {
			const stateValue = update.state;
			if (isBooleanValue(stateValue)) {
				newState = stateValue;
			} else if (isStructuredObject(stateValue)) {
				newState = stateValue;
			} else {
				throw new Error('State data must be boolean or object');
			}
			normalized = { objectId, state: newState };
		}

		state.objects.set(objectId, {
			id: objectId,
			state: newState,
			controllerId: controllerId,
			timestamp: now,
		});

		state.lastUpdate = now;

		return normalized;
	}

	private applyStateUpdateToEquivalentObjects(
		state: AirportState,
		update: MultiStateUpdateItem,
		controllerId: string,
		now: number,
		template: OfflineStateTemplate,
	): MultiStateUpdateItem[] {
		const objectId = update.objectId;

		const equivalentIds = template.equivalentIdsById.get(objectId) ?? [objectId];
		const normalized = this.applyStateUpdateToAirport(state, update, controllerId, now);
		if (equivalentIds.length === 1) return [normalized];

		if (normalized.patch === null) {
			return equivalentIds.map((equivalentId) =>
				equivalentId === objectId
					? normalized
					: this.applyStateUpdateToAirport(state, { objectId: equivalentId, patch: null }, controllerId, now),
			);
		}

		const canonicalState = state.objects.get(objectId)?.state;
		if (canonicalState === undefined) {
			throw new Error(`State update did not produce a value for object ${objectId}`);
		}

		return equivalentIds.map((equivalentId) =>
			this.applyStateUpdateToAirport(state, { objectId: equivalentId, state: canonicalState }, controllerId, now),
		);
	}

	private async handleStateUpdate(packet: Packet, controllerId: string, connectionAirport: string) {
		try {
			const update = this.parseStateUpdate(packet.data);
			if (!update) {
				throw new Error('Invalid packet data structure');
			}

			const airport = this.resolvePacketAirport(packet, connectionAirport);
			if (!airport || airport.length === 0) {
				throw new Error('Invalid airport identifier');
			}

			const template = await this.getOfflineStateTemplate(airport);
			const now = Date.now();
			const state = this.getOrCreateAirportState(airport);
			const normalizedUpdates = this.applyStateUpdateToEquivalentObjects(
				state,
				update,
				controllerId,
				now,
				template,
			);
			this.markAirportStateDirty(airport);
			const requestedObjectId = update.objectId;
			return {
				updates: normalizedUpdates,
				senderUpdates: getGeneratedAliasUpdates(normalizedUpdates, new Set([requestedObjectId])),
				timestamp: now,
				airport,
			};
		} catch (error) {
			console.error(`State update error for controller ${controllerId}`);
			if (error instanceof Error) {
				console.error(error.message);
			}
			throw new Error('State update error');
		}
	}

	private async handleMultiStateUpdate(packet: Packet, controllerId: string, connectionAirport: string) {
		const airport = this.resolvePacketAirport(packet, connectionAirport);
		if (!airport || airport.length === 0) {
			throw new Error('Invalid airport identifier');
		}

		const updatesPayload = this.parseMultiStateUpdates(packet.data);

		if (!updatesPayload || updatesPayload.length === 0) {
			throw new Error('Missing updates array');
		}

		if (updatesPayload.length > MAX_MULTI_STATE_UPDATES) {
			throw new Error(`Batch update exceeds maximum allowed size of ${MAX_MULTI_STATE_UPDATES}`);
		}

		const updates = updatesPayload;
		const requestedObjectIds = new Set(updates.map((update) => update.objectId));

		const template = await this.getOfflineStateTemplate(airport);
		const now = Date.now();
		const state = this.getOrCreateAirportState(airport);
		const normalizedUpdates: MultiStateUpdateItem[] = [];

		for (let index = 0; index < updates.length; index++) {
			const update = updates[index];
			try {
				const expandedUpdates = this.applyStateUpdateToEquivalentObjects(
					state,
					update,
					controllerId,
					now,
					template,
				);
				normalizedUpdates.push(...expandedUpdates);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Unknown error';
				throw new Error(`Update ${index + 1} failed: ${message}`);
			}
		}

		this.markAirportStateDirty(airport);

		return {
			updates: normalizedUpdates,
			senderUpdates: getGeneratedAliasUpdates(normalizedUpdates, requestedObjectIds),
			timestamp: now,
			airport,
		};
	}

	private async handleControllerDisconnect(socket: WebSocket) {
		const socketInfo = this.sockets.get(socket);
		if (!socketInfo || socketInfo.type !== 'controller') return;

		const state = this.airportStates.get(socketInfo.airport);
		if (state) {
			const controllerStillConnected = this.hasOtherControllerSocket(socketInfo.airport, socketInfo.controllerId, socket);
			if (controllerStillConnected) {
				return;
			}

			state.controllers.delete(socketInfo.controllerId);

			// Update timestamp when last controller disconnects
			if (state.controllers.size === 0) {
				state.lastUpdate = Date.now();
			}

			this.markAirportStateDirty(socketInfo.airport);
			await this.flushAirportDurableState(socketInfo.airport);

			this.broadcast(
				{
					type: 'CONTROLLER_DISCONNECT',
					airport: socketInfo.airport,
					data: { controllerId: socketInfo.controllerId },
					timestamp: Date.now(),
				},
				socket,
			);
		}
	}
	private startHeartbeat(socket: WebSocket) {
		let vatsimCheckCounter = 0;
		const VATSIM_CHECK_FREQUENCY = 2; // Check VATSIM status every 2 heartbeats

		const interval = setInterval(async () => {
			this.debugLog('heartbeat_tick', this.getSocketDebugDetails(socket));
			if (socket.readyState !== WebSocket.OPEN) {
				clearInterval(interval);
				return;
			}

			const socketInfo = this.sockets.get(socket);
			if (!socketInfo) {
				clearInterval(interval);
				return;
			}

			try {
				// Check if we haven't received a heartbeat in too long
				const now = Date.now();
				if (now - socketInfo.lastHeartbeat > EFFECTIVE_HEARTBEAT_TIMEOUT) {
					this.debugLog('heartbeat_timeout', {
						...this.getSocketDebugDetails(socket, socketInfo),
						effectiveTimeoutMs: EFFECTIVE_HEARTBEAT_TIMEOUT,
					});
					socket.close(1000, 'Heartbeat timeout');
					clearInterval(interval);
					return;
				}

				// Periodically check if the user is still connected to VATSIM
				vatsimCheckCounter++;
				if (vatsimCheckCounter >= VATSIM_CHECK_FREQUENCY) {
					vatsimCheckCounter = 0;
					const statusCheck = this.checkSocketStatus(socket, socketInfo, now);
					if (statusCheck) await statusCheck;
				}

				// Send heartbeat with error handling
				try {
					this.sendSerializedPacket(socket, SERIALIZED_HEARTBEAT, 'heartbeat');
				} catch (sendError) {
					console.error(`Failed to send heartbeat to ${socketInfo.controllerId}:`, sendError);
					this.debugLog('heartbeat_send_failed', {
						...this.getSocketDebugDetails(socket, socketInfo),
						error: describeErrorForLog(sendError),
					});
					socket.close(1011, 'Failed to send heartbeat');
					clearInterval(interval);
					return;
				}
			} catch (e) {
				console.error('Error in heartbeat:', e);
				this.debugLog('heartbeat_internal_error', {
					...this.getSocketDebugDetails(socket),
					error: describeErrorForLog(e),
				});
				socket.close(1011, 'Internal error in heartbeat');
				clearInterval(interval);
			}
		}, HEARTBEAT_INTERVAL);

		// Clean up interval on socket close
		socket.addEventListener('close', (event) => {
			const termination = this.socketTerminations.get(socket);
			const socketInfo = this.sockets.get(socket) ?? termination?.info;
			this.debugLog('heartbeat_stopped_on_close', {
				...this.getSocketDebugDetails(socket, socketInfo),
				code: event.code,
				reason: event.reason,
				wasClean: event.wasClean,
			});
			clearInterval(interval);
		});
	}

	private checkSocketStatus(socket: WebSocket, socketInfo: SocketInfo, now: number): Promise<void> | undefined {
		if (socketInfo.statusCheckInFlight || now - socketInfo.lastStatusCheck < SOCKET_STATUS_CHECK_INTERVAL_MS) {
			return undefined;
		}

		socketInfo.statusCheckInFlight = true;
		socketInfo.lastStatusCheck = now;
		return this.runSocketStatusCheck(socket, socketInfo, now);
	}

	private getConnectionStatus(controllerId: string): Promise<ConnectionStatus> {
		const existing = this.pendingConnectionStatusChecks.get(controllerId);
		if (existing) return existing;

		const request: Promise<ConnectionStatus> = (async () => {
			if (await this.auth.isVatsimIdBanned(controllerId)) {
				return { banned: true, status: null };
			}
			return { banned: false, status: await this.vatsim.getUserStatus(controllerId) };
		})().finally(() => {
			if (this.pendingConnectionStatusChecks.get(controllerId) === request) {
				this.pendingConnectionStatusChecks.delete(controllerId);
			}
		});
		this.pendingConnectionStatusChecks.set(controllerId, request);
		return request;
	}

	private async runSocketStatusCheck(socket: WebSocket, socketInfo: SocketInfo, now: number) {
		const startedAt = Date.now();
		this.debugLog('vatsim_status_check_started', this.getSocketDebugDetails(socket, socketInfo));
		try {
			const connectionStatus = await this.getConnectionStatus(socketInfo.controllerId);
			this.debugLog('vatsim_status_check_result', {
				...this.getSocketDebugDetails(socket, socketInfo),
				durationMs: Date.now() - startedAt,
				banned: connectionStatus.banned,
				connected: connectionStatus.status !== null,
				vatsimType: connectionStatus.status?.type,
				vatsimCallsign: connectionStatus.status?.callsign,
			});
			if (connectionStatus.banned) {
				this.sendPacket(socket, {
					type: 'ERROR',
					data: { message: 'Account banned' },
					timestamp: now,
				});
				socket.close(1008, 'Banned');
				await this.cleanupSocket(socket, 'banned');
				return;
			}

			const status = connectionStatus.status;
			if (!status) {
				socketInfo.consecutiveVatsimFailures++;
				if (socketInfo.consecutiveVatsimFailures >= MAX_CONSECUTIVE_STATUS_FAILURES) {
					this.sendPacket(socket, {
						type: 'ERROR',
						data: { message: 'No longer connected to VATSIM' },
						timestamp: now,
					});
					socket.close(1000, 'No longer connected to VATSIM');
					await this.cleanupSocket(socket, 'vatsim_offline');
				}
				return;
			}

			socketInfo.consecutiveVatsimFailures = 0;
			if (socketInfo.type === 'pilot' && status.callsign !== socketInfo.callsign) {
				socketInfo.callsign = status.callsign;
				this.updatePilotCallsign(socketInfo.airport, socketInfo.controllerId, status.callsign);
			}
			const isController = this.vatsim.isController(status);
			const isPilot = this.vatsim.isPilot(status);
			const isObserver = this.vatsim.isObserver(status);

			if (
				(socketInfo.type === 'controller' && !isController) ||
				(socketInfo.type === 'pilot' && !isPilot) ||
				(socketInfo.type === 'observer' && !isObserver)
			) {
				this.sendPacket(socket, {
					type: 'ERROR',
					data: { message: 'Role changed on VATSIM, please reconnect' },
					timestamp: now,
				});
				socket.close(1000, 'Role changed on VATSIM');
				await this.cleanupSocket(socket, 'role_changed');
			}
		} catch (error) {
			console.warn('Socket status check failed (non-fatal):', error);
			this.debugLog('vatsim_status_check_failed', {
				...this.getSocketDebugDetails(socket, socketInfo),
				durationMs: Date.now() - startedAt,
				error: describeErrorForLog(error),
			});
		} finally {
			socketInfo.statusCheckInFlight = false;
		}
	}

	private clearStaleState(airport: string) {
		const state = this.airportStates.get(airport);
		if (!state) return;

		const now = Date.now();

		if (now - state.lastUpdate > STALE_STATE_TIMEOUT_MS && !this.hasLiveControllers(airport)) {
			// Clear objects but keep the airport state structure
			state.objects.clear();
			state.lastUpdate = now;

			// Also clear shared state when no controllers are present for 2 minutes
			this.airportSharedStates.set(airport, {});

			this.markAirportStateDirty(airport);
			this.markSharedStateDirty(airport);
		}
	}

	private async getOfflineStateFromPoints(airport: string): Promise<AirportObject[]> {
		try {
			const template = await this.getOfflineStateTemplate(airport);
			return this.buildOfflineObjectsFromTemplate(template);
		} catch (error) {
			console.error(`Error fetching offline state for ${airport}:`, error);
			return []; // Return empty array if there's an error
		}
	}

	private async getOfflineStateTemplate(airport: string): Promise<OfflineStateTemplate> {
		const normalizedAirport = airport.toUpperCase();
		const version = this.offlineStateTemplateVersions.get(normalizedAirport) ?? 0;
		const cached = this.offlineStateCache.get(normalizedAirport);
		const now = Date.now();
		if (cached?.version === version && cached.template && cached.expiresAt > now) {
			return cached.template;
		}
		if (cached?.version === version && cached.inFlight) {
			const template = await cached.inFlight;
			if ((this.offlineStateTemplateVersions.get(normalizedAirport) ?? 0) !== version) {
				return this.getOfflineStateTemplate(normalizedAirport);
			}
			return template;
		}

		const inFlight = this.loadOfflineStateTemplate(normalizedAirport);
		this.offlineStateCache.set(normalizedAirport, {
			expiresAt: now + OFFLINE_STATE_CACHE_TTL_MS,
			inFlight,
			version,
		});
		try {
			const template = await inFlight;
			if ((this.offlineStateTemplateVersions.get(normalizedAirport) ?? 0) !== version) {
				return this.getOfflineStateTemplate(normalizedAirport);
			}
			this.offlineStateCache.set(normalizedAirport, {
				template,
				expiresAt: Date.now() + OFFLINE_STATE_CACHE_TTL_MS,
				version,
			});
			return template;
		} catch (error) {
			console.error(`Error fetching offline state for ${airport}:`, error);
			if (this.offlineStateCache.get(normalizedAirport)?.inFlight === inFlight) {
				this.offlineStateCache.delete(normalizedAirport);
			}
			return { points: [], equivalentIdsById: new Map() };
		}
	}

	async invalidatePointStateTemplate(airport: string, removedPointIds: readonly string[] = []): Promise<void> {
		const normalizedAirport = airport.toUpperCase();
		const version = (this.offlineStateTemplateVersions.get(normalizedAirport) ?? 0) + 1;
		this.offlineStateTemplateVersions.set(normalizedAirport, version);
		this.offlineStateCache.delete(normalizedAirport);

		const template = await this.getOfflineStateTemplate(normalizedAirport);
		const state = this.airportStates.get(normalizedAirport) ?? this.airportStates.get(airport);
		if (!state) return;

		let removedState = false;
		for (const pointId of removedPointIds) removedState = state.objects.delete(pointId) || removedState;
		if (removedState) this.markAirportStateDirty(normalizedAirport);
		this.synchronizeEquivalentStateOverrides(state, template, normalizedAirport);
	}

	private async loadOfflineStateTemplate(airport: string): Promise<OfflineStateTemplate> {
		const idService = new IDService();
		const divisions = new DivisionService(this.env.DB);
		const pointsService = new PointsService(this.env.DB, idService, divisions);

		return buildPointStateTemplate(await pointsService.getAirportPoints(airport));
	}

	private buildOfflineObjectsFromTemplate(template: OfflineStateTemplate): AirportObject[] {
		const timestamp = Date.now();
		return template.points.map((point) => ({
			id: point.id,
			state: point.state,
			timestamp,
		}));
	}

	private async getOnlineStateObjects(airport: string, state: AirportState): Promise<AirportObject[]> {
		const template = await this.getOfflineStateTemplate(airport);
		this.synchronizeEquivalentStateOverrides(state, template, airport);
		return Array.from(state.objects.values());
	}

	private synchronizeEquivalentStateOverrides(state: AirportState, template: OfflineStateTemplate, airport: string) {
		const visited = new Set<readonly string[]>();
		let changed = false;

		for (const ids of template.equivalentIdsById.values()) {
			if (visited.has(ids)) continue;
			visited.add(ids);

			const latest = selectCanonicalEquivalentState(ids, state.objects);
			if (!latest) continue;

			for (const id of ids) {
				const existing = state.objects.get(id);
				if (
					existing?.timestamp === latest.timestamp &&
					existing.controllerId === latest.controllerId &&
					JSON.stringify(existing.state) === JSON.stringify(latest.state)
				) {
					continue;
				}
				state.objects.set(id, { ...latest, id });
				changed = true;
			}
		}

		if (changed) this.markAirportStateDirty(airport);
	}

	async handleWebSocket(request: Request) {
		const url = new URL(request.url);
		let apiKey = url.searchParams.get('key');
		const airport = url.searchParams.get('airport');
		// Also accept API key via Authorization
		if (!apiKey) {
			const authz = request.headers.get('Authorization') || '';
			if (authz.toLowerCase().startsWith('bearer ')) {
				apiKey = authz.slice(7);
			}
		}

		this.debugLog('connection_attempt', {
			airport,
			hasCredential: Boolean(apiKey),
			credentialSource: url.searchParams.has('key') ? 'query' : apiKey ? 'authorization_header' : 'none',
			userAgent: request.headers.get('User-Agent'),
			cfRay: request.headers.get('CF-Ray'),
			cfCountry: request.headers.get('CF-IPCountry'),
		});

		const deny = async (reason: string) => {
			this.debugLog('connection_denied', { airport, reason });
			const jitter = Math.floor(Math.random() * 30) + 20;
			await new Promise((r) => setTimeout(r, jitter));
			return new Response('Unauthorized', { status: 401 });
		};

		if (!apiKey) return await deny('missing_credential');
		if (!airport) return await deny('missing_airport');

		const { user, banned } = await this.auth.getConnectionPrincipalByApiKey(apiKey);
		if (!user) return await deny('invalid_credential');

		// Ban enforcement: deny connection if banned
		if (banned) {
			this.debugLog('connection_denied', { airport, controllerId: user.vatsim_id, reason: 'banned' });
			return new Response('Banned', { status: 403 });
		}

		const status = await this.vatsim.getUserStatus(user.vatsim_id);
		if (!status) {
			this.debugLog('connection_denied', { airport, controllerId: user.vatsim_id, reason: 'not_connected_to_vatsim' });
			return new Response('User not connected to VATSIM', { status: 403 });
		}
		// Auto-determine client type based on VATSIM status
		const clientType = this.vatsim.isController(status) ? 'controller' : this.vatsim.isObserver(status) ? 'observer' : 'pilot';

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		server.accept();

		// Load or create airport state and clear stale persisted state before this new socket makes it look live.
		const state = this.getOrCreateAirportState(airport);
		this.clearStaleState(airport);

		// Initialize socket info with the airport and heartbeat
		this.registerSocket(server, {
			controllerId: user.vatsim_id,
			callsign: status.callsign,
			type: clientType,
			airport: airport,
			lastHeartbeat: Date.now(),
		});
		this.debugLog('connection_accepted', {
			...this.getSocketDebugDetails(server),
			vatsimType: status.type,
		});

		// Start heartbeat mechanism
		this.startHeartbeat(server);

		// Track connection in background to avoid blocking WS upgrade on slow D1
		this.state.waitUntil(
			this.trackConnection(clientType, airport).catch((err) => {
				console.error('trackConnection failed:', err);
			}),
		);

		// Handle controller connection
		if (clientType === 'controller') {
			this.markAirportStateDirty(airport, true);

			// Notify others about new controller
			this.broadcast(
				{
					type: 'CONTROLLER_CONNECT',
					airport,
					data: { controllerId: user.vatsim_id },
					timestamp: Date.now(),
				},
				server,
			);
		} // Determine if there's an active state with controllers
		const now = Date.now();
		const liveControllers = this.getLiveControllerIds(airport);
		const hasActiveControllers = liveControllers.length > 0;

		let stateObjects;
		let isOffline = false;

		if (clientType === 'controller' || hasActiveControllers) {
			stateObjects = await this.getOnlineStateObjects(airport, state);
			isOffline = false;
		} else {
			// For pilots when no controllers are online, get offline state
			stateObjects = await this.getOfflineStateFromPoints(airport);
			isOffline = true;
		}
		const initialState: Packet = {
			type: 'INITIAL_STATE',
			airport,
			data: {
				objects: stateObjects,
				connectionType: clientType,
				controllerId: clientType === 'controller' ? user.vatsim_id : undefined,
				controllers: liveControllers,
				offline: isOffline,
				sharedState: this.getSharedStateSnapshot(airport), // Add shared state to initial state
			},
			timestamp: now,
		};

		if (!this.sendPacket(server, initialState, 'initial_state')) {
			await this.cleanupSocket(server, 'initial_state_send_failed');
			server.close(1011, 'Unable to send initial state');
			return new Response(null, { status: 101, webSocket: client });
		}

		server.addEventListener('message', (event) => {
			const receivedAt = Date.now();
			this.state.waitUntil(
				this.enqueueSocketTask(server, async () => {
					const socketInfo = this.sockets.get(server);
					if (!socketInfo) {
						console.warn('Received message from unregistered socket');
						return;
					}

					try {
						// Parse and validate message data
						let rawData: string;
						let rawBytes: number;
						if (isStringValue(event.data)) {
							rawData = event.data;
							rawBytes = PACKET_ENCODER.encode(rawData).byteLength;
						} else {
							if (event.data.byteLength > MAX_MESSAGE_SIZE) {
								throw new Error(`Message size exceeds maximum allowed size of ${MAX_MESSAGE_SIZE} characters`);
							}
							try {
								rawData = PACKET_DECODER.decode(event.data);
								rawBytes = event.data.byteLength;
							} catch {
								throw new Error('Failed to decode message data');
							}
						}

						// Validate message size
						if (rawData.length > MAX_MESSAGE_SIZE) {
							throw new Error(`Message size exceeds maximum allowed size of ${MAX_MESSAGE_SIZE} characters`);
						}

						// Parse JSON with error handling
						let parsedPacket: StructuredValue;
						try {
							parsedPacket = JSON.parse(rawData);
						} catch {
							throw new Error('Invalid JSON format');
						}

						// Validate packet structure
						const validationFailure = this.getPacketValidationFailure(parsedPacket);
						if (validationFailure) {
							const packetTypeValue = isStructuredObject(parsedPacket) ? parsedPacket.type : undefined;
							const packetType =
								isStringValue(packetTypeValue)
									? packetTypeValue.slice(0, MAX_REJECTED_PACKET_TYPE_LOG_CHARACTERS)
									: undefined;
							console.warn({
								level: 'warn',
								subsystem: 'websocket',
								event: 'packet_rejected',
								timestamp: new Date().toISOString(),
								durableObjectId: this.objectId,
								...this.getSocketDebugDetails(server, socketInfo),
								direction: 'inbound',
								validationFailure,
								packetType,
								packetTypeKind: getStructuredValueKind(packetTypeValue),
								packetTypeLogTruncated:
									isStringValue(packetTypeValue) && packetTypeValue.length > MAX_REJECTED_PACKET_TYPE_LOG_CHARACTERS,
								bytes: rawBytes,
								characters: rawData.length,
								queuedForMs: Date.now() - receivedAt,
								...describeRejectedPacketForLog(parsedPacket),
							});
							throw new Error('Invalid packet structure or type');
						}
						// The same JSON text was validated above before it is decoded into the domain packet contract.
						const packet: Packet = JSON.parse(rawData);

						const now = Date.now();
						socketInfo.receivedPackets++;
						socketInfo.receivedBytes += rawBytes;
						socketInfo.lastMessageAt = now;
						// Update last heartbeat time for any message received
						socketInfo.lastHeartbeat = now;
						this.debugLog('packet_received', {
							...this.getSocketDebugDetails(server, socketInfo),
							direction: 'inbound',
							sequence: socketInfo.receivedPackets,
							bytes: rawBytes,
							characters: rawData.length,
							queuedForMs: now - receivedAt,
							packetType: packet.type,
							packet: parsedPacket,
						});

						// Update object status on each message to keep last_updated current (non-fatal on failure)
						this.touchActiveObjectStatus();
						const statusCheck = this.checkSocketStatus(server, socketInfo, now);
						if (statusCheck) this.state.waitUntil(statusCheck);

						const packetAirport = this.resolvePacketAirport(packet, socketInfo.airport);
						switch (packet.type) {
							case 'HEARTBEAT':
								// Respond to heartbeat with acknowledgment, adding server timestamp
								this.sendPacket(server, {
									type: 'HEARTBEAT_ACK',
									timestamp: now,
								});
								break;

							case 'HEARTBEAT_ACK':
								// Accept acknowledgments from clients that respond to server heartbeats.
								break;

							case 'STOPBAR_CROSSING': {
								// Only pilots can send this packet; observers and controllers shouldn't
								if (clientType !== 'pilot') {
									throw new Error('Only pilot clients can send STOPBAR_CROSSING');
								}

								const airport = socketInfo.airport;
								if (!packet.data || !isStructuredObject(packet.data)) {
									throw new Error('Invalid payload for STOPBAR_CROSSING');
								}
								const objectId = packet.data.objectId;
								if (!isStringValue(objectId)) {
									throw new Error('objectId is required');
								}

								// Prepare broadcast packet to controllers only
								const broadcastPacket: Packet = {
									type: 'STOPBAR_CROSSING',
									airport,
									data: {
										objectId,
										controllerId: user.vatsim_id,
									},
									timestamp: now,
								};

								const recipients = this.broadcastToControllers(broadcastPacket, server, false);
								this.trackMessage(
									{
										clientType,
										messageType: 'STOPBAR_CROSSING',
										airport,
										meta: {
											objectId,
										},
									},
									recipients,
								);
								break;
							}

							case 'GET_STATE': {
								// Provide current state snapshot (controllers + pilots can request; observers too)
								const airport = packetAirport;
								const state = this.airportStates.get(airport);
								let offline = false;
								let objects: AirportObject[] = [];

								// Determine if controllers currently connected for this airport
								const hasControllers = this.hasLiveControllers(airport);

								if (state && hasControllers) {
									// If any controller currently connected, treat state as online regardless of recency
									objects = await this.getOnlineStateObjects(airport, state);
								} else {
									offline = true;
									objects = await this.getOfflineStateFromPoints(airport);
								}

								const snapshot: Packet = {
									type: 'STATE_SNAPSHOT',
									airport,
									data: {
										objects,
										sharedState: this.getSharedStateSnapshot(airport),
										controllers: this.getLiveControllerIds(airport),
										offline,
									requestedAt: packet.timestamp || now,
									},
									timestamp: Date.now(),
								};
								this.sendPacket(server, snapshot, 'state_snapshot');
								break;
							}

							case 'GET_ONLINE_PILOTS': {
								this.sendPacket(
									server,
									this.createOnlinePilotsPacket(packetAirport, packet.timestamp ?? now, now),
									'online_pilots',
								);
								break;
							}

							case 'MULTI_STATE_UPDATE':
								if (clientType === 'pilot') {
									throw new Error('Pilots cannot send state updates');
								}
								if (clientType === 'observer') {
									throw new Error('Observers cannot send state updates');
								}

								try {
									const { updates, senderUpdates, timestamp, airport } = await this.handleMultiStateUpdate(
										packet,
										user.vatsim_id,
										packetAirport,
									);
									let recipients = this.broadcastStateUpdates(updates, airport, timestamp, server);
									if (this.sendStateUpdatesToSocket(server, senderUpdates, airport, timestamp)) recipients += 1;
									this.trackMessage(
										{
											clientType,
											messageType: 'MULTI_STATE_UPDATE',
											airport: socketInfo.airport,
											meta: { count: updates.length },
										},
										recipients,
									);
								} catch (updateError) {
									throw new Error(
										`State batch update failed: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
									);
								}
								break;

							case 'STATE_UPDATE':
								if (clientType === 'pilot') {
									throw new Error('Pilots cannot send state updates');
								}
								if (clientType === 'observer') {
									throw new Error('Observers cannot send state updates');
								}

								try {
									const { updates, senderUpdates, timestamp, airport } = await this.handleStateUpdate(
										packet,
										user.vatsim_id,
										packetAirport,
									);
									let recipients = this.broadcastStateUpdates(updates, airport, timestamp, server);
									if (this.sendStateUpdatesToSocket(server, senderUpdates, airport, timestamp)) recipients += 1;
									const data = isStructuredObject(packet.data) ? packet.data : {};
									const patchValue = data.patch;
									const meta: AnalyticsProperties = {
										objectId: isStringValue(data.objectId) ? data.objectId : undefined,
										updateMode: patchValue !== undefined ? 'patch' : 'state',
									};
									if (isStructuredObject(patchValue)) {
										meta.patchKeys = Object.keys(patchValue).length;
									}
									this.trackMessage(
										{
											clientType,
											messageType: updates.length === 1 ? 'STATE_UPDATE' : 'MULTI_STATE_UPDATE',
											airport: socketInfo.airport,
											meta: { ...meta, equivalentObjectCount: updates.length },
										},
										recipients,
									);
								} catch (updateError) {
									throw new Error(
										`State update failed: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
									);
								}
								break;

							case 'CLOSE': {
								// Handle graceful disconnection
								await this.cleanupSocket(server, 'client_close', {
									clean: true,
									details: {
										code: 1000,
										reason: 'Client requested disconnection',
										initiatedBy: 'client_packet',
									},
								});
								server.close(1000, 'Client requested disconnection');
								break;
							}

							case 'SHARED_STATE_UPDATE':
								// Handle shared state updates
								if (clientType === 'pilot' || clientType === 'observer') {
									throw new Error('Only controllers can send shared state updates');
								}

								try {
									await this.handleSharedStateUpdate(packet, user.vatsim_id, packetAirport);
								} catch (updateError) {
									throw new Error(
										`Shared state update failed: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
									);
								}
								break;

							default:
								// Reject unknown packet types
								throw new Error(`Unknown packet type: ${packet.type}`);
						}
						this.debugLog('packet_handled', {
							...this.getSocketDebugDetails(server, socketInfo),
							direction: 'inbound',
							sequence: socketInfo.receivedPackets,
							packetType: packet.type,
							processingMs: Date.now() - now,
							totalLatencyMs: Date.now() - receivedAt,
						});
					} catch (err) {
						const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
						console.error(`Message handling error for ${socketInfo.controllerId}:`, errorMessage);
						this.debugLog('packet_handling_failed', {
							...this.getSocketDebugDetails(server, socketInfo),
							direction: 'inbound',
							queuedForMs: Date.now() - receivedAt,
							error: describeErrorForLog(err),
						});

						// Send error response to client
						if (
							!this.sendPacket(server, {
								type: 'ERROR',
								data: { message: errorMessage },
								timestamp: Date.now(),
							})
						) {
							server.close(1011, 'Internal error - unable to communicate');
						}
					}
				}),
			);
		});

		server.addEventListener('close', (event) => {
			const termination = this.socketTerminations.get(server);
			const socketInfo = this.sockets.get(server) ?? termination?.info;
			this.debugLog('socket_close_event', {
				...this.getSocketDebugDetails(server, socketInfo),
				code: event.code,
				reason: event.reason,
				wasClean: event.wasClean,
			});
			this.state.waitUntil(
				this.handleSocketTermination(server, 'close_event', {
					clean: event.wasClean,
					details: {
						code: event.code,
						reason: event.reason,
						wasClean: event.wasClean,
					},
				}),
			);
		});

		server.addEventListener('error', (event) => {
			const termination = this.socketTerminations.get(server);
			const socketInfo = this.sockets.get(server);
			const errorDetails = describeWebSocketErrorEvent(event, server, socketInfo ?? termination?.info);
			if (termination || !socketInfo) {
				this.debugLog('socket_error_after_termination_ignored', {
					...this.getSocketDebugDetails(server, termination?.info),
					originalReason: termination?.reason,
					terminationCompleted: termination?.completedAt !== undefined,
					error: errorDetails,
				});
				return;
			}
			console.error('WebSocket error:', errorDetails);
			this.debugLog('socket_error_event', {
				...this.getSocketDebugDetails(server, socketInfo),
				error: errorDetails,
			});
			this.state.waitUntil(
				this.handleSocketTermination(server, 'socket_error', {
					details: { error: errorDetails },
				}),
			);
		});

		return new Response(null, { status: 101, webSocket: client });
	}

	private enqueueSocketTask(socket: WebSocket, task: () => Promise<void>): Promise<void> {
		const previous = this.socketQueues.get(socket) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(async () => {
				if (!this.sockets.has(socket)) return;
				await task();
			})
			.catch((error) => {
				console.error('Queued socket task failed:', error instanceof Error ? error.message : error);
				this.debugLog('socket_queue_task_failed', {
					...this.getSocketDebugDetails(socket),
					error: describeErrorForLog(error),
				});
			})
			.finally(() => {
				if (this.socketQueues.get(socket) === next) {
					this.socketQueues.delete(socket);
				}
			});

		this.socketQueues.set(socket, next);
		return next;
	}

	private sendPacket(socket: WebSocket, packet: Packet, context = 'send'): boolean {
		try {
			return this.sendSerializedPacket(socket, JSON.stringify(packet), context);
		} catch (error) {
			this.handleSendFailure(socket, context, error);
			return false;
		}
	}

	private sendSerializedPacket(socket: WebSocket, packetString: string, context: string): boolean {
		if (socket.readyState !== WebSocket.OPEN) {
			this.debugLog('packet_send_skipped_socket_not_open', {
				...this.getSocketDebugDetails(socket),
				direction: 'outbound',
				context,
				bytes: PACKET_ENCODER.encode(packetString).byteLength,
			});
			return false;
		}
		try {
			socket.send(packetString);
			const info = this.sockets.get(socket);
			if (info) {
				info.sendFailures = 0;
				info.sentPackets++;
				const bytes = PACKET_ENCODER.encode(packetString).byteLength;
				info.sentBytes += bytes;
				let packet: StructuredValue = packetString;
				if (this.debugEnabled) {
					try {
						packet = JSON.parse(packetString);
					} catch {
						// Keep the serialized value for diagnostics if a non-JSON frame is ever sent.
					}
				}
				this.debugLog('packet_sent', {
					...this.getSocketDebugDetails(socket, info),
					direction: 'outbound',
					context,
					sequence: info.sentPackets,
					bytes,
					characters: packetString.length,
					packetType: isStructuredObject(packet) ? packet.type : undefined,
					packet,
				});
			}
			return true;
		} catch (error) {
			this.handleSendFailure(socket, context, error);
			return false;
		}
	}

	private handleSendFailure(socket: WebSocket, context: string, cause: unknown) {
		const info = this.sockets.get(socket);
		console.error(`Failed to send WebSocket packet during ${context}:`, cause);
		this.debugLog('packet_send_failed', {
			...this.getSocketDebugDetails(socket, info),
			direction: 'outbound',
			context,
			error: describeErrorForLog(cause),
		});
		if (!info) return;

		info.sendFailures++;
		if (info.sendFailures >= SEND_FAILURE_LIMIT) {
			socket.close(1011, 'Repeated send failures');
			this.state.waitUntil(this.cleanupSocket(socket, 'send_failure'));
		}
	}

	private async cleanupSocket(socket: WebSocket, reason: string, options: SocketTerminationOptions = {}) {
		await this.terminateSocket(socket, reason, options);
	}

	private async handleSocketTermination(
		socket: WebSocket,
		reason: 'close_event' | 'socket_error',
		options: SocketTerminationOptions = {},
	) {
		await this.terminateSocket(socket, reason, options);
	}

	private async terminateSocket(socket: WebSocket, reason: string, options: SocketTerminationOptions = {}) {
		const existing = this.socketTerminations.get(socket);
		if (existing) {
			existing.clean ||= options.clean ?? false;
			existing.details = { ...existing.details, ...options.details };
			this.debugLog(
				existing.completedAt === undefined ? 'socket_termination_already_in_progress' : 'socket_termination_already_handled',
				{
					...this.getSocketDebugDetails(socket, existing.info),
					originalReason: existing.reason,
					repeatedReason: reason,
					clean: existing.clean,
					...existing.details,
				},
			);
			if (existing.task) await existing.task;
			return;
		}

		const info = this.sockets.get(socket);
		if (!info) {
			this.debugLog('socket_termination_ignored_unregistered', {
				...this.getSocketDebugDetails(socket),
				reason,
				clean: options.clean ?? false,
				...options.details,
			});
			return;
		}

		const record: SocketTerminationRecord = {
			info,
			reason,
			details: options.details ?? {},
			clean: options.clean ?? false,
			startedAt: Date.now(),
		};
		this.socketTerminations.set(socket, record);
		record.task = this.performSocketTermination(socket, record);
		await record.task;
	}

	private async performSocketTermination(socket: WebSocket, record: SocketTerminationRecord) {
		const { info } = record;
		this.debugLog('socket_termination_started', {
			...this.getSocketDebugDetails(socket, info),
			reason: record.reason,
			clean: record.clean,
			...record.details,
		});

		if (info.type === 'controller') {
			try {
				await this.handleControllerDisconnect(socket);
			} catch (error) {
				console.warn('handleControllerDisconnect failed during socket termination (non-fatal):', error);
				this.debugLog('controller_disconnect_cleanup_failed', {
					...this.getSocketDebugDetails(socket, info),
					reason: record.reason,
					error: describeErrorForLog(error),
				});
			}
		}

		const removed = this.unregisterSocket(socket);
		if (removed) {
			try {
				await this.trackDisconnection(removed, record.reason);
			} catch (error) {
				console.warn('trackDisconnection failed during socket termination (non-fatal):', error);
				this.debugLog('disconnection_tracking_failed', {
					...this.getSocketDebugDetails(socket, removed),
					reason: record.reason,
					error: describeErrorForLog(error),
				});
			}
		}

		record.completedAt = Date.now();
		this.debugLog('socket_termination_completed', {
			...this.getSocketDebugDetails(socket, info),
			reason: record.reason,
			clean: record.clean,
			...record.details,
			durationMs: record.completedAt - record.startedAt,
			socketCount: this.sockets.size,
		});
	}

	private touchActiveObjectStatus() {
		if (this.activeObjectTouchInFlight) return;
		const now = Date.now();
		if (now - this.lastActiveObjectsUpdate < ACTIVE_OBJECT_TOUCH_INTERVAL_MS) return;

		this.activeObjectTouchInFlight = true;
		this.state.waitUntil(
			this.updateObjectStatus().finally(() => {
				this.activeObjectTouchInFlight = false;
			}),
		);
	}

	private trackBroadcast(messageType: Packet['type'], airport: string, recipients: number) {
		if (recipients === 0) return;
		this.emitAnalytics('ws_broadcast', {
			airport,
			messageType,
			recipients,
			socket_count: this.sockets.size,
		});
	}

	private async trackConnection(clientType: ClientType, airport: string) {
		// Add this object to active_objects table when first connection is made
		if (this.sockets.size === 1) {
			const session = DatabaseContextFactory.createSessionService(this.env.DB);
			try {
				await session.executeWrite(
					"INSERT OR REPLACE INTO active_objects (id, name, last_updated) VALUES (?, ?, datetime('now'))",
					[this.objectId, this.getObjectName()],
				);
			} catch (e) {
				console.warn('Failed to upsert active_objects on connect (non-fatal):', e instanceof Error ? e.message : e);
			} finally {
				session.closeSession();
			}
		}

		this.emitAnalytics('ws_connection_opened', {
			airport,
			clientType,
			socket_count: this.sockets.size,
			object_id: this.objectId,
			controllers_online: this.connectionCounts.controllers,
			pilots_online: this.connectionCounts.pilots,
			observers_online: this.connectionCounts.observers,
		});
	}

	private async trackDisconnection(info: { controllerId: string; type: ClientType; airport: string }, reason?: string) {
		// If no more connections, remove from active_objects
		if (this.sockets.size === 0) {
			const session = DatabaseContextFactory.createSessionService(this.env.DB);
			try {
				await session.executeWrite('DELETE FROM active_objects WHERE id = ?', [this.objectId]);
			} catch (e) {
				console.warn('Failed to delete active_objects on disconnect (non-fatal):', e instanceof Error ? e.message : e);
			} finally {
				session.closeSession();
			}
		}

		this.emitAnalytics('ws_connection_closed', {
			airport: info.airport,
			clientType: info.type,
			reason: reason || 'unspecified',
			socket_count: this.sockets.size,
			object_id: this.objectId,
			controllers_online: this.connectionCounts.controllers,
			pilots_online: this.connectionCounts.pilots,
			observers_online: this.connectionCounts.observers,
		});
	}
	private getObjectName(): string {
		// Create a descriptive name with format: airport/controllerCount/pilotCount/observerCount
		const airport = this.lastKnownAirport;
		const counts = this.connectionCounts;
		return `${airport}/${counts.controllers}/${counts.pilots}/${counts.observers}`;
	}

	private async updateObjectStatus() {
		if (this.sockets.size > 0) {
			// Throttle updates to avoid excessive D1 writes
			const now = Date.now();
			if (now - this.lastActiveObjectsUpdate < ACTIVE_OBJECT_TOUCH_INTERVAL_MS) return;

			// Update the object's name and last_updated timestamp
			const name = this.getObjectName();
			const session = DatabaseContextFactory.createSessionService(this.env.DB);
			try {
				await session.executeWrite("UPDATE active_objects SET name = ?, last_updated = datetime('now') WHERE id = ?", [
					name,
					this.objectId,
				]);
				this.lastActiveObjectsUpdate = now;
			} catch (e) {
				console.warn('Failed to update active_objects name (non-fatal):', e instanceof Error ? e.message : e);
			} finally {
				session.closeSession();
			}
		}
	}

	private trackMessage(
		details: {
			clientType: ClientType;
			messageType: Packet['type'];
			airport: string;
			meta?: StructuredObject;
		},
		broadcastRecipients = 0,
	) {
		const props = {
			airport: details.airport,
			clientType: details.clientType,
			messageType: details.messageType,
			socket_count: this.sockets.size,
			...details.meta,
		};
		if (broadcastRecipients > 0) {
			this.emitAnalyticsBatch([
				{
					event: 'ws_broadcast',
					properties: {
						airport: details.airport,
						messageType: details.messageType,
						recipients: broadcastRecipients,
						socket_count: this.sockets.size,
					},
				},
				{ event: 'ws_message', properties: props },
			]);
			return;
		}
		this.emitAnalytics('ws_message', props);
	}

	async getState(airport: string, forceOffline = false): Promise<ConnectionStateSnapshot> {
		if (forceOffline) {
			return { airport, objects: await this.getOfflineStateFromPoints(airport), offline: true };
		}

		const controllers = this.getLiveControllerIds(airport);
		const pilots = this.getLivePilotIds(airport);

		const state = this.airportStates.get(airport);
		const online = Boolean(state && this.hasLiveControllers(airport));
		const objects = online ? await this.getOnlineStateObjects(airport, state!) : await this.getOfflineStateFromPoints(airport);

		return { airport, controllers, pilots, objects, offline: !online };
	}

	async fetch(request: Request) {
		if (request.headers.get('X-Request-Type') === 'get_state') {
			const url = new URL(request.url);
			const airport = url.searchParams.get('airport');
			if (!airport) {
				return Response.json({ error: 'Airport parameter required' }, { status: 400 });
			}
			return Response.json(await this.getState(airport, url.searchParams.get('offline') === 'true'), {
				headers: { 'Access-Control-Allow-Origin': '*' },
			});
		}

		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocket(request);
		}
		return new Response('Expected WebSocket', { status: 400 });
	}

	private broadcastToControllers(packet: Packet, sender?: WebSocket, trackAnalytics = true): number {
		const airport = packet.airport;
		if (!airport) return 0;
		const airportControllers = this.controllerSockets.get(airport);
		if (!airportControllers) return 0;

		let packetString: string;
		try {
			packetString = JSON.stringify(packet);
		} catch (error) {
			console.error('Failed to serialize controller broadcast packet:', error);
			return 0;
		}
		let recipients = 0;

		for (const controllerSocketSet of airportControllers.values()) {
			for (const socket of controllerSocketSet) {
				if (socket !== sender && socket.readyState === WebSocket.OPEN) {
					recipients++;
					this.sendSerializedPacket(socket, packetString, 'controller_broadcast');
				}
			}
		}

		if (trackAnalytics) this.trackBroadcast(packet.type, airport, recipients);
		return recipients;
	}

	private getOrCreateSharedState(airport: string): StructuredObject {
		let sharedState = this.airportSharedStates.get(airport);
		if (!sharedState) {
			sharedState = {}; // Initialize as empty object as per requirements
			this.airportSharedStates.set(airport, sharedState);
		}
		return sharedState;
	}
	private async handleSharedStateUpdate(packet: Packet, controllerId: string, connectionAirport: string) {
		try {
			// Validate required fields
			if (!packet?.data || !isStructuredObject(packet.data)) {
				throw new Error('Invalid packet data structure');
			}

			if (
				!packet.data.sharedStatePatch ||
				!isStructuredObject(packet.data.sharedStatePatch)
			) {
				throw new Error('Missing or invalid sharedStatePatch');
			}

			// Validate airport parameter
			const airport = this.resolvePacketAirport(packet, connectionAirport);
			if (!airport || airport.length === 0) {
				throw new Error('Invalid airport identifier');
			}

			const patch = packet.data.sharedStatePatch;
			const patchKeyCount = Object.keys(patch).length;
			let patchSize = 0;
			let serializedPatch = '';

			// Validate patch structure and size
			try {
				serializedPatch = JSON.stringify(patch);
				patchSize = serializedPatch.length;
				if (patchSize > MAX_SHARED_PATCH_SIZE) {
					throw new Error(`Patch size exceeds maximum allowed size of ${MAX_SHARED_PATCH_SIZE} characters`);
				}
			} catch {
				throw new Error('Patch data is not serializable');
			}

			// Get current shared state
			const currentState = this.getOrCreateSharedState(airport);

			// Apply recursive merge with error handling
			const updatedState = recursivelyMergeObjects(currentState, patch);

			// Update the stored state
			if (!isStructuredObject(updatedState)) {
				throw new Error('Shared-state merge did not produce an object');
			}
			this.airportSharedStates.set(airport, updatedState);

			this.markSharedStateDirty(airport);

			// Broadcast to all clients (including sender)
			const recipients = this.broadcastSharedState(airport, serializedPatch, controllerId);

			this.trackMessage(
				{
					clientType: 'controller',
					messageType: 'SHARED_STATE_UPDATE',
					airport,
					meta: {
						patchKeys: patchKeyCount,
						patchSize,
					},
				},
				recipients,
			);

			return updatedState;
		} catch (error) {
			console.error(`Shared state update error for controller ${controllerId}:`, error);
			throw error; // Re-throw to be handled by caller
		}
	}

	private broadcastSharedState(airport: string, serializedPatch: string, controllerId: string): number {
		const packetString = `{"type":"SHARED_STATE_UPDATE","airport":${JSON.stringify(airport)},"data":{"sharedStatePatch":${serializedPatch},"controllerId":${JSON.stringify(controllerId)}},"timestamp":${Date.now()}}`;

		let recipients = 0;
		for (const [socket, client] of this.sockets) {
			if (socket.readyState === WebSocket.OPEN && client.airport === airport) {
				recipients++;
				this.sendSerializedPacket(socket, packetString, 'shared_state_broadcast');
			}
		}

		return recipients;
	}

	private getSharedStateSnapshot(airport: string): StructuredObject {
		return this.getOrCreateSharedState(airport);
	}

	private getPacketValidationFailure(packet: StructuredValue): string | null {
		// Basic structure validation
		if (!isStructuredObject(packet)) {
			return 'packet_not_object';
		}

		const type = packet.type;
		// Required type field
		if (!isStringValue(type)) {
			return 'missing_or_non_string_type';
		}

		if (!isSupportedPacketType(type)) {
			return 'unsupported_type';
		}

		// Optional airport field validation
		const airport = packet.airport;
		if (airport !== undefined && (!isStringValue(airport) || airport.length === 0)) {
			return 'invalid_airport';
		}

		// Optional timestamp validation
		const timestamp = packet.timestamp;
		if (timestamp !== undefined && (!isNumberValue(timestamp) || timestamp < 0)) {
			return 'invalid_timestamp';
		}

		// The raw message length and JSON parse are checked before this method.
		switch (type) {
			case 'STATE_UPDATE':
				return this.validateStateUpdatePacket(packet) ? null : 'invalid_state_update_payload';
			case 'MULTI_STATE_UPDATE':
				return this.validateMultiStateUpdatePacket(packet) ? null : 'invalid_multi_state_update_payload';
			case 'SHARED_STATE_UPDATE':
				return this.validateSharedStateUpdatePacket(packet) ? null : 'invalid_shared_state_update_payload';
			case 'STOPBAR_CROSSING':
				return this.validateStopbarCrossingPacket(packet) ? null : 'invalid_stopbar_crossing_payload';
			default:
				return null; // Other types are valid if they pass basic checks
		}
	}

	private validateStateUpdatePacket(packet: StructuredValue): boolean {
		return isStructuredObject(packet) && this.parseStateUpdate(packet.data) !== null;
	}

	private validateMultiStateUpdatePacket(packet: StructuredValue): boolean {
		if (!isStructuredObject(packet)) return false;
		const updates = this.parseMultiStateUpdates(packet.data);

		if (!updates || updates.length === 0) {
			return false;
		}

		if (updates.length > MAX_MULTI_STATE_UPDATES) {
			return false;
		}

		return true;
	}

	private validateSharedStateUpdatePacket(packet: StructuredValue): boolean {
		if (!isStructuredObject(packet) || !isStructuredObject(packet.data)) return false;
		// Must have sharedStatePatch
		if (!isStructuredObject(packet.data.sharedStatePatch)) {
			return false;
		}

		if (!isSafeNestedValue(packet.data.sharedStatePatch)) return false;
		return true;
	}

	private validateStopbarCrossingPacket(packet: StructuredValue): boolean {
		if (!isStructuredObject(packet) || !isStructuredObject(packet.data)) return false;
		// Must have objectId
		if (!isStringValue(packet.data.objectId) || !OBJECT_ID_REGEX.test(packet.data.objectId)) {
			return false;
		}

		return true;
	}

	private parseStateUpdate(data: RuntimeCandidate): MultiStateUpdateItem | null {
		if (!isStructuredObject(data)) return null;

		const objectId = data.objectId;
		if (!isStringValue(objectId) || !OBJECT_ID_REGEX.test(objectId)) return null;

		const hasPatch = data.patch !== undefined;
		const hasState = data.state !== undefined;
		if (!hasPatch && !hasState) return null;

		const parsed: MultiStateUpdateItem = { objectId };
		if (hasPatch) {
			const patch = data.patch;
			if (patch !== null && !isStructuredObject(patch)) return null;
			if (!isSafeNestedValue(patch)) return null;
			parsed.patch = patch;
		}

		if (hasState) {
			const state = data.state;
			if (!isBooleanValue(state) && !isStructuredObject(state)) return null;
			if (!isSafeNestedValue(state)) return null;
			parsed.state = state;
		}

		return parsed;
	}

	// Parses updates from either the legacy bare array payload or an object with `updates`.
	private parseMultiStateUpdates(data: RuntimeCandidate): MultiStateUpdateItem[] | null {
		const embeddedUpdates = isStructuredObject(data) && 'updates' in data ? data.updates : undefined;
		const rawUpdates = Array.isArray(data) ? data : Array.isArray(embeddedUpdates) ? embeddedUpdates : null;
		if (!rawUpdates) return null;

		const updates: MultiStateUpdateItem[] = [];
		for (const rawUpdate of rawUpdates) {
			const update = this.parseStateUpdate(rawUpdate);
			if (!update) return null;
			updates.push(update);
		}
		return updates;
	}
}
