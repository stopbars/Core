import {
	ClientType,
	Packet,
	AirportState,
	AirportObject,
	MultiStateUpdateItem,
	HEARTBEAT_INTERVAL,
	HEARTBEAT_TIMEOUT,
} from '../types';
import { AuthService } from '../services/auth';
import { VatsimService } from '../services/vatsim';
import { PointsService } from '../services/points';
import { IDService } from '../services/id';
import { DivisionService } from '../services/divisions';
import { DatabaseContextFactory } from '../services/database-context';
import { PostHogService } from '../services/posthog';

const MAX_STATE_SIZE = 1000000; // 1MB limit for persisted payloads
const MAX_MULTI_STATE_UPDATES = 200;
const OBJECT_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const DISALLOWED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const STATE_FLUSH_DEBOUNCE_MS = 1500;
const ACTIVE_OBJECT_TOUCH_INTERVAL_MS = 5000;
const SOCKET_STATUS_CHECK_INTERVAL_MS = 120000;
const MAX_CONSECUTIVE_STATUS_FAILURES = 2;
const OFFLINE_STATE_CACHE_TTL_MS = 300000;
const SEND_FAILURE_LIMIT = 3;
const EFFECTIVE_HEARTBEAT_TIMEOUT = Math.max(HEARTBEAT_TIMEOUT, HEARTBEAT_INTERVAL * 3);
const createNullObject = (): Record<string, unknown> => Object.create(null) as Record<string, unknown>;

type SocketInfo = {
	controllerId: string;
	type: ClientType;
	airport: string;
	lastHeartbeat: number;
	lastStatusCheck: number;
	statusCheckInFlight: boolean;
	consecutiveVatsimFailures: number;
	sendFailures: number;
};

