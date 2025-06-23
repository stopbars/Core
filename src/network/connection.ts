import { ClientType, Packet, AirportState, AirportObject, HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT, Point } from '../types';
import { AuthService } from '../services/auth';
import { VatsimService } from '../services/vatsim';
import { StatsService } from '../services/stats';
import { PointsService } from '../services/points';
import { IDService } from '../services/id';
import { DivisionService } from '../services/divisions';

// Add recursive merge utility function with safety checks
function recursivelyMergeObjects(target: any, source: any, depth = 0): any {
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

	// Handle objects - merge properties
	const result = { ...target };

	// Limit number of properties to prevent memory issues
	const MAX_PROPERTIES = 100;
	const sourceKeys = Object.keys(source);
	if (sourceKeys.length > MAX_PROPERTIES) {
		throw new Error(`Object has too many properties (${sourceKeys.length} > ${MAX_PROPERTIES})`);
	}

	for (const key in source) {
		if (Object.prototype.hasOwnProperty.call(source, key)) {
			// Validate key is safe
			if (typeof key !== 'string' || key.length > 100) {
				throw new Error('Invalid property key');
			}

			if (
				typeof source[key] === 'object' &&
				source[key] !== null &&
				!Array.isArray(source[key]) &&
				Object.prototype.hasOwnProperty.call(result, key) &&
				typeof result[key] === 'object' &&
				result[key] !== null
			) {
				// Recursively merge nested objects
				result[key] = recursivelyMergeObjects(result[key], source[key], depth + 1);
			} else {
				// For primitives, arrays, or non-existent target properties, just replace
				result[key] = source[key];
			}
		}
	}

	return result;
}

export class Connection {
	private sockets = new Map<
		WebSocket,
		{
			controllerId: string;
			type: ClientType;
			airport: string;
			lastHeartbeat: number;
		}
	>();

	private airportStates = new Map<string, AirportState>();
	private airportSharedStates = new Map<string, Record<string, any>>(); // New shared state storage
	private readonly TWO_MINUTES = 120000; // Add constant at class level
	private objectId: string; // Store the DO's ID

	constructor(
		private env: Env,
		private auth: AuthService,
		private vatsim: VatsimService,
		private state: DurableObjectState,
		private stats: StatsService,
	) {
		this.objectId = state.id.toString();
		this.loadPersistedState();
	}
	private async loadPersistedState() {
		const persisted = await this.state.storage.get('airport_states');
		if (persisted) {
			this.airportStates = new Map(
				Object.entries(persisted).map(([airport, state]) => {
					const airportState = state as AirportState;
					return [
						airport,
						{
							airport,
							objects: new Map(
								Object.entries(airportState.objects || {}).map(([id, obj]) => [
									id,
									{
										id,
										state: obj.state,
										controllerId: obj.controllerId,
										timestamp: obj.timestamp,
									},
								]),
							),
							lastUpdate: airportState.lastUpdate || Date.now(),
							controllers: new Set(airportState.controllers || []),
						},
					];
				}),
			);
		}

		// Load shared states
		const sharedStates = await this.state.storage.get('airport_shared_states');
		if (sharedStates) {
			this.airportSharedStates = new Map(Object.entries(sharedStates));
		}
	}
	private async persistState() {
		try {
			const serialized = Object.fromEntries(
				Array.from(this.airportStates.entries()).map(([airport, state]) => [
					airport,
					{
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
					},
				]),
			);

			// Validate serialized data before persisting
			const serializedString = JSON.stringify(serialized);
			const MAX_STATE_SIZE = 1000000; // 1MB limit
			if (serializedString.length > MAX_STATE_SIZE) {
				console.warn(`State size (${serializedString.length}) exceeds maximum (${MAX_STATE_SIZE}), skipping persistence`);
				return;
			}

			await this.state.storage.put('airport_states', serialized);

			// Persist shared states with validation
			const sharedStatesSerialized = Object.fromEntries(this.airportSharedStates.entries());
			const sharedStatesString = JSON.stringify(sharedStatesSerialized);
			if (sharedStatesString.length > MAX_STATE_SIZE) {
				console.warn(`Shared state size (${sharedStatesString.length}) exceeds maximum (${MAX_STATE_SIZE}), skipping persistence`);
				return;
			}

			await this.state.storage.put('airport_shared_states', sharedStatesSerialized);
		} catch (error) {
			console.error('Failed to persist state:', error);
			// Don't throw here to avoid breaking the calling flow
		}
	}

