import { ClientType, Packet, AirportState, AirportObject, MultiStateUpdateItem, HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT, OnlinePilot } from '../types';
import { AuthService } from '../services/auth';
import { VatsimService } from '../services/vatsim';
import { PointsService } from '../services/points';
import { IDService } from '../services/id';
import { DivisionService } from '../services/divisions';
import { DatabaseContextFactory } from '../services/database-context';
import { PostHogService } from '../services/posthog';

const MAX_STATE_SIZE = 1000000; // 1MB limit for persisted payloads
const MAX_MESSAGE_SIZE = 50000;
const MAX_SHARED_PATCH_SIZE = 10240;
const MAX_MULTI_STATE_UPDATES = 200;
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
const SERIALIZED_HEARTBEAT = JSON.stringify({ type: 'HEARTBEAT' });
const VALID_PACKET_TYPES = new Set<Packet['type']>([
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
const createNullObject = (): Record<string, unknown> => Object.create(null) as Record<string, unknown>;
const isDisallowedKey = (key: string): boolean => key === '__proto__' || key === 'constructor' || key === 'prototype';

type SocketInfo = {
	controllerId: string;
	callsign: string;
	type: ClientType;
	airport: string;
	lastHeartbeat: number;
	lastStatusCheck: number;
	statusCheckInFlight: boolean;
	consecutiveVatsimFailures: number;
	sendFailures: number;
};

type OfflineStateTemplate = Array<{ id: string; state: boolean }>;

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

function isSafeNestedValue(value: unknown, maxDepth = 20, maxProperties = 100): boolean {
	const seen = new WeakSet<object>();
	const walk = (current: unknown, depth: number): boolean => {
		if (current === null || typeof current !== 'object') return true;
		if (depth > maxDepth || seen.has(current)) return false;
		seen.add(current);
		if (Array.isArray(current)) {
			return current.length <= 1000 && current.every((item) => walk(item, depth + 1));
		}
		const record = current as Record<string, unknown>;
		const keys = Object.keys(record);
		return (
			keys.length <= maxProperties &&
			keys.every((key) => key.length <= 100 && !isDisallowedKey(key) && walk(record[key], depth + 1))
		);
	};
	return walk(value, 0);
}

function describeErrorForLog(error: unknown): Record<string, unknown> | string {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}

	if (error === null || error === undefined) {
		return String(error);
	}

	if (typeof error === 'object') {
		try {
			return JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
		} catch {
			return Object.prototype.toString.call(error);
		}
	}

	return String(error);
}

function describeWebSocketErrorEvent(
	evt: ErrorEvent,
	socket: WebSocket,
	socketInfo?: { controllerId: string; type: ClientType; airport: string },
): Record<string, unknown> {
	const details: Record<string, unknown> = {
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
function recursivelyMergeObjects(target: unknown, source: unknown, depth = 0): unknown {
	// Prevent infinite recursion and overly deep nesting
	const MAX_DEPTH = 20;
	if (depth > MAX_DEPTH) {
		throw new Error('Maximum recursion depth exceeded in merge operation');
	}

	if (source === null || typeof source !== 'object') {
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

	// Handle objects - lazily clone properties when needed
	const MAX_PROPERTIES = 100;
	const sourceKeys = Object.keys(source);
	if (sourceKeys.length > MAX_PROPERTIES) {
		throw new Error(`Object has too many properties (${sourceKeys.length} > ${MAX_PROPERTIES})`);
	}

	const targetIsObject = target !== null && typeof target === 'object' && !Array.isArray(target);
	const targetRecord = targetIsObject ? (target as Record<string, unknown>) : undefined;
	let result: Record<string, unknown>;
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
		if (typeof key !== 'string' || key.length > 100) {
			throw new Error('Invalid property key');
		}

		if (isDisallowedKey(key)) {
			throw new Error('Prototype pollution key rejected');
		}

		const sv = (source as Record<string, unknown>)[key];
		const rv = targetRecord ? targetRecord[key] : undefined;

		if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
			if (rv && typeof rv === 'object' && !Array.isArray(rv)) {
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
	private airportSharedStates = new Map<string, Record<string, unknown>>(); // New shared state storage
	private objectId: string; // Store the DO's ID
	private lastActiveObjectsUpdate = 0; // Throttle D1 updates
	private activeObjectTouchInFlight = false;
	private airportStateFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private airportSharedStateFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private dirtyAirportStates = new Set<string>();
	private dirtySharedStates = new Set<string>();
	private socketQueues = new Map<WebSocket, Promise<void>>();
	private controllerSockets = new Map<string, Map<string, Set<WebSocket>>>();
	private pilotConnectionCounts = new Map<string, Map<string, { count: number; callsign: string }>>();
	private pendingConnectionStatusChecks = new Map<string, Promise<ConnectionStatus>>();
	private offlineStateCache = new Map<
		string,
		{
			template?: OfflineStateTemplate;
			defaultStates?: ReadonlyMap<string, boolean>;
			expiresAt: number;
			inFlight?: Promise<OfflineStateTemplate>;
		}
	>();
	private connectionCounts: Record<'controllers' | 'pilots' | 'observers', number> = {
		controllers: 0,
		pilots: 0,
		observers: 0,
	};
	private posthog: PostHogService;
	private lastKnownAirport = 'unknown';

	constructor(
		private env: Env,
		private auth: AuthService,
		private vatsim: VatsimService,
		private state: DurableObjectState,
	) {
		this.objectId = state.id.toString();
		this.posthog = new PostHogService(env);
		this.state.blockConcurrencyWhile(async () => {
			await this.loadPersistedState();
		});
	}

	private registerSocket(socket: WebSocket, info: { controllerId: string; callsign?: string; type: ClientType; airport: string; lastHeartbeat: number }) {
		const socketInfo: SocketInfo = {
			...info,
			callsign: info.callsign ?? info.controllerId,
			lastStatusCheck: 0,
			statusCheckInFlight: false,
			consecutiveVatsimFailures: 0,
			sendFailures: 0,
		};
		this.sockets.set(socket, socketInfo);
		this.adjustConnectionCount(socketInfo.type, 1);
		this.lastKnownAirport = socketInfo.airport;
		if (socketInfo.type === 'controller') {
			this.addControllerSocket(socket, socketInfo);
		} else if (socketInfo.type === 'pilot') {
			this.adjustPilotConnectionCount(socketInfo.airport, socketInfo.controllerId, socketInfo.callsign, 1);
		}
	}

	private unregisterSocket(socket: WebSocket) {
		const info = this.sockets.get(socket);
		if (!info) {
			return undefined;
		}

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
		if (nextCount > 0) airportPilots.set(pilotId, { count: nextCount, callsign: delta > 0 ? callsign : (current?.callsign ?? callsign) });
		else airportPilots.delete(pilotId);
		if (airportPilots.size === 0) this.pilotConnectionCounts.delete(airport);
	}

	private getLivePilotIds(airport: string): string[] {
		const airportPilots = this.pilotConnectionCounts.get(airport);
		return airportPilots ? Array.from(airportPilots.keys()) : [];
	}

	private getLivePilots(airport: string): OnlinePilot[] {
		const airportPilots = this.pilotConnectionCounts.get(airport);
		return airportPilots
			? Array.from(airportPilots, ([cid, pilot]) => ({ cid, callsign: pilot.callsign }))
			: [];
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

	private emitAnalytics(event: string, properties: Record<string, unknown>) {
		const filtered = this.filterAnalyticsProperties(properties);
		try {
			this.posthog.track(event, filtered);
		} catch {
			// ignore analytics failures
		}
	}

	private filterAnalyticsProperties(properties: Record<string, unknown>): Record<string, unknown> {
		const filtered: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(properties)) {
			if (value !== undefined) {
				filtered[key] = value;
			}
		}
		return filtered;
	}

	private emitAnalyticsBatch(events: readonly { event: string; properties: Record<string, unknown> }[]) {
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

	private deserializeAirportState(airport: string, stored: unknown): AirportState {
		const airportState = (stored || {}) as {
			objects?: Record<string, { id: string; state: unknown; controllerId?: string; timestamp: number }>;
			lastUpdate?: number;
			controllers?: string[];
		};

		return {
			airport,
			objects: new Map(
				Object.entries(airportState.objects || {}).map(([id, obj]) => {
					const rawState = obj.state;
					let normalizedState: boolean | Record<string, unknown>;
					if (typeof rawState === 'boolean') {
						normalizedState = rawState;
					} else if (rawState && typeof rawState === 'object' && !Array.isArray(rawState)) {
						normalizedState = rawState as Record<string, unknown>;
					} else {
						normalizedState = {};
					}

					return [
						id,
						{
							id,
							state: normalizedState,
							controllerId: obj.controllerId,
							timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : Date.now(),
						},
					];
				}),
			),
			lastUpdate: typeof airportState.lastUpdate === 'number' ? airportState.lastUpdate : Date.now(),
			controllers: new Set(Array.isArray(airportState.controllers) ? airportState.controllers : []),
		};
	}

	private async loadPersistedState() {
		const states = new Map<string, AirportState>();
		const sharedStates = new Map<string, Record<string, unknown>>();

		try {
			const [stateEntries, sharedEntries] = await Promise.all([
				this.state.storage.list<unknown>({ prefix: 'airport_state:' }),
				this.state.storage.list<unknown>({ prefix: 'airport_shared_state:' }),
			]);

			for (const [key, stored] of stateEntries) {
				const airport = key.slice('airport_state:'.length);
				if (!airport) continue;
				states.set(airport, this.deserializeAirportState(airport, stored));
			}

			for (const [key, stored] of sharedEntries) {
				const airport = key.slice('airport_shared_state:'.length);
				if (!airport) continue;
				if (stored && typeof stored === 'object') {
					sharedStates.set(airport, stored as Record<string, unknown>);
				}
			}
			this.airportStates = states;
			this.airportSharedStates = sharedStates;
		} catch (error) {
			console.error('Failed to load persisted state:', error);
		}
	}

	private async persistAirportState(airport: string) {
		const state = this.airportStates.get(airport);
		const storageKey = `airport_state:${airport}`;

		if (!state) {
			try {
				await this.state.storage.delete(storageKey);
			} catch (error) {
				console.error(`Failed to delete airport state for ${airport}:`, error);
			}
			return;
		}

		const objects: Record<string, AirportObject> = createNullObject() as Record<string, AirportObject>;
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
			if (serializedString.length > MAX_STATE_SIZE) {
				console.warn(
					`State size (${serializedString.length}) exceeds maximum (${MAX_STATE_SIZE}), skipping persistence for ${airport}`,
				);
				return;
			}

			await this.state.storage.put(storageKey, serialized);
		} catch (error) {
			console.error(`Failed to persist airport state for ${airport}:`, error);
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
		this.dirtyAirportStates.delete(airport);
		await this.persistAirportState(airport);
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
		return recipients;
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
		update: Record<string, unknown>,
		controllerId: string,
		now: number,
	): MultiStateUpdateItem {
		if (!update || typeof update !== 'object') {
			throw new Error('Invalid update data structure');
		}

		const objectId = update['objectId'];
		if (!objectId || typeof objectId !== 'string') {
			throw new Error('Missing or invalid objectId');
		}

		if (!OBJECT_ID_REGEX.test(objectId)) {
			throw new Error('Invalid objectId format');
		}

		const hasPatch = Object.prototype.hasOwnProperty.call(update, 'patch');
		const hasState = Object.prototype.hasOwnProperty.call(update, 'state');

		if (!hasPatch && !hasState) {
			throw new Error(`Missing both patch and state data for object ${objectId}`);
		}

		let newState: boolean | Record<string, unknown> | null;
		let normalized: MultiStateUpdateItem = { objectId };

		const existingObject = state.objects.get(objectId) || {
			id: objectId,
			state: {},
			controllerId: controllerId,
			timestamp: now,
		};

		if (hasPatch) {
			const patch = (update as { patch?: unknown }).patch;
			if (patch === undefined) {
				throw new Error(`Missing patch data for object ${objectId}`);
			}
			if (patch !== null && (typeof patch !== 'object' || Array.isArray(patch))) {
				throw new Error(`Patch data must be an object or null for object ${objectId}`);
			}

			if (patch === null) {
				state.objects.delete(objectId);
				state.lastUpdate = now;
				return { objectId, patch: null };
			}

			const baseState = typeof existingObject.state === 'object' && existingObject.state !== null ? existingObject.state : {};
			const merged = recursivelyMergeObjects(baseState, patch as Record<string, unknown>);
			newState = merged as Record<string, unknown>;
			normalized = { objectId, patch: patch as Record<string, unknown> | null };
		} else {
			const stateValue = (update as { state?: unknown }).state;
			if (typeof stateValue === 'boolean') {
				newState = stateValue;
			} else if (stateValue && typeof stateValue === 'object' && !Array.isArray(stateValue)) {
				newState = stateValue as Record<string, unknown>;
			} else {
				throw new Error('State data must be boolean or object');
			}
			normalized = { objectId, state: newState };
		}

		state.objects.set(objectId, {
			id: objectId,
			state: newState as boolean | Record<string, unknown>,
			controllerId: controllerId,
			timestamp: now,
		});

		state.lastUpdate = now;

		return normalized;
	}

	private async handleStateUpdate(packet: Packet, controllerId: string, connectionAirport: string) {
		try {
			if (!packet?.data || typeof packet.data !== 'object' || Array.isArray(packet.data)) {
				throw new Error('Invalid packet data structure');
			}

			const airport = this.resolvePacketAirport(packet, connectionAirport);
			if (!airport || typeof airport !== 'string' || airport.length === 0) {
				throw new Error('Invalid airport identifier');
			}

			const defaultStates = await this.getOfflineDefaultStates(airport);
			const now = Date.now();
			const state = this.getOrCreateAirportState(airport);
			const normalized = this.applyStateUpdateToAirport(state, packet.data as Record<string, unknown>, controllerId, now);
			this.pruneDefaultStateOverride(state, normalized.objectId, defaultStates);

			this.markAirportStateDirty(airport);
			return now;
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
		if (!airport || typeof airport !== 'string' || airport.length === 0) {
			throw new Error('Invalid airport identifier');
		}

		const updatesPayload = this.extractMultiStateUpdates(packet.data);

		if (!updatesPayload || updatesPayload.length === 0) {
			throw new Error('Missing updates array');
		}

		if (updatesPayload.length > MAX_MULTI_STATE_UPDATES) {
			throw new Error(`Batch update exceeds maximum allowed size of ${MAX_MULTI_STATE_UPDATES}`);
		}

		const updates: MultiStateUpdateItem[] = updatesPayload;

		const defaultStates = await this.getOfflineDefaultStates(airport);
		const now = Date.now();
		const state = this.getOrCreateAirportState(airport);
		const normalizedUpdates: MultiStateUpdateItem[] = [];

		for (let index = 0; index < updates.length; index++) {
			const update = updates[index];
			try {
				const normalized = this.applyStateUpdateToAirport(state, update as Record<string, unknown>, controllerId, now);
				this.pruneDefaultStateOverride(state, normalized.objectId, defaultStates);
				normalizedUpdates.push(normalized);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Unknown error';
				throw new Error(`Update ${index + 1} failed: ${message}`);
			}
		}

		this.markAirportStateDirty(airport);

		return { updates: normalizedUpdates, timestamp: now, airport };
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
					socket.close(1011, 'Failed to send heartbeat');
					clearInterval(interval);
					return;
				}
			} catch (e) {
				console.error('Error in heartbeat:', e);
				socket.close(1011, 'Internal error in heartbeat');
				clearInterval(interval);
			}
		}, HEARTBEAT_INTERVAL);

		// Clean up interval on socket close
		socket.addEventListener('close', () => {
			clearInterval(interval);
		});

		// Add error handler
		socket.addEventListener('error', (evt) => {
			console.error('WebSocket error:', describeWebSocketErrorEvent(evt, socket, this.sockets.get(socket)));
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
		try {
			const connectionStatus = await this.getConnectionStatus(socketInfo.controllerId);
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
		const cached = this.offlineStateCache.get(normalizedAirport);
		const now = Date.now();
		if (cached?.template && cached.expiresAt > now) {
			return cached.template;
		}
		if (cached?.inFlight) {
			return await cached.inFlight;
		}

		const inFlight = this.loadOfflineStateTemplate(normalizedAirport);
		this.offlineStateCache.set(normalizedAirport, { expiresAt: now + OFFLINE_STATE_CACHE_TTL_MS, inFlight });
		try {
			const template = await inFlight;
			this.offlineStateCache.set(normalizedAirport, {
				template,
				defaultStates: new Map(template.map((point) => [point.id, point.state])),
				expiresAt: Date.now() + OFFLINE_STATE_CACHE_TTL_MS,
			});
			return template;
		} catch (error) {
			console.error(`Error fetching offline state for ${airport}:`, error);
			this.offlineStateCache.delete(normalizedAirport);
			return [];
		}
	}

	private async getOfflineDefaultStates(airport: string): Promise<ReadonlyMap<string, boolean>> {
		const normalizedAirport = airport.toUpperCase();
		const template = await this.getOfflineStateTemplate(normalizedAirport);
		const cached = this.offlineStateCache.get(normalizedAirport);
		if (cached?.template === template && cached.defaultStates) {
			return cached.defaultStates;
		}
		return new Map(template.map((point) => [point.id, point.state]));
	}

	private async loadOfflineStateTemplate(airport: string): Promise<OfflineStateTemplate> {
		// Create the necessary services to fetch points
		const idService = new IDService();
		const divisions = new DivisionService(this.env.DB);
		const pointsService = new PointsService(this.env.DB, idService, divisions);

		// Fetch all points for this airport
		const airportPoints = await pointsService.getAirportPoints(airport);

		return airportPoints.map((point) => ({
			id: point.id,
			state: point.type === 'taxiway' || point.type === 'lead_on' || point.type === 'stand',
		}));
	}

	private buildOfflineObjectsFromTemplate(template: OfflineStateTemplate): AirportObject[] {
		const timestamp = Date.now();
		return template.map((point) => ({
			id: point.id,
			state: point.state,
			timestamp,
		}));
	}

	private async getOnlineStateObjects(airport: string, state: AirportState): Promise<AirportObject[]> {
		const defaultStates = await this.getOfflineDefaultStates(airport);
		this.pruneDefaultStateOverrides(state, defaultStates, airport);
		return Array.from(state.objects.values());
	}

	private pruneDefaultStateOverride(state: AirportState, objectId: string, defaultStates: ReadonlyMap<string, boolean>) {
		const object = state.objects.get(objectId);
		if (!object || typeof object.state !== 'boolean') {
			return;
		}

		if (defaultStates.get(objectId) === object.state) {
			state.objects.delete(objectId);
		}
	}

	private pruneDefaultStateOverrides(state: AirportState, defaultStates: ReadonlyMap<string, boolean>, airport: string) {
		let pruned = false;

		for (const object of state.objects.values()) {
			if (typeof object.state !== 'boolean') {
				continue;
			}

			const defaultState = defaultStates.get(object.id);
			if (defaultState === object.state) {
				state.objects.delete(object.id);
				pruned = true;
			}
		}

		if (pruned) {
			this.markAirportStateDirty(airport);
		}
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

		const deny = async () => {
			const jitter = Math.floor(Math.random() * 30) + 20;
			await new Promise((r) => setTimeout(r, jitter));
			return new Response('Unauthorized', { status: 401 });
		};

		if (!apiKey) return await deny();
		if (!airport) return await deny();

		const { user, banned } = await this.auth.getConnectionPrincipalByApiKey(apiKey);
		if (!user) return await deny();

		// Ban enforcement: deny connection if banned
		if (banned) {
			return new Response('Banned', { status: 403 });
		}

		const status = await this.vatsim.getUserStatus(user.vatsim_id);
		if (!status) {
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
						if (typeof event.data === 'string') {
							rawData = event.data;
						} else {
							if (event.data.byteLength > MAX_MESSAGE_SIZE) {
								throw new Error(`Message size exceeds maximum allowed size of ${MAX_MESSAGE_SIZE} characters`);
							}
							try {
								rawData = PACKET_DECODER.decode(event.data);
							} catch {
								throw new Error('Failed to decode message data');
							}
						}

						// Validate message size
						if (rawData.length > MAX_MESSAGE_SIZE) {
							throw new Error(`Message size exceeds maximum allowed size of ${MAX_MESSAGE_SIZE} characters`);
						}

						// Parse JSON with error handling
						let packet: unknown;
						try {
							packet = JSON.parse(rawData);
						} catch {
							throw new Error('Invalid JSON format');
						}

						// Validate packet structure
						if (!this.validatePacket(packet)) {
							throw new Error('Invalid packet structure or type');
						}

						const now = Date.now();
						// Update last heartbeat time for any message received
						socketInfo.lastHeartbeat = now;

						// Update object status on each message to keep last_updated current (non-fatal on failure)
						this.touchActiveObjectStatus();
						const statusCheck = this.checkSocketStatus(server, socketInfo, now);
						if (statusCheck) this.state.waitUntil(statusCheck);

						const packetAirport = this.resolvePacketAirport(packet as Packet, socketInfo.airport);
						// Handle different packet types
						switch ((packet as Packet).type) {
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

								const p = packet as Packet;
								const airport = socketInfo.airport;
								if (!p.data || typeof p.data !== 'object' || Array.isArray(p.data)) {
									throw new Error('Invalid payload for STOPBAR_CROSSING');
								}
								const objectId = (p.data as { objectId?: string }).objectId;
								if (!objectId) {
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
								this.trackMessage({
									clientType,
									messageType: 'STOPBAR_CROSSING',
									airport,
									meta: {
										objectId,
									},
								}, recipients);
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
										requestedAt: (packet as Packet).timestamp || now,
									},
									timestamp: Date.now(),
								};
								this.sendPacket(server, snapshot, 'state_snapshot');
								break;
							}

							case 'GET_ONLINE_PILOTS': {
								this.sendPacket(
									server,
									this.createOnlinePilotsPacket(packetAirport, (packet as Packet).timestamp ?? now, now),
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
									const { updates, timestamp, airport } = await this.handleMultiStateUpdate(
										packet as Packet,
										user.vatsim_id,
										packetAirport,
									);
									const broadcastPacket: Packet = {
										type: 'MULTI_STATE_UPDATE',
										airport,
										data: { updates },
										timestamp,
									};
									const recipients = this.broadcast(broadcastPacket, server, false);
									this.trackMessage({
										clientType,
										messageType: 'MULTI_STATE_UPDATE',
										airport: socketInfo.airport,
										meta: { count: updates.length },
									}, recipients);
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
									const timestamp = await this.handleStateUpdate(packet as Packet, user.vatsim_id, packetAirport);
									const broadcastPacket = {
										...(packet as Packet),
										airport: packetAirport,
										timestamp,
									};
									const recipients = this.broadcast(broadcastPacket, server, false);
									const data = ((packet as Packet).data || {}) as Record<string, unknown>;
									const patchValue = data.patch as unknown;
									const meta: Record<string, unknown> = {
										objectId: typeof data.objectId === 'string' ? data.objectId : undefined,
										updateMode: patchValue !== undefined ? 'patch' : 'state',
									};
									if (patchValue && typeof patchValue === 'object' && !Array.isArray(patchValue)) {
										meta.patchKeys = Object.keys(patchValue as Record<string, unknown>).length;
									}
									this.trackMessage({
										clientType,
										messageType: 'STATE_UPDATE',
										airport: socketInfo.airport,
										meta,
									}, recipients);
								} catch (updateError) {
									throw new Error(
										`State update failed: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
									);
								}
								break;

							case 'CLOSE': {
								// Handle graceful disconnection
								if (clientType === 'controller') {
									await this.handleControllerDisconnect(server);
								}
								const removed = this.unregisterSocket(server);
								if (removed) {
									await this.trackDisconnection(removed, 'client_close');
								}
								server.close(1000, 'Client requested disconnection');
								break;
							}

							case 'SHARED_STATE_UPDATE':
								// Handle shared state updates
								if (clientType === 'pilot' || clientType === 'observer') {
									throw new Error('Only controllers can send shared state updates');
								}

								try {
									await this.handleSharedStateUpdate(packet as Packet, user.vatsim_id, packetAirport);
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
					} catch (err) {
						const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
						console.error(`Message handling error for ${socketInfo.controllerId}:`, errorMessage);

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

		server.addEventListener('close', () => {
			this.state.waitUntil(this.handleSocketTermination(server, 'close_event'));
		});

		server.addEventListener('error', () => {
			this.state.waitUntil(this.handleSocketTermination(server, 'socket_error'));
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
			return false;
		}
		try {
			socket.send(packetString);
			const info = this.sockets.get(socket);
			if (info) {
				info.sendFailures = 0;
			}
			return true;
		} catch (error) {
			this.handleSendFailure(socket, context, error);
			return false;
		}
	}

	private handleSendFailure(socket: WebSocket, context: string, error: unknown) {
		const info = this.sockets.get(socket);
		console.error(`Failed to send WebSocket packet during ${context}:`, error);
		if (!info) return;

		info.sendFailures++;
		if (info.sendFailures >= SEND_FAILURE_LIMIT) {
			socket.close(1011, 'Repeated send failures');
			this.state.waitUntil(this.cleanupSocket(socket, 'send_failure'));
		}
	}

	private async cleanupSocket(socket: WebSocket, reason: string) {
		const info = this.sockets.get(socket);
		if (!info) return;

		if (info.type === 'controller') {
			try {
				await this.handleControllerDisconnect(socket);
			} catch (error) {
				console.warn('handleControllerDisconnect failed during cleanup (non-fatal):', error);
			}
		}

		const removed = this.unregisterSocket(socket);
		if (!removed) return;

		try {
			await this.trackDisconnection(removed, reason);
		} catch (error) {
			console.warn('trackDisconnection failed during cleanup (non-fatal):', error);
		}
	}

	private async handleSocketTermination(socket: WebSocket, reason: 'close_event' | 'socket_error') {
		const info = this.sockets.get(socket);
		if (info?.type === 'controller') {
			try {
				await this.handleControllerDisconnect(socket);
			} catch (error) {
				console.warn('handleControllerDisconnect failed during socket termination (non-fatal):', error);
			}
		}
		const removed = this.unregisterSocket(socket);
		if (!removed) return;
		try {
			await this.trackDisconnection(removed, reason);
		} catch (error) {
			console.warn('trackDisconnection failed during socket termination (non-fatal):', error);
		}
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

	private trackMessage(details: {
		clientType: ClientType;
		messageType: Packet['type'];
		airport: string;
		meta?: Record<string, unknown>;
	}, broadcastRecipients = 0) {
		const props: Record<string, unknown> = {
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

	private getOrCreateSharedState(airport: string): Record<string, unknown> {
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
			if (!packet?.data || typeof packet.data !== 'object' || Array.isArray(packet.data)) {
				throw new Error('Invalid packet data structure');
			}

			if (!packet.data.sharedStatePatch || typeof packet.data.sharedStatePatch !== 'object' || Array.isArray(packet.data.sharedStatePatch)) {
				throw new Error('Missing or invalid sharedStatePatch');
			}

			// Validate airport parameter
			const airport = this.resolvePacketAirport(packet, connectionAirport);
			if (!airport || typeof airport !== 'string' || airport.length === 0) {
				throw new Error('Invalid airport identifier');
			}

			const patch = packet.data.sharedStatePatch as Record<string, unknown>;
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
			this.airportSharedStates.set(airport, updatedState as Record<string, unknown>);

			this.markSharedStateDirty(airport);

			// Broadcast to all clients (including sender)
			const recipients = this.broadcastSharedState(airport, serializedPatch, controllerId);

			this.trackMessage({
				clientType: 'controller',
				messageType: 'SHARED_STATE_UPDATE',
				airport,
				meta: {
					patchKeys: patchKeyCount,
					patchSize,
				},
			}, recipients);

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

	private getSharedStateSnapshot(airport: string): Record<string, unknown> {
		return this.getOrCreateSharedState(airport);
	}

	private validatePacket(packet: unknown): packet is Packet {
		// Basic structure validation
		if (!packet || typeof packet !== 'object') {
			return false;
		}

		const obj = packet as Record<string, unknown>;
		const type = obj['type'];
		// Required type field
		if (typeof type !== 'string') {
			return false;
		}

		if (!VALID_PACKET_TYPES.has(type as Packet['type'])) {
			return false;
		}

		// Optional airport field validation
		const airport = obj['airport'];
		if (airport !== undefined && (typeof airport !== 'string' || airport.length === 0)) {
			return false;
		}

		// Optional timestamp validation
		const timestamp = obj['timestamp'];
		if (timestamp !== undefined && (typeof timestamp !== 'number' || timestamp < 0)) {
			return false;
		}

		// The raw message length and JSON parse are checked before this method.
		switch (type) {
			case 'STATE_UPDATE':
				return this.validateStateUpdatePacket(packet);
			case 'MULTI_STATE_UPDATE':
				return this.validateMultiStateUpdatePacket(packet);
			case 'SHARED_STATE_UPDATE':
				return this.validateSharedStateUpdatePacket(packet);
			case 'STOPBAR_CROSSING':
				return this.validateStopbarCrossingPacket(packet);
			default:
				return true; // Other types are valid if they pass basic checks
		}
	}

	private validateStateUpdatePacket(packet: unknown): boolean {
		const obj = packet as { data?: unknown };
		if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
			return false;
		}

		const data = obj.data as Record<string, unknown>;
		// Must have objectId
		if (!data.objectId || typeof data.objectId !== 'string' || !OBJECT_ID_REGEX.test(data.objectId)) {
			return false;
		}

		// Must have either patch or state
		if (data.patch === undefined && data.state === undefined) {
			return false;
		}

		if (
			data.patch !== undefined &&
			(data.patch === null || (typeof data.patch === 'object' && !Array.isArray(data.patch))) &&
			!isSafeNestedValue(data.patch)
		) {
			return false;
		}
		if (data.patch !== undefined && data.patch !== null && (typeof data.patch !== 'object' || Array.isArray(data.patch))) {
			return false;
		}
		if (
			data.state !== undefined &&
			typeof data.state !== 'boolean' &&
			(typeof data.state !== 'object' || data.state === null || Array.isArray(data.state))
		) {
			return false;
		}
		if (data.state !== undefined && !isSafeNestedValue(data.state)) return false;

		return true;
	}

	private validateMultiStateUpdatePacket(packet: unknown): boolean {
		const obj = packet as { data?: unknown };
		const updates = this.extractMultiStateUpdates(obj.data);

		if (!updates || updates.length === 0) {
			return false;
		}

		if (updates.length > MAX_MULTI_STATE_UPDATES) {
			return false;
		}

		const typedUpdates: MultiStateUpdateItem[] = updates;

		for (const update of typedUpdates) {
			if (!update || typeof update !== 'object') return false;
			const data = update as Record<string, unknown>;
			if (!data.objectId || typeof data.objectId !== 'string') return false;
			if (!OBJECT_ID_REGEX.test(data.objectId)) return false;
			if (data.patch === undefined && data.state === undefined) return false;
			if (data.patch !== undefined && data.patch !== null && (typeof data.patch !== 'object' || Array.isArray(data.patch))) {
				return false;
			}
			if (
				data.state !== undefined &&
				typeof data.state !== 'boolean' &&
				(typeof data.state !== 'object' || data.state === null || Array.isArray(data.state))
			) {
				return false;
			}
			if (data.patch !== undefined && !isSafeNestedValue(data.patch)) return false;
			if (data.state !== undefined && !isSafeNestedValue(data.state)) return false;
		}

		return true;
	}

	private validateSharedStateUpdatePacket(packet: unknown): boolean {
		const obj = packet as { data?: unknown };
		if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
			return false;
		}

		const data = obj.data as Record<string, unknown>;
		// Must have sharedStatePatch
		if (!data.sharedStatePatch || typeof data.sharedStatePatch !== 'object' || Array.isArray(data.sharedStatePatch)) {
			return false;
		}

		if (!isSafeNestedValue(data.sharedStatePatch)) return false;
		return true;
	}

	private validateStopbarCrossingPacket(packet: unknown): boolean {
		const obj = packet as { data?: unknown };
		if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
			return false;
		}

		const data = obj.data as Record<string, unknown>;
		// Must have objectId
		if (!data.objectId || typeof data.objectId !== 'string' || !OBJECT_ID_REGEX.test(data.objectId)) {
			return false;
		}

		return true;
	}

	// Extracts a typed updates array from either a bare array payload or an object with `updates`
	private extractMultiStateUpdates(data: unknown): MultiStateUpdateItem[] | null {
		if (Array.isArray(data)) {
			return data as MultiStateUpdateItem[];
		}
		if (data && typeof data === 'object' && !Array.isArray(data)) {
			const maybeUpdates = (data as { updates?: unknown }).updates;
			if (Array.isArray(maybeUpdates)) {
				return maybeUpdates as MultiStateUpdateItem[];
			}
		}
		return null;
	}
}