type OfflineStateTemplate = Array<{ id: string; state: boolean }>;

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
			if (targetRecord) {
				const clone = createNullObject();
				for (const [k, v] of Object.entries(targetRecord)) {
					clone[k] = v;
				}
				result = clone;
			}
			cloned = true;
		}
	};

	for (const key of sourceKeys) {
		if (typeof key !== 'string' || key.length > 100) {
			throw new Error('Invalid property key');
		}

		if (DISALLOWED_KEYS.has(key)) {
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
		} else {
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
	private readonly TWO_MINUTES = 120000; // Add constant at class level
	private objectId: string; // Store the DO's ID
	private lastActiveObjectsUpdate = 0; // Throttle D1 updates
	private activeObjectTouchInFlight = false;
	private airportStateFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private airportSharedStateFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private dirtyAirportStates = new Set<string>();
	private dirtySharedStates = new Set<string>();
	private socketQueues = new Map<WebSocket, Promise<void>>();
	private controllerSockets = new Map<string, Map<string, Set<WebSocket>>>();
	private offlineStateCache = new Map<
		string,
		{
			template?: OfflineStateTemplate;
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

	private registerSocket(
		socket: WebSocket,
		info: { controllerId: string; type: ClientType; airport: string; lastHeartbeat: number },
	) {
		const socketInfo: SocketInfo = {
			...info,
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
			if (socket !== currentSocket && this.sockets.has(socket)) {
				return true;
			}
		}
		return false;
	}

	private hasLiveControllers(airport: string): boolean {
		const airportControllers = this.controllerSockets.get(airport);
		if (!airportControllers) return false;
		for (const sockets of airportControllers.values()) {
			for (const socket of sockets) {
				if (this.sockets.has(socket)) {
					return true;
				}
			}
		}
		return false;
	}

	private getLiveControllerIds(airport: string): string[] {
		const airportControllers = this.controllerSockets.get(airport);
		if (!airportControllers) return [];
		const controllerIds: string[] = [];
		for (const [controllerId, sockets] of airportControllers) {
			for (const socket of sockets) {
				if (this.sockets.has(socket)) {
					controllerIds.push(controllerId);
					break;
				}
			}
		}
		return controllerIds;
	}

	private emitAnalytics(event: string, properties: Record<string, unknown>) {
		const filtered: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(properties)) {
			if (value !== undefined) {
				filtered[key] = value;
			}
		}
		try {
			this.posthog.track(event, filtered);
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

		const serialized = {
			airport: state.airport,
			objects: Object.fromEntries(
				Array.from(state.objects.entries()).map(([id, obj]) => [
					id,
					{
						id: obj.id,
						state: obj.state,
						controllerId: obj.controllerId,
						timestamp: obj.timestamp,
					},
				]),
			),
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
			void this.flushAirportState(airport);
			return;
		}
		if (this.airportStateFlushTimers.has(airport)) return;
		const timer = setTimeout(() => {
			void this.flushAirportState(airport);
		}, STATE_FLUSH_DEBOUNCE_MS);
		this.airportStateFlushTimers.set(airport, timer);
	}

	private markSharedStateDirty(airport: string, immediate = false) {
		this.dirtySharedStates.add(airport);
		if (immediate) {
			void this.flushSharedState(airport);
			return;
		}
		if (this.airportSharedStateFlushTimers.has(airport)) return;
		const timer = setTimeout(() => {
			void this.flushSharedState(airport);
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

	private async broadcast(packet: Packet, sender?: WebSocket) {
		const airport = packet.airport;
		if (!airport) {
			console.warn('Attempted to broadcast packet without airport identifier');
			return;
		}

		let packetString: string;
		try {
			packetString = JSON.stringify(packet);
		} catch (error) {
			console.error('Failed to serialize packet for broadcast:', error);
			return;
		}

		let recipients = 0;

		this.sockets.forEach((client, socket) => {
			if (socket !== sender && socket.readyState === WebSocket.OPEN && client.airport === airport) {
				recipients++;
				this.sendSerializedPacket(socket, packetString, 'broadcast');
			}
		});

		this.trackBroadcast(packet.type, airport, recipients);
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
			if (patch !== null && typeof patch !== 'object') {
				throw new Error(`Patch data must be an object or null for object ${objectId}`);
			}

			if (patch === null) {
				state.objects.delete(objectId);
				state.lastUpdate = now;
				return { objectId, patch: null };
			}

			const baseState =
				typeof existingObject.state === 'object' && existingObject.state !== null ? existingObject.state : {};
			const merged = recursivelyMergeObjects(baseState, patch as Record<string, unknown>);
			newState = merged as Record<string, unknown>;
			normalized = { objectId, patch: patch as Record<string, unknown> | null };
		} else {
			const stateValue = (update as { state?: unknown }).state;
			try {
				JSON.stringify(stateValue);
			} catch {
				throw new Error(`State data is not serializable for object ${objectId}`);
			}

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

			const now = Date.now();
			const state = this.getOrCreateAirportState(airport);
			const normalized = this.applyStateUpdateToAirport(state, packet.data as Record<string, unknown>, controllerId, now);
			await this.pruneDefaultStateOverride(airport, state, normalized.objectId);

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

		const now = Date.now();
		const state = this.getOrCreateAirportState(airport);
		const normalizedUpdates: MultiStateUpdateItem[] = [];

		for (let index = 0; index < updates.length; index++) {
			const update = updates[index];
			try {
				const normalized = this.applyStateUpdateToAirport(
					state,
					update as Record<string, unknown>,
					controllerId,
					now,
				);
				await this.pruneDefaultStateOverride(airport, state, normalized.objectId);
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

			await this.broadcast(
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
					await this.checkSocketStatus(socket, socketInfo, now);
				}

				// Send heartbeat with error handling
				try {
					this.sendPacket(socket, {
						type: 'HEARTBEAT',
						// Server will handle timestamp
					});
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

	private async checkSocketStatus(socket: WebSocket, socketInfo: SocketInfo, now: number) {
		if (socketInfo.statusCheckInFlight || now - socketInfo.lastStatusCheck < SOCKET_STATUS_CHECK_INTERVAL_MS) {
			return;
		}

		socketInfo.statusCheckInFlight = true;
		socketInfo.lastStatusCheck = now;
		try {
			if (await this.auth.isVatsimIdBanned(socketInfo.controllerId)) {
				this.sendPacket(socket, {
					type: 'ERROR',
					data: { message: 'Account banned' },
					timestamp: now,
				});
				socket.close(1008, 'Banned');
				await this.cleanupSocket(socket, 'banned');
				return;
			}

			const status = await this.vatsim.getUserStatus(socketInfo.controllerId);
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

		// Use class constant
		if (now - state.lastUpdate > this.TWO_MINUTES && !this.hasLiveControllers(airport)) {
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
				expiresAt: Date.now() + OFFLINE_STATE_CACHE_TTL_MS,
			});
			return template;
		} catch (error) {
			console.error(`Error fetching offline state for ${airport}:`, error);
			this.offlineStateCache.delete(normalizedAirport);
			return [];
		}
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
		await this.pruneDefaultStateOverrides(airport, state);
		return Array.from(state.objects.values());
	}

	private async pruneDefaultStateOverride(airport: string, state: AirportState, objectId: string) {
		const object = state.objects.get(objectId);
		if (!object || typeof object.state !== 'boolean') {
			return;
		}

		const template = await this.getOfflineStateTemplate(airport);
		const defaultState = template.find((point) => point.id === objectId)?.state;
		if (defaultState === object.state) {
			state.objects.delete(objectId);
		}
	}

	private async pruneDefaultStateOverrides(airport: string, state: AirportState) {
		const template = await this.getOfflineStateTemplate(airport);
		const defaultStates = new Map(template.map((point) => [point.id, point.state]));
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

		const user = await this.auth.getUserByApiKey(apiKey);
		if (!user) return await deny();

		// Ban enforcement: deny connection if banned
		if (await this.auth.isVatsimIdBanned(user.vatsim_id)) {
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
			type: clientType,
			airport: airport,
			lastHeartbeat: Date.now(),
		});

		// Start heartbeat mechanism
		this.startHeartbeat(server);

		// Track connection in background to avoid blocking WS upgrade on slow D1
		this.trackConnection(clientType, airport).catch((err) => {
			console.error('trackConnection failed:', err);
		});

		// Handle controller connection
		if (clientType === 'controller') {
			state.controllers.add(user.vatsim_id);
			this.markAirportStateDirty(airport, true);

			// Notify others about new controller
			await this.broadcast(
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
		const hasActiveState = hasActiveControllers;

		let stateObjects;
		let isOffline = false;

		if (clientType === 'controller' || hasActiveState) {
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
			void this.enqueueSocketTask(server, async () => {
			const socketInfo = this.sockets.get(server);
			if (!socketInfo) {
				console.warn('Received message from unregistered socket');
				return;
			}

			try {
				// Parse and validate message data
				let rawData: string;
				try {
					rawData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
				} catch {
					throw new Error('Failed to decode message data');
				}

				// Validate message size
				const MAX_MESSAGE_SIZE = 50000; // 50KB limit
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
				void this.checkSocketStatus(server, socketInfo, now);

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

						await this.broadcastToControllers(broadcastPacket, server);
						this.trackMessage({
							clientType,
							messageType: 'STOPBAR_CROSSING',
							airport,
							meta: {
								objectId,
							},
						});
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
							await this.broadcast(broadcastPacket, server);
							this.trackMessage({
								clientType,
								messageType: 'MULTI_STATE_UPDATE',
								airport: socketInfo.airport,
								meta: { count: updates.length },
							});
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
							await this.broadcast(broadcastPacket, server);
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
							});
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
			});
		});

		server.addEventListener('close', async () => {
			const info = this.sockets.get(server);
			if (info?.type === 'controller') {
				try {
					await this.handleControllerDisconnect(server);
				} catch (e) {
					console.warn('handleControllerDisconnect failed on close (non-fatal):', e);
				}
			}
			const removed = this.unregisterSocket(server);
			if (!removed) {
				return;
			}
			try {
				await this.trackDisconnection(removed, 'close_event');
			} catch (e) {
				console.warn('trackDisconnection failed on close (non-fatal):', e);
			}
		});

		server.addEventListener('error', async () => {
			const info = this.sockets.get(server);
			if (info?.type === 'controller') {
				try {
					await this.handleControllerDisconnect(server);
				} catch (e) {
					console.warn('handleControllerDisconnect failed on error (non-fatal):', e);
				}
			}
			const removed = this.unregisterSocket(server);
			if (!removed) {
				return;
			}
			try {
				await this.trackDisconnection(removed, 'socket_error');
			} catch (e) {
				console.warn('trackDisconnection failed on error (non-fatal):', e);
			}
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
			void this.cleanupSocket(socket, 'send_failure');
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

	private touchActiveObjectStatus() {
		if (this.activeObjectTouchInFlight) return;
		const now = Date.now();
		if (now - this.lastActiveObjectsUpdate < ACTIVE_OBJECT_TOUCH_INTERVAL_MS) return;

		this.activeObjectTouchInFlight = true;
		void this.updateObjectStatus().finally(() => {
			this.activeObjectTouchInFlight = false;
		});
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
		await this.updateActiveConnections(1);

		// Add this object to active_objects table when first connection is made
		if (this.sockets.size === 1) {
			try {
				const session = DatabaseContextFactory.createSessionService(this.env.DB);
				await session.executeWrite(
					"INSERT OR REPLACE INTO active_objects (id, name, last_updated) VALUES (?, ?, datetime('now'))",
					[this.objectId, this.getObjectName()],
				);
				session.closeSession();
			} catch (e) {
				console.warn('Failed to upsert active_objects on connect (non-fatal):', e instanceof Error ? e.message : e);
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
		await this.updateActiveConnections(-1);

		// If no more connections, remove from active_objects
		if (this.sockets.size === 0) {
			try {
				const session = DatabaseContextFactory.createSessionService(this.env.DB);
				await session.executeWrite('DELETE FROM active_objects WHERE id = ?', [this.objectId]);
				session.closeSession();
			} catch (e) {
				console.warn('Failed to delete active_objects on disconnect (non-fatal):', e instanceof Error ? e.message : e);
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
			try {
				const session = DatabaseContextFactory.createSessionService(this.env.DB);
				await session.executeWrite("UPDATE active_objects SET name = ?, last_updated = datetime('now') WHERE id = ?", [
					name,
					this.objectId,
				]);
				session.closeSession();
				this.lastActiveObjectsUpdate = now;
			} catch (e) {
				console.warn('Failed to update active_objects name (non-fatal):', e instanceof Error ? e.message : e);
			}
		}
	}

	private trackMessage(details: {
		clientType: ClientType;
		messageType: Packet['type'];
		airport: string;
		meta?: Record<string, unknown>;
	}) {
		const props: Record<string, unknown> = {
			airport: details.airport,
			clientType: details.clientType,
			messageType: details.messageType,
			socket_count: this.sockets.size,
			...details.meta,
		};
		this.emitAnalytics('ws_message', props);
	}

	private async updateActiveConnections(change: number) {
		const activeConnectionsKey = 'active_connections';
		const current = ((await this.state.storage.get(activeConnectionsKey)) as number) || 0;
		await this.state.storage.put(activeConnectionsKey, Math.max(0, current + change));
	}

	async fetch(request: Request) {
		if (request.headers.get('X-Request-Type') === 'get_state') {
			const url = new URL(request.url);
			const airport = url.searchParams.get('airport');
			const forceOffline = url.searchParams.get('offline') === 'true';

			if (!airport) {
				return new Response(
					JSON.stringify({
						error: 'Airport parameter required',
					}),
					{
						status: 400,
						headers: {
							'Content-Type': 'application/json',
							'Access-Control-Allow-Origin': '*',
						},
					},
				);
			}

			if (forceOffline) {
				const objects = await this.getOfflineStateFromPoints(airport);
				return new Response(
					JSON.stringify({
						airport,
						objects,
						offline: true,
					}),
					{
						headers: {
							'Content-Type': 'application/json',
							'Access-Control-Allow-Origin': '*',
						},
					},
				);
			}

			// Get connected clients for this airport regardless of state
			const connectedClients = Array.from(this.sockets.entries())
				.filter(([, info]) => info.airport === airport)
				.reduce(
					(acc, [, info]) => {
						if (info.type === 'controller') {
							// Use Set to prevent duplicates, then convert to array
							if (!acc.controllerSet.has(info.controllerId)) {
								acc.controllerSet.add(info.controllerId);
								acc.controllers.push(info.controllerId);
							}
						} else if (info.type === 'pilot') {
							// Use Set to prevent duplicates, then convert to array
							if (!acc.pilotSet.has(info.controllerId)) {
								acc.pilotSet.add(info.controllerId);
								acc.pilots.push(info.controllerId);
							}
						}
						return acc;
					},
					{
						controllers: [] as string[],
						pilots: [] as string[],
						controllerSet: new Set<string>(),
						pilotSet: new Set<string>(),
					},
				);
			const state = this.airportStates.get(airport);
			let isOffline = false;
			let objects: AirportObject[] = [];

			// If there are no controllers connected, always use offline mode
			const connectedControllers = this.hasLiveControllers(airport);

			if (state && connectedControllers) {
				// Return active state with all objects regardless of recency since controllers are connected
				objects = await this.getOnlineStateObjects(airport, state);
			} else {
				// No controllers connected or no state exists, mark as offline
				isOffline = true;
				objects = await this.getOfflineStateFromPoints(airport);
			}

			return new Response(
				JSON.stringify({
					airport,
					controllers: connectedClients.controllers,
					pilots: connectedClients.pilots,
					objects: objects,
					offline: isOffline,
				}),
				{
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				},
			);
		}

		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocket(request);
		}
		return new Response('Expected WebSocket', { status: 400 });
	}

	private async broadcastToControllers(packet: Packet, sender?: WebSocket) {
		const airport = packet.airport;
		if (!airport) return;

		let packetString: string;
		try {
			packetString = JSON.stringify(packet);
		} catch (error) {
			console.error('Failed to serialize controller broadcast packet:', error);
			return;
		}
		let recipients = 0;

		this.sockets.forEach((client, socket) => {
			if (socket !== sender && socket.readyState === WebSocket.OPEN && client.airport === airport && client.type === 'controller') {
				recipients++;
				this.sendSerializedPacket(socket, packetString, 'controller_broadcast');
			}
		});

		this.trackBroadcast(packet.type, airport, recipients);
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

			if (!packet.data.sharedStatePatch || typeof packet.data.sharedStatePatch !== 'object') {
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

			// Validate patch structure and size
			try {
				const patchString = JSON.stringify(patch);
				patchSize = patchString.length;
				const MAX_PATCH_SIZE = 10240; // 10KB limit
				if (patchSize > MAX_PATCH_SIZE) {
					throw new Error(`Patch size exceeds maximum allowed size of ${MAX_PATCH_SIZE} characters`);
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
			await this.broadcastSharedState(airport, patch, controllerId);

			this.trackMessage({
				clientType: 'controller',
				messageType: 'SHARED_STATE_UPDATE',
				airport,
				meta: {
					patchKeys: patchKeyCount,
					patchSize,
				},
			});

			return updatedState;
		} catch (error) {
			console.error(`Shared state update error for controller ${controllerId}:`, error);
			throw error; // Re-throw to be handled by caller
		}
	}

	private async broadcastSharedState(airport: string, patch: Record<string, unknown>, controllerId: string) {
		const packet: Packet = {
			type: 'SHARED_STATE_UPDATE',
			airport: airport,
			data: {
				sharedStatePatch: patch,
				controllerId: controllerId,
			},
			timestamp: Date.now(),
		};

		let packetString: string;
		try {
			packetString = JSON.stringify(packet);
		} catch (error) {
			console.error('Failed to serialize shared state packet:', error);
			return;
		}

		let recipients = 0;
		this.sockets.forEach((client, socket) => {
			if (socket.readyState === WebSocket.OPEN && client.airport === airport) {
				recipients++;
				this.sendSerializedPacket(socket, packetString, 'shared_state_broadcast');
			}
		});

		this.trackBroadcast(packet.type, airport, recipients);
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

		// Validate known packet types
		const validTypes = [
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
			'STOPBAR_CROSSING',
		];

		if (!validTypes.includes(type)) {
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

		// Type-specific validation
		// Global size/depth guard for any packet carrying data
		const MAX_PACKET_CHARS = 50000;
		try {
			const s = JSON.stringify(packet);
			if (s.length > MAX_PACKET_CHARS) return false;
		} catch {
			return false;
		}
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
		if (!data.objectId || typeof data.objectId !== 'string') {
			return false;
		}

		// Must have either patch or state
		if (data.patch === undefined && data.state === undefined) {
			return false;
		}

		// Guard patch/state size and depth
		const guardObject = (val: unknown, maxDepth = 20, maxProps = 100): boolean => {
			const seen = new WeakSet<object>();
			const walk = (v: unknown, depth: number): boolean => {
				if (v === null) return true;
				if (typeof v !== 'object') return true;
				if (Array.isArray(v)) {
					return v.length <= 1000 && v.every((it) => walk(it, depth + 1));
				}
				if (depth > maxDepth) return false;
				const o = v as Record<string, unknown>;
				if (seen.has(o)) return false;
				seen.add(o);
				const keys = Object.keys(o);
				if (keys.length > maxProps) return false;
				return keys.every((k) => typeof k === 'string' && k.length <= 100 && walk(o[k], depth + 1));
			};
			return walk(val, 0);
		};
		if (data.patch !== undefined && !guardObject(data.patch)) return false;
		if (data.state !== undefined && !guardObject(data.state)) return false;

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

		const guardObject = (val: unknown, maxDepth = 20, maxProps = 100): boolean => {
			const seen = new WeakSet<object>();
			const walk = (v: unknown, depth: number): boolean => {
				if (v === null) return true;
				if (typeof v !== 'object') return true;
				if (Array.isArray(v)) {
					return v.length <= 1000 && v.every((it) => walk(it, depth + 1));
				}
				if (depth > maxDepth) return false;
				const o = v as Record<string, unknown>;
				if (seen.has(o)) return false;
				seen.add(o);
				const keys = Object.keys(o);
				if (keys.length > maxProps) return false;
				return keys.every((k) => typeof k === 'string' && k.length <= 100 && walk(o[k], depth + 1));
			};
			return walk(val, 0);
		};

		for (const update of typedUpdates) {
			if (!update || typeof update !== 'object') return false;
			const data = update as Record<string, unknown>;
			if (!data.objectId || typeof data.objectId !== 'string') return false;
			if (!OBJECT_ID_REGEX.test(data.objectId)) return false;
			if (data.patch === undefined && data.state === undefined) return false;
			if (data.patch !== undefined && !guardObject(data.patch)) return false;
			if (data.state !== undefined && !guardObject(data.state)) return false;
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
		if (!data.sharedStatePatch || typeof data.sharedStatePatch !== 'object') {
			return false;
		}

		// Size/depth guard
		const guardObject = (val: unknown, maxDepth = 20, maxProps = 100): boolean => {
			const seen = new WeakSet<object>();
			const walk = (v: unknown, depth: number): boolean => {
				if (v === null) return true;
				if (typeof v !== 'object') return true;
				if (Array.isArray(v)) {
					return v.length <= 1000 && v.every((it) => walk(it, depth + 1));
				}
				if (depth > maxDepth) return false;
				const o = v as Record<string, unknown>;
				if (seen.has(o)) return false;
				seen.add(o);
				const keys = Object.keys(o);
				if (keys.length > maxProps) return false;
				return keys.every((k) => typeof k === 'string' && k.length <= 100 && walk(o[k], depth + 1));
			};
			return walk(val, 0);
		};
		if (!guardObject(data.sharedStatePatch)) return false;
		return true;
	}

	private validateStopbarCrossingPacket(packet: unknown): boolean {
		const obj = packet as { data?: unknown };
		if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
			return false;
		}

		const data = obj.data as Record<string, unknown>;
		// Must have objectId
		if (!data.objectId || typeof data.objectId !== 'string') {
			return false;
		}

		return true;
	}

	private sanitizeInput(input: string): string {
		// Remove potentially dangerous characters and limit length
		return input.replace(/[<>'"&]/g, '').substring(0, 1000);
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