	private async broadcast(packet: Packet, sender?: WebSocket) {
		const airport = packet.airport;
		if (!airport) {
			console.warn('Attempted to broadcast packet without airport identifier');
			return;
		}

		// Validate packet before broadcasting
		try {
			JSON.stringify(packet);
		} catch (error) {
			console.error('Failed to serialize packet for broadcast:', error);
			return;
		}

		const promises: Promise<void>[] = [];
		const packetString = JSON.stringify(packet);

		this.sockets.forEach((client, socket) => {
			if (socket !== sender && socket.readyState === WebSocket.OPEN && client.airport === airport) {
				promises.push(
					new Promise((resolve) => {
						try {
							socket.send(packetString);
						} catch (error) {
							console.error(`Failed to send packet to client ${client.controllerId}:`, error);
							// Don't disconnect the client for send failures, just log the error
						} finally {
							resolve();
						}
					}),
				);
			}
		});

		await Promise.all(promises);
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
	private handleStateUpdate(packet: Packet, controllerId: string, connectionAirport: string) {
		try {
			// Validate required fields
			if (!packet?.data || typeof packet.data !== 'object') {
				throw new Error('Invalid packet data structure');
			}

			if (!packet.data.objectId || typeof packet.data.objectId !== 'string') {
				throw new Error('Missing or invalid objectId');
			}

			if (packet.data.patch === undefined && packet.data.state === undefined) {
				throw new Error('Missing both patch and state data');
			}

			// Validate airport parameter
			const airport = packet.airport || connectionAirport;
			if (!airport || typeof airport !== 'string' || airport.length === 0) {
				throw new Error('Invalid airport identifier');
			}

			// Validate objectId format (should be alphanumeric with possible hyphens/underscores)
			const objectIdRegex = /^[a-zA-Z0-9_-]+$/;
			if (!objectIdRegex.test(packet.data.objectId)) {
				throw new Error('Invalid objectId format');
			}

			const now = Date.now();
			const state = this.getOrCreateAirportState(airport);
			const objectId = packet.data.objectId;

			// Get existing object or create a new one
			const existingObject = state.objects.get(objectId) || {
				id: objectId,
				state: {}, // Initialize with empty object for patching
				controllerId: controllerId,
				timestamp: now,
			};

			let newState;

			// Handle both legacy 'state' updates and new 'patch' updates
			if (packet.data.patch !== undefined) {
				// Validate patch is an object
				if (packet.data.patch !== null && typeof packet.data.patch !== 'object') {
					throw new Error('Patch data must be an object or null');
				}

				// Ensure existing state is an object for merging
				const baseState = (typeof existingObject.state === 'object' && existingObject.state !== null)
					? existingObject.state
					: {};

				// Apply patch using recursive merge with size limit
				newState = recursivelyMergeObjects(baseState, packet.data.patch);
			} else {
				// Legacy direct state update - validate it's serializable
				try {
					JSON.stringify(packet.data.state);
					newState = packet.data.state;
				} catch (error) {
					throw new Error('State data is not serializable');
				}
			}

			// Update the object with merged state
			state.objects.set(objectId, {
				id: objectId,
				state: newState,
				controllerId: controllerId,
				timestamp: now,
			});

			state.lastUpdate = now;

			this.persistState();
			return now; // Return timestamp for broadcasting
		} catch (error) {
			console.error(`State update error for controller ${controllerId}:`, error);
			throw error; // Re-throw to be handled by caller
		}
	}

	private async handleControllerDisconnect(socket: WebSocket) {
		const socketInfo = this.sockets.get(socket);
		if (!socketInfo || socketInfo.type !== 'controller') return;

		const state = this.airportStates.get(socketInfo.airport);
		if (state) {
			state.controllers.delete(socketInfo.controllerId);

			// Update timestamp when last controller disconnects
			if (state.controllers.size === 0) {
				state.lastUpdate = Date.now();
			}

			await this.persistState();

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
				if (now - socketInfo.lastHeartbeat > HEARTBEAT_TIMEOUT) {
					socket.close(1000, 'Heartbeat timeout');
					clearInterval(interval);
					return;
				}

				// Periodically check if the user is still connected to VATSIM
				vatsimCheckCounter++;
				if (vatsimCheckCounter >= VATSIM_CHECK_FREQUENCY) {
					vatsimCheckCounter = 0;
					// Get the latest VATSIM status
					const status = await this.vatsim.getUserStatus(socketInfo.controllerId);

					if (!status) {
						// User is no longer on VATSIM, disconnect them
						console.log(`User ${socketInfo.controllerId} no longer connected to VATSIM, closing connection`);
						socket.send(
							JSON.stringify({
								type: 'ERROR',
								data: { message: 'No longer connected to VATSIM' },
								timestamp: now,
							}),
						);

						// Handle cleanup for controllers
						if (socketInfo.type === 'controller') {
							await this.handleControllerDisconnect(socket);
						}

						this.sockets.delete(socket);
						await this.trackDisconnection();
						socket.close(1000, 'No longer connected to VATSIM');
						clearInterval(interval);
						return;
					}
					// If user is still connected but role changed, handle that case
					const isController = this.vatsim.isController(status);
					const isPilot = this.vatsim.isPilot(status);
					const isObserver = this.vatsim.isObserver(status);

					if ((socketInfo.type === 'controller' && !isController) ||
						(socketInfo.type === 'pilot' && !isPilot) ||
						(socketInfo.type === 'observer' && !isObserver)) {
						console.log(`User ${socketInfo.controllerId} role changed on VATSIM, closing connection`);
						socket.send(
							JSON.stringify({
								type: 'ERROR',
								data: { message: 'Role changed on VATSIM, please reconnect' },
								timestamp: now,
							}),
						);

						if (socketInfo.type === 'controller') {
							await this.handleControllerDisconnect(socket);
						}

						this.sockets.delete(socket);
						await this.trackDisconnection();
						socket.close(1000, 'Role changed on VATSIM');
						clearInterval(interval);
						return;
					}
				}

				// Send heartbeat with error handling
				try {
					socket.send(
						JSON.stringify({
							type: 'HEARTBEAT',
							// Server will handle timestamp
						}),
					);
				} catch (sendError) {
					console.error(`Failed to send heartbeat to ${socketInfo.controllerId}:`, sendError);
					socket.close(1011, 'Failed to send heartbeat');
					clearInterval(interval);
					return;
				}
			} catch (error) {
				console.error('Error in heartbeat:', error);
				socket.close(1011, 'Internal error in heartbeat');
				clearInterval(interval);
			}
		}, HEARTBEAT_INTERVAL);

