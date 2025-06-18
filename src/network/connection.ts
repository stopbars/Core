import { ClientType, Packet, AirportState, AirportObject, HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT, Point } from '../types';
import { AuthService } from '../services/auth';
import { VatsimService } from '../services/vatsim';
import { StatsService } from '../services/stats';
import { PointsService } from '../services/points';
import { IDService } from '../services/id';
import { DivisionService } from '../services/divisions';

// Add recursive merge utility function
function recursivelyMergeObjects(target: any, source: any): any {
	if (source === null || typeof source !== 'object') {
		return source; // Return the source value if it's a primitive
	}

	// Handle arrays - replace the entire array
	if (Array.isArray(source)) {
		return [...source];
	}

	// Handle objects - merge properties
	const result = { ...target };

	for (const key in source) {
		if (Object.prototype.hasOwnProperty.call(source, key)) {
			if (
				typeof source[key] === 'object' &&
				source[key] !== null &&
				!Array.isArray(source[key]) &&
				Object.prototype.hasOwnProperty.call(result, key) &&
				typeof result[key] === 'object' &&
				result[key] !== null
			) {
				// Recursively merge nested objects
				result[key] = recursivelyMergeObjects(result[key], source[key]);
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

		await this.state.storage.put('airport_states', serialized);

		// Persist shared states
		const sharedStatesSerialized = Object.fromEntries(this.airportSharedStates.entries());
		await this.state.storage.put('airport_shared_states', sharedStatesSerialized);
	}

	private async broadcast(packet: Packet, sender?: WebSocket) {
		const airport = packet.airport;
		if (!airport) return;

		const promises: Promise<void>[] = [];

		this.sockets.forEach((client, socket) => {
			if (socket !== sender && socket.readyState === WebSocket.OPEN && client.airport === airport) {
				promises.push(
					new Promise((resolve) => {
						socket.send(JSON.stringify(packet));
						resolve();
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

	private handleStateUpdate(packet: Packet, controllerId: string) {
		if (!packet.airport || !packet.data?.objectId || (packet.data.patch === undefined && packet.data.state === undefined)) return;

		const now = Date.now();
		const state = this.getOrCreateAirportState(packet.airport);
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
			// Apply patch using recursive merge
			newState = recursivelyMergeObjects(typeof existingObject.state === 'object' ? existingObject.state : {}, packet.data.patch);
		} else {
			// Legacy direct state update
			newState = packet.data.state;
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
				socket.send(
					JSON.stringify({
						type: 'HEARTBEAT',
						// Server will handle timestamp
					}),
				);
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
			if (!socketInfo) return;

			try {
				const packet: Packet = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));

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
						break; case 'STATE_UPDATE':
						if (clientType === 'pilot') {
							server.send(
								JSON.stringify({
									type: 'ERROR',
									data: { message: 'Pilots cannot send state updates' },
									timestamp: Date.now(),
								}),
							);
							return;
						}
						if (clientType === 'observer') {
							server.send(
								JSON.stringify({
									type: 'ERROR',
									data: { message: 'Observers cannot send state updates' },
									timestamp: Date.now(),
								}),
							);
							return;
						}
						const timestamp = await this.handleStateUpdate(packet, user.vatsim_id);
						// Add timestamp to packet before broadcasting
						// We forward the exact same packet (state or patch) to all clients to maintain consistency
						const broadcastPacket = {
							...packet,
							timestamp,
						};
						await this.broadcast(broadcastPacket, server);
						await this.trackMessage(clientType);
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
							server.send(
								JSON.stringify({
									type: 'ERROR',
									data: { message: 'Only controllers can send shared state updates' },
									timestamp: Date.now(),
								}),
							);
							return;
						}
						this.handleSharedStateUpdate(packet, user.vatsim_id);
						break;

					default:
						// Pilots can only send heartbeats and CLOSE
						if (clientType === 'pilot' && !['HEARTBEAT_ACK', 'CLOSE'].includes(packet.type)) {
							server.send(
								JSON.stringify({
									type: 'ERROR',
									data: { message: 'Pilots cannot send this type of message' },
									timestamp: Date.now(),
								}),
							);
						}
				}
			} catch (error) {
				console.error('Error handling message:', error);
				// Don't close the connection for parsing errors, just notify the client
				server.send(
					JSON.stringify({
						type: 'ERROR',
						data: { message: 'Invalid message format' },
						timestamp: Date.now(),
					}),
				);
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

	private handleSharedStateUpdate(packet: Packet, controllerId: string) {
		if (!packet.airport || !packet.data?.sharedStatePatch) return;

		const airport = packet.airport;
		const patch = packet.data.sharedStatePatch;

		// Get current shared state
		const currentState = this.getOrCreateSharedState(airport);

		// Apply recursive merge
		const updatedState = recursivelyMergeObjects(currentState, patch);

		// Update the stored state
		this.airportSharedStates.set(airport, updatedState);

		// Persist to storage
		this.persistState();

		// Broadcast to all clients (including sender)
		this.broadcastSharedState(airport, patch, controllerId);

		return updatedState;
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
						socket.send(JSON.stringify(packet));
						resolve();
					}),
				);
			}
		});

		await Promise.all(promises);
	}

	private getSharedStateSnapshot(airport: string): Record<string, any> {
		return this.getOrCreateSharedState(airport);
	}
}
