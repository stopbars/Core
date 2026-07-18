import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import type { AirportState, ClientType, Packet } from '../src/types';
import type { AuthService } from '../src/services/auth';
import type { VatsimService } from '../src/services/vatsim';

const cloudflareBackground: Promise<unknown>[] = [];
mock.module('cloudflare:workers', () => ({
	waitUntil: (promise: Promise<unknown>) => void cloudflareBackground.push(promise),
}));
const { Connection } = await import('../src/network/connection');
const { PostHogService } = await import('../src/services/posthog');

class FakeSocket {
	readyState = WebSocket.OPEN;
	sent: string[] = [];
	closed?: { code?: number; reason?: string };

	send(value: string) {
		this.sent.push(value);
	}

	close(code?: number, reason?: string) {
		this.readyState = WebSocket.CLOSED;
		this.closed = { code, reason };
	}
}

class FakeDurableObjectState {
	readonly id = { toString: () => '0000000000000000000000000000000000000000000000000000000000000000' };
	readonly values = new Map<string, unknown>();
	readonly background: Promise<unknown>[] = [];
	initialization: Promise<unknown> = Promise.resolve();
	readonly storage = {
		list: async <T>({ prefix }: { prefix: string }): Promise<Map<string, T>> =>
			new Map(
				Array.from(this.values.entries()).filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>,
			),
		put: async (key: string, value: unknown) => void this.values.set(key, value),
		delete: async (key: string) => this.values.delete(key),
	};

	blockConcurrencyWhile(callback: () => Promise<unknown>) {
		this.initialization = callback();
		return this.initialization;
	}

	waitUntil(promise: Promise<unknown>) {
		this.background.push(promise);
	}
}

type InternalSocketInfo = {
	controllerId: string;
	type: ClientType;
	airport: string;
	lastHeartbeat: number;
	lastStatusCheck: number;
	statusCheckInFlight: boolean;
	consecutiveVatsimFailures: number;
	sendFailures: number;
};

type ConnectionInternals = {
	sockets: Map<WebSocket, InternalSocketInfo>;
	airportStates: Map<string, AirportState>;
	offlineStateCache: Map<
		string,
		{
			template?: Array<{ id: string; state: boolean }>;
			defaultStates?: ReadonlyMap<string, boolean>;
			expiresAt: number;
		}
	>;
	registerSocket(socket: WebSocket, info: { controllerId: string; type: ClientType; airport: string; lastHeartbeat: number }): void;
	unregisterSocket(socket: WebSocket): InternalSocketInfo | undefined;
	validatePacket(packet: unknown): packet is Packet;
	broadcast(packet: Packet, sender?: WebSocket, trackAnalytics?: boolean): number;
	broadcastToControllers(packet: Packet, sender?: WebSocket, trackAnalytics?: boolean): number;
	trackMessage(
		details: { clientType: ClientType; messageType: Packet['type']; airport: string; meta?: Record<string, unknown> },
		broadcastRecipients?: number,
	): void;
	posthog: {
		track(event: string, properties: Record<string, unknown>): void;
		trackBatch(events: readonly { event: string; properties?: Record<string, unknown> }[]): void;
	};
	handleMultiStateUpdate(
		packet: Packet,
		controllerId: string,
		connectionAirport: string,
	): Promise<{ updates: unknown[]; timestamp: number; airport: string }>;
	handleSharedStateUpdate(packet: Packet, controllerId: string, connectionAirport: string): Promise<Record<string, unknown>>;
	checkSocketStatus(socket: WebSocket, socketInfo: InternalSocketInfo, now: number): Promise<void> | undefined;
	enqueueSocketTask(socket: WebSocket, task: () => Promise<void>): Promise<void>;
	flushAirportDurableState(airport: string): Promise<void>;
};