		// Clean up interval on socket close
		socket.addEventListener('close', (event) => {
			clearInterval(interval);
		});

		// Add error handler
		socket.addEventListener('error', (error) => {
			console.error('WebSocket error:', error);
		});
	}
	private clearStaleState(airport: string) {
		const state = this.airportStates.get(airport);
		if (!state) return;

		const now = Date.now();

		// Use class constant
		if (now - state.lastUpdate > this.TWO_MINUTES && state.controllers.size === 0) {
			// Clear objects but keep the airport state structure
			state.objects.clear();
			state.lastUpdate = now;

			// Also clear shared state when no controllers are present for 2 minutes
			this.airportSharedStates.set(airport, {});

			this.persistState();
		}
	}

	private async getOfflineStateFromPoints(airport: string): Promise<AirportObject[]> {
		try {
			// Create the necessary services to fetch points
			const idService = new IDService(this.env.DB);
			const divisions = new DivisionService(this.env.DB);
			const pointsService = new PointsService(this.env.DB, idService, divisions, this.auth);

			// Fetch all points for this airport
			const airportPoints = await pointsService.getAirportPoints(airport);

			// Create default state objects based on point types
			return airportPoints.map((point) => {
				// Set default state based on point type
				let defaultState = false;
				if (point.type === 'taxiway' || point.type === 'lead_on' || point.type === 'stand') {
					defaultState = true;
				} else if (point.type === 'stopbar') {
					defaultState = false;
				}

				return {
					id: point.id,
					state: defaultState,
					timestamp: Date.now(),
				};
			});
		} catch (error) {
			console.error(`Error fetching offline state for ${airport}:`, error);
			return []; // Return empty array if there's an error
		}
	}

	async handleWebSocket(request: Request) {
		const url = new URL(request.url);
		const apiKey = url.searchParams.get('key');
		const airport = url.searchParams.get('airport');

		if (!apiKey) return new Response('Unauthorized', { status: 401 });
		if (!airport) return new Response('Airport parameter required', { status: 400 });

		const user = await this.auth.getUserByApiKey(apiKey);
		if (!user) return new Response('Unauthorized', { status: 401 });

		const status = await this.vatsim.getUserStatus(user.vatsim_id);
		if (!status) {
			return new Response('User not connected to VATSIM', { status: 403 });
		}
		// Auto-determine client type based on VATSIM status
		const clientType = this.vatsim.isController(status)
			? 'controller'
			: this.vatsim.isObserver(status)
				? 'observer'
				: 'pilot';

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		server.accept();

		// Initialize socket info with the airport and heartbeat
		this.sockets.set(server, {
			controllerId: user.vatsim_id,
			type: clientType,
			airport: airport,
			lastHeartbeat: Date.now(),
		});

		// Start heartbeat mechanism
		this.startHeartbeat(server);

		await this.trackConnection(clientType);

		// Load or create airport state
		const state = this.getOrCreateAirportState(airport);

		// Check and clear stale state before processing connection
		this.clearStaleState(airport);

		// Handle controller connection
		if (clientType === 'controller') {
			state.controllers.add(user.vatsim_id);
			await this.persistState();

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
		// Only consider controllers for determining if state is active
		const hasActiveControllers = state.controllers.size > 0;
		const hasRecentUpdates = now - state.lastUpdate <= this.TWO_MINUTES;
		const hasActiveState = hasActiveControllers && hasRecentUpdates;

		let stateObjects;
		let isOffline = false;

		if (clientType === 'controller' || hasActiveState) {
			// Controllers always get the current state
			// Pilots get active state only if controllers are online and have recent updates
			stateObjects = Array.from(state.objects.values());
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
				offline: isOffline,
				sharedState: this.getSharedStateSnapshot(airport), // Add shared state to initial state
			},
			timestamp: now,
		};

		server.send(JSON.stringify(initialState));

		server.addEventListener('message', async (event) => {
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
				} catch (error) {
					throw new Error('Failed to decode message data');
				}

				// Validate message size
				const MAX_MESSAGE_SIZE = 50000; // 50KB limit
				if (rawData.length > MAX_MESSAGE_SIZE) {
					throw new Error(`Message size exceeds maximum allowed size of ${MAX_MESSAGE_SIZE} characters`);
				}

				// Parse JSON with error handling
				let packet: any;
				try {
					packet = JSON.parse(rawData);
				} catch (error) {
					throw new Error('Invalid JSON format');
				}

				// Validate packet structure
				if (!this.validatePacket(packet)) {
					throw new Error('Invalid packet structure or type');
				}

				const now = Date.now();
				// Update last heartbeat time for any message received
				socketInfo.lastHeartbeat = now;

				// Update object status on each message to keep last_updated current
				await this.updateObjectStatus();

				// Handle different packet types
				switch (packet.type) {
					case 'HEARTBEAT':
						// Respond to heartbeat with acknowledgment, adding server timestamp
						server.send(
							JSON.stringify({
								type: 'HEARTBEAT_ACK',
								timestamp: now,
							}),
						);
						break;

					case 'STATE_UPDATE':
						if (clientType === 'pilot') {
							throw new Error('Pilots cannot send state updates');
						}
						if (clientType === 'observer') {
							throw new Error('Observers cannot send state updates');
						}

						try {
							const timestamp = this.handleStateUpdate(packet, user.vatsim_id, socketInfo.airport);
							const broadcastPacket = {
								...packet,
								airport: packet.airport || socketInfo.airport,
								timestamp,
							};
							await this.broadcast(broadcastPacket, server);
							await this.trackMessage(clientType);
						} catch (updateError) {
							throw new Error(`State update failed: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
						}
						break;

					case 'CLOSE':
						// Handle graceful disconnection
						if (clientType === 'controller') {
							await this.handleControllerDisconnect(server);
						}
						this.sockets.delete(server);
						await this.trackDisconnection();
						server.close(1000, 'Client requested disconnection');
						break;

					case 'SHARED_STATE_UPDATE':
						// Handle shared state updates
						if (clientType === 'pilot' || clientType === 'observer') {
							throw new Error('Only controllers can send shared state updates');
						}

						try {
							this.handleSharedStateUpdate(packet, user.vatsim_id, socketInfo.airport);
						} catch (updateError) {
							throw new Error(`Shared state update failed: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
						}
						break;

					default:
						// Reject unknown packet types
						throw new Error(`Unknown packet type: ${packet.type}`);
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				console.error(`Message handling error for ${socketInfo.controllerId}:`, errorMessage);

				// Send error response to client
				try {
					server.send(
						JSON.stringify({
							type: 'ERROR',
							data: { message: errorMessage },
							timestamp: Date.now(),
						}),
					);
				} catch (sendError) {
					console.error('Failed to send error message to client:', sendError);
					// If we can't send an error message, close the connection
					server.close(1011, 'Internal error - unable to communicate');
				}
			}
		});

		server.addEventListener('close', async () => {
			if (this.sockets.get(server)?.type === 'controller') {
				await this.handleControllerDisconnect(server);
			}
			this.sockets.delete(server);
			await this.trackDisconnection();
		});

		server.addEventListener('error', async () => {
			if (this.sockets.get(server)?.type === 'controller') {
				await this.handleControllerDisconnect(server);
			}
			this.sockets.delete(server);
			await this.trackDisconnection();
		});

		return new Response(null, { status: 101, webSocket: client });
	}

	private async trackConnection(clientType: ClientType) {
		await this.stats.incrementStat(`${clientType}_connections`);
		await this.stats.incrementStat('total_connections');
		await this.updateActiveConnections(1);

		// Add this object to active_objects table when first connection is made
		if (this.sockets.size === 1) {
			const stmt = this.env.DB.prepare(
				"INSERT OR REPLACE INTO active_objects (id, name, last_updated) VALUES (?, ?, datetime('now'))",
			);
			await stmt.bind(this.objectId, this.getObjectName()).run();
		}
	}

	private async trackDisconnection() {
		await this.updateActiveConnections(-1);

		// If no more connections, remove from active_objects
		if (this.sockets.size === 0) {
			const stmt = this.env.DB.prepare('DELETE FROM active_objects WHERE id = ?');
			await stmt.bind(this.objectId).run();
		}
	}
	private getObjectName(): string {
		// Create a descriptive name with format: airport/controllerCount/pilotCount/observerCount
		const airport = Array.from(this.sockets.values())[0]?.airport || 'unknown';
		const counts = Array.from(this.sockets.values()).reduce(
			(acc, client) => {
				if (client.type === 'controller') acc.controllers++;
				else if (client.type === 'pilot') acc.pilots++;
				else if (client.type === 'observer') acc.observers++;
				return acc;
			},
			{ controllers: 0, pilots: 0, observers: 0 },
		);
		return `${airport}/${counts.controllers}/${counts.pilots}/${counts.observers}`;
	}

	private async updateObjectStatus() {
		if (this.sockets.size > 0) {
			// Update the object's name and last_updated timestamp
			const stmt = this.env.DB.prepare("UPDATE active_objects SET name = ?, last_updated = datetime('now') WHERE id = ?");
			await stmt.bind(this.getObjectName(), this.objectId).run();
		}
	}

	private async trackMessage(clientType: ClientType) {
		await this.stats.incrementStat(`${clientType}_messages_sent`);
		await this.stats.incrementStat('total_messages_sent');
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

			// Get connected clients for this airport regardless of state
			const connectedClients = Array.from(this.sockets.entries())
				.filter(([_, info]) => info.airport === airport)
				.reduce(
					(acc, [_, info]) => {
						if (info.type === 'controller') {
							acc.controllers.push(info.controllerId);
						} else if (info.type === 'pilot') {
							acc.pilots.push(info.controllerId);
						}
						return acc;
					},
					{ controllers: [] as string[], pilots: [] as string[] },
				); // Check and potentially clear stale state
			const state = this.airportStates.get(airport);
			let isOffline = false;
			let objects: any[] = [];

			// If there are no controllers connected, always use offline mode
			const connectedControllers = connectedClients.controllers.length > 0;

			if (state && connectedControllers) {
				const now = Date.now();
				// Check if there's a recent state from controllers
				const hasRecentState = now - state.lastUpdate <= this.TWO_MINUTES;

				if (hasRecentState) {
					// Return active state with actual objects
					objects = Array.from(state.objects.values())
						.filter((obj) => obj.state)
						.map((obj) => ({
							id: obj.id,
							state: obj.state,
							controllerId: obj.controllerId,
							timestamp: obj.timestamp,
						}));
				} else {
					// Recent controllers but no recent state, use offline
					isOffline = true;
					objects = await this.getOfflineStateFromPoints(airport);
				}
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

	private getOrCreateSharedState(airport: string): Record<string, any> {
		let sharedState = this.airportSharedStates.get(airport);
		if (!sharedState) {
			sharedState = {}; // Initialize as empty object as per requirements
			this.airportSharedStates.set(airport, sharedState);
		}
		return sharedState;
	}
	private handleSharedStateUpdate(packet: Packet, controllerId: string, connectionAirport: string) {
		try {
			// Validate required fields
			if (!packet?.data || typeof packet.data !== 'object') {
				throw new Error('Invalid packet data structure');
			}

			if (!packet.data.sharedStatePatch || typeof packet.data.sharedStatePatch !== 'object') {
				throw new Error('Missing or invalid sharedStatePatch');
			}

			// Validate airport parameter
			const airport = packet.airport || connectionAirport;
			if (!airport || typeof airport !== 'string' || airport.length === 0) {
				throw new Error('Invalid airport identifier');
			}

			const patch = packet.data.sharedStatePatch;

			// Validate patch structure and size
			try {
				const patchString = JSON.stringify(patch);
				const MAX_PATCH_SIZE = 10240; // 10KB limit
				if (patchString.length > MAX_PATCH_SIZE) {
					throw new Error(`Patch size exceeds maximum allowed size of ${MAX_PATCH_SIZE} characters`);
				}
			} catch (error) {
				throw new Error('Patch data is not serializable');
			}

			// Get current shared state
			const currentState = this.getOrCreateSharedState(airport);

			// Apply recursive merge with error handling
			const updatedState = recursivelyMergeObjects(currentState, patch);

			// Update the stored state
			this.airportSharedStates.set(airport, updatedState);

			// Persist to storage
			this.persistState();

			// Broadcast to all clients (including sender)
			this.broadcastSharedState(airport, patch, controllerId);

			return updatedState;
		} catch (error) {
			console.error(`Shared state update error for controller ${controllerId}:`, error);
			throw error; // Re-throw to be handled by caller
		}
	}

	private async broadcastSharedState(airport: string, patch: Record<string, any>, controllerId: string) {
		const packet: Packet = {
			type: 'SHARED_STATE_UPDATE',
			airport: airport,
			data: {
				sharedStatePatch: patch,
				controllerId: controllerId
			},
			timestamp: Date.now(),
		};

		// Broadcast to ALL clients connected to this airport (including the sender)
		const promises: Promise<void>[] = [];

		this.sockets.forEach((client, socket) => {
			if (socket.readyState === WebSocket.OPEN && client.airport === airport) {
				promises.push(
					new Promise((resolve) => {
						try {
							socket.send(JSON.stringify(packet));
						} catch (error) {
							console.error(`Failed to send packet over WebSocket: ${error instanceof Error ? error.message : String(error)}`);
						} finally {
							resolve();
						}
					}),
				);
			}
		});

		await Promise.all(promises);
	}

	private getSharedStateSnapshot(airport: string): Record<string, any> {
		return this.getOrCreateSharedState(airport);
	}

	private validatePacket(packet: any): packet is Packet {
		// Basic structure validation
		if (!packet || typeof packet !== 'object') {
			return false;
		}

		// Required type field
		if (!packet.type || typeof packet.type !== 'string') {
			return false;
		}

		// Validate known packet types
		const validTypes = [
			'HEARTBEAT',
			'HEARTBEAT_ACK',
			'STATE_UPDATE',
			'CLOSE',
			'SHARED_STATE_UPDATE',
			'INITIAL_STATE',
			'CONTROLLER_CONNECT',
			'CONTROLLER_DISCONNECT',
			'ERROR'
		];

		if (!validTypes.includes(packet.type)) {
			return false;
		}

		// Optional airport field validation
		if (packet.airport !== undefined && (typeof packet.airport !== 'string' || packet.airport.length === 0)) {
			return false;
		}

		// Optional timestamp validation
		if (packet.timestamp !== undefined && (typeof packet.timestamp !== 'number' || packet.timestamp < 0)) {
			return false;
		}

		// Type-specific validation
		switch (packet.type) {
			case 'STATE_UPDATE':
				return this.validateStateUpdatePacket(packet);
			case 'SHARED_STATE_UPDATE':
				return this.validateSharedStateUpdatePacket(packet);
			default:
				return true; // Other types are valid if they pass basic checks
		}
	}

	private validateStateUpdatePacket(packet: any): boolean {
		if (!packet.data || typeof packet.data !== 'object') {
			return false;
		}

		// Must have objectId
		if (!packet.data.objectId || typeof packet.data.objectId !== 'string') {
			return false;
		}

		// Must have either patch or state
		if (packet.data.patch === undefined && packet.data.state === undefined) {
			return false;
		}

		return true;
	}

	private validateSharedStateUpdatePacket(packet: any): boolean {
		if (!packet.data || typeof packet.data !== 'object') {
			return false;
		}

		// Must have sharedStatePatch
		if (!packet.data.sharedStatePatch || typeof packet.data.sharedStatePatch !== 'object') {
			return false;
		}

		return true;
	}

	private sanitizeInput(input: string): string {
		// Remove potentially dangerous characters and limit length
		return input.replace(/[<>'"&]/g, '').substring(0, 1000);
	}
}