let banChecks = 0;
let vatsimChecks = 0;
const fakeAuth = {
	isVatsimIdBanned: async () => {
		banChecks++;
		await Promise.resolve();
		return false;
	},
} as unknown as AuthService;
const fakeVatsim = {
	getUserStatus: async (controllerId: string) => {
		vatsimChecks++;
		await Promise.resolve();
		return { cid: controllerId, callsign: 'YSSY_TWR', type: 'atc' };
	},
	isController: (status: { type: string }) => status.type === 'atc',
	isPilot: (status: { type: string }) => status.type === 'pilot',
	isObserver: () => false,
} as unknown as VatsimService;
const fakeState = new FakeDurableObjectState();
const fakeEnv = { DB: {}, POSTHOG_HOST: 'https://example.invalid' } as unknown as Env;
const connection = new Connection(fakeEnv, fakeAuth, fakeVatsim, fakeState as unknown as DurableObjectState);
await fakeState.initialization;
const internal = connection as unknown as ConnectionInternals;
const analyticsSingles: Array<{ event: string; properties: Record<string, unknown> }> = [];
const analyticsBatches: Array<readonly { event: string; properties?: Record<string, unknown> }[]> = [];
internal.posthog = {
	track: (event, properties) => void analyticsSingles.push({ event, properties }),
	trackBatch: (events) => void analyticsBatches.push(events),
};

const template = [
	{ id: 'SB1', state: false },
	{ id: 'LO1', state: true },
];
internal.offlineStateCache.set('YSSY', {
	template,
	defaultStates: new Map(template.map((point) => [point.id, point.state])),
	expiresAt: Date.now() + 60_000,
});

const controllerA = new FakeSocket();
const controllerB = new FakeSocket();
const pilotA = new FakeSocket();
const pilotADuplicate = new FakeSocket();
const observer = new FakeSocket();
const now = Date.now();
internal.registerSocket(controllerA as unknown as WebSocket, {
	controllerId: '1000001',
	type: 'controller',
	airport: 'YSSY',
	lastHeartbeat: now,
});
internal.registerSocket(controllerB as unknown as WebSocket, {
	controllerId: '1000002',
	type: 'controller',
	airport: 'YSSY',
	lastHeartbeat: now,
});
for (const socket of [pilotA, pilotADuplicate]) {
	internal.registerSocket(socket as unknown as WebSocket, {
		controllerId: '2000001',
		type: 'pilot',
		airport: 'YSSY',
		lastHeartbeat: now,
	});
}
internal.registerSocket(observer as unknown as WebSocket, {
	controllerId: '3000001',
	type: 'observer',
	airport: 'YSSY',
	lastHeartbeat: now,
});

const indexedSnapshot = await connection.getState('YSSY');
assert.deepEqual(indexedSnapshot.controllers, ['1000001', '1000002']);
assert.deepEqual(indexedSnapshot.pilots, ['2000001']);
assert.equal(indexedSnapshot.offline, false);

const broadcastRecipients = internal.broadcast(
	{ type: 'STATE_UPDATE', airport: 'YSSY', data: { objectId: 'SB1', state: true } },
	controllerA as unknown as WebSocket,
	false,
);
internal.trackMessage(
	{ clientType: 'controller', messageType: 'STATE_UPDATE', airport: 'YSSY', meta: { objectId: 'SB1' } },
	broadcastRecipients,
);
assert.equal(controllerA.sent.length, 0);
assert.equal(controllerB.sent.length, 1);
assert.equal(pilotA.sent.length, 1);
assert.equal(pilotADuplicate.sent.length, 1);
assert.equal(observer.sent.length, 1);
assert.equal(broadcastRecipients, 4);
assert.deepEqual(
	analyticsBatches[0].map((event) => event.event),
	['ws_broadcast', 'ws_message'],
);
assert.equal(analyticsSingles.length, 0);

for (const socket of [controllerA, controllerB, pilotA, pilotADuplicate, observer]) socket.sent.length = 0;
const controllerRecipients = internal.broadcastToControllers(
	{ type: 'STOPBAR_CROSSING', airport: 'YSSY', data: { objectId: 'SB1' } },
	pilotA as unknown as WebSocket,
	false,
);
internal.trackMessage(
	{ clientType: 'pilot', messageType: 'STOPBAR_CROSSING', airport: 'YSSY', meta: { objectId: 'SB1' } },
	controllerRecipients,
);
assert.equal(controllerA.sent.length, 1);
assert.equal(controllerB.sent.length, 1);
assert.equal(pilotA.sent.length, 0);
assert.equal(observer.sent.length, 0);
assert.equal(controllerRecipients, 2);
assert.equal(analyticsBatches.length, 2);

const validPackets: Packet[] = [
	{ type: 'HEARTBEAT' },
	{ type: 'GET_STATE' },
	{ type: 'STATE_UPDATE', data: { objectId: 'SB1', state: true } },
	{ type: 'STATE_UPDATE', data: { objectId: 'SB1', patch: { nested: { enabled: true } } } },
	{ type: 'MULTI_STATE_UPDATE', data: { updates: [{ objectId: 'SB1', state: true }] } },
	{ type: 'SHARED_STATE_UPDATE', data: { sharedStatePatch: { profile: 'default' } } },
	{ type: 'STOPBAR_CROSSING', data: { objectId: 'SB1' } },
];
for (const packet of validPackets) assert.equal(internal.validatePacket(packet), true);

let deepArray: unknown = true;
for (let depth = 0; depth < 30; depth++) deepArray = [deepArray];
const invalidPackets: unknown[] = [
	{ type: 'UNKNOWN' },
	{ type: 'STATE_UPDATE', data: { objectId: 'invalid id', state: true } },
	{ type: 'STATE_UPDATE', data: { objectId: 'SB1', patch: [] } },
	{ type: 'STATE_UPDATE', data: { objectId: 'SB1', patch: { constructor: {} } } },
	{ type: 'MULTI_STATE_UPDATE', data: { updates: [] } },
	{ type: 'SHARED_STATE_UPDATE', data: { sharedStatePatch: [] } },
	{ type: 'SHARED_STATE_UPDATE', data: { sharedStatePatch: { nested: deepArray } } },
	{ type: 'STOPBAR_CROSSING', data: { objectId: 'invalid id' } },
];
for (const packet of invalidPackets) assert.equal(internal.validatePacket(packet), false);

await internal.handleMultiStateUpdate(
	{
		type: 'MULTI_STATE_UPDATE',
		data: { updates: [{ objectId: 'SB1', state: true }, { objectId: 'LO1', state: false }] },
	},
	'1000001',
	'YSSY',
);
assert.equal(internal.airportStates.get('YSSY')?.objects.get('SB1')?.state, true);
assert.equal(internal.airportStates.get('YSSY')?.objects.get('LO1')?.state, false);

for (const socket of [controllerA, controllerB, pilotA, pilotADuplicate, observer]) socket.sent.length = 0;
const sharedState = await internal.handleSharedStateUpdate(
	{
		type: 'SHARED_STATE_UPDATE',
		data: { sharedStatePatch: { profile: 'default', nodes: { A1: true } } },
	},
	'1000001',
	'YSSY',
);
assert.deepEqual(sharedState, { profile: 'default', nodes: { A1: true } });
for (const socket of [controllerA, controllerB, pilotA, pilotADuplicate, observer]) {
	assert.equal(socket.sent.length, 1);
	assert.deepEqual(JSON.parse(socket.sent[0]), {
		type: 'SHARED_STATE_UPDATE',
		airport: 'YSSY',
		data: { sharedStatePatch: { profile: 'default', nodes: { A1: true } }, controllerId: '1000001' },
		timestamp: JSON.parse(socket.sent[0]).timestamp,
	});
}

const firstStatus = internal.checkSocketStatus(controllerA as unknown as WebSocket, internal.sockets.get(controllerA as unknown as WebSocket)!, now + 180_000);
const secondStatus = internal.checkSocketStatus(controllerB as unknown as WebSocket, internal.sockets.get(controllerB as unknown as WebSocket)!, now + 180_000);
assert(firstStatus && secondStatus);
await Promise.all([firstStatus, secondStatus]);
assert.equal(banChecks, 2, 'Different CIDs must be checked independently');
assert.equal(vatsimChecks, 2, 'Different CIDs must be checked independently');

const duplicateController = new FakeSocket();
internal.registerSocket(duplicateController as unknown as WebSocket, {
	controllerId: '1000001',
	type: 'controller',
	airport: 'YSSY',
	lastHeartbeat: now,
});
const beforeBanChecks = banChecks;
const beforeVatsimChecks = vatsimChecks;
const duplicateStatus = internal.checkSocketStatus(
	duplicateController as unknown as WebSocket,
	internal.sockets.get(duplicateController as unknown as WebSocket)!,
	now + 360_000,
);
const originalStatus = internal.checkSocketStatus(
	controllerA as unknown as WebSocket,
	internal.sockets.get(controllerA as unknown as WebSocket)!,
	now + 360_000,
);
assert(duplicateStatus && originalStatus);
await Promise.all([duplicateStatus, originalStatus]);
assert.equal(banChecks - beforeBanChecks, 1);
assert.equal(vatsimChecks - beforeVatsimChecks, 1);

const queueOrder: number[] = [];
const firstQueued = internal.enqueueSocketTask(pilotA as unknown as WebSocket, async () => {
	await Promise.resolve();
	queueOrder.push(1);
});
const secondQueued = internal.enqueueSocketTask(pilotA as unknown as WebSocket, async () => void queueOrder.push(2));
await Promise.all([firstQueued, secondQueued]);
assert.deepEqual(queueOrder, [1, 2]);

internal.unregisterSocket(pilotA as unknown as WebSocket);
assert.deepEqual((await connection.getState('YSSY')).pilots, ['2000001']);
internal.unregisterSocket(pilotADuplicate as unknown as WebSocket);
assert.deepEqual((await connection.getState('YSSY')).pilots, []);

await internal.flushAirportDurableState('YSSY');
await Promise.allSettled(fakeState.background);
assert(fakeState.values.has('airport_state:YSSY'));
assert(fakeState.values.has('airport_shared_state:YSSY'));

const originalFetch = globalThis.fetch;
let capturedBatchRequest: { input: RequestInfo | URL; init?: RequestInit } | undefined;
try {
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		capturedBatchRequest = { input, init };
		return new Response(null, { status: 200 });
	};
	const posthog = new PostHogService({
		POSTHOG_API_KEY: 'ph_test',
		POSTHOG_HOST: 'https://analytics.example.test',
	} as Env);
	posthog.trackBatch([
		{ event: 'ws_broadcast', properties: { airport: 'YSSY', recipients: 4 } },
		{ event: 'ws_message', properties: { airport: 'YSSY', messageType: 'STATE_UPDATE' } },
	]);
	await Promise.all(cloudflareBackground.splice(0));
} finally {
	globalThis.fetch = originalFetch;
}
assert(capturedBatchRequest);
assert.equal(String(capturedBatchRequest.input), 'https://analytics.example.test/batch/');
const capturedBatchBody = JSON.parse(String(capturedBatchRequest.init?.body)) as {
	api_key: string;
	batch: Array<{ event: string; properties: Record<string, unknown>; $process_person_profile: boolean }>;
};
assert.equal(capturedBatchBody.api_key, 'ph_test');
assert.deepEqual(
	capturedBatchBody.batch.map((event) => event.event),
	['ws_broadcast', 'ws_message'],
);
assert(capturedBatchBody.batch.every((event) => event.properties.product === 'Core'));
assert(capturedBatchBody.batch.every((event) => event.properties.distinct_id === 'anonymous'));
assert(capturedBatchBody.batch.every((event) => event.$process_person_profile === false));

console.log(
	JSON.stringify({
		protocolPacketsValidated: validPackets.length + invalidPackets.length,
		indexedParticipantSnapshot: true,
		broadcastRouting: true,
		sharedStateSerialization: true,
		analyticsBatching: true,
		statusCheckCoalescing: true,
		perSocketQueueOrdering: true,
		persistence: true,
	}),
);
