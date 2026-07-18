import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

type SyncVariant = {
	name: string;
	iterations: number;
	run: () => unknown;
};

const measuredSamples = 11;

function checksum(value: unknown): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'string') return value.length;
	if (Array.isArray(value)) return value.length;
	if (value && typeof value === 'object') return Object.keys(value).length;
	return 0;
}

function benchmark(variants: SyncVariant[]): Array<Record<string, number | string>> {
	return variants.map((variant) => {
		for (let index = 0; index < Math.min(2_000, variant.iterations); index++) variant.run();
		const samples: number[] = [];
		let resultChecksum = 0;
		for (let sample = 0; sample < measuredSamples; sample++) {
			const startedAt = performance.now();
			for (let index = 0; index < variant.iterations; index++) resultChecksum += checksum(variant.run());
			samples.push(performance.now() - startedAt);
		}
		const ordered = samples.toSorted((left, right) => left - right);
		const medianMs = ordered[Math.floor(ordered.length / 2)];
		return {
			variant: variant.name,
			iterations: variant.iterations,
			medianMs: Number(medianMs.toFixed(3)),
			nsPerOperation: Number(((medianMs * 1_000_000) / variant.iterations).toFixed(1)),
			checksum: resultChecksum,
		};
	});
}

type ClientType = 'controller' | 'pilot' | 'observer';
type SocketInfo = { controllerId: string; type: ClientType; airport: string; readyState: number };
const openState = 1;
const socketEntries = Array.from({ length: 1_000 }, (_, index) => {
	const type: ClientType = index % 5 === 0 ? 'controller' : index % 7 === 0 ? 'observer' : 'pilot';
	return [
		{ id: index },
		{
			controllerId: `CID-${index % 220}`,
			type,
			airport: index < 900 ? 'YSSY' : 'YMML',
			readyState: openState,
		} satisfies SocketInfo,
	] as const;
});
const sockets = new Map(socketEntries);

function snapshotByScan() {
	const controllers: string[] = [];
	const pilots: string[] = [];
	const controllerIds = new Set<string>();
	const pilotIds = new Set<string>();
	for (const info of sockets.values()) {
		if (info.airport !== 'YSSY') continue;
		if (info.type === 'controller' && !controllerIds.has(info.controllerId)) {
			controllerIds.add(info.controllerId);
			controllers.push(info.controllerId);
		} else if (info.type === 'pilot' && !pilotIds.has(info.controllerId)) {
			pilotIds.add(info.controllerId);
			pilots.push(info.controllerId);
		}
	}
	return { controllers, pilots };
}

const indexedParticipants = new Map<string, { controllers: Map<string, number>; pilots: Map<string, number> }>();
for (const info of sockets.values()) {
	let airport = indexedParticipants.get(info.airport);
	if (!airport) {
		airport = { controllers: new Map(), pilots: new Map() };
		indexedParticipants.set(info.airport, airport);
	}
	const index = info.type === 'controller' ? airport.controllers : info.type === 'pilot' ? airport.pilots : null;
	if (index) index.set(info.controllerId, (index.get(info.controllerId) ?? 0) + 1);
}
function snapshotByIndex() {
	const airport = indexedParticipants.get('YSSY');
	return {
		controllers: airport ? Array.from(airport.controllers.keys()) : [],
		pilots: airport ? Array.from(airport.pilots.keys()) : [],
	};
}
assert.deepEqual(snapshotByIndex(), snapshotByScan());

function broadcastForEach() {
	let recipients = 0;
	sockets.forEach((info, socket) => {
		if (socket.id !== 1 && info.readyState === openState && info.airport === 'YSSY') recipients++;
	});
	return recipients;
}
function broadcastForOf() {
	let recipients = 0;
	for (const [socket, info] of sockets) {
		if (socket.id !== 1 && info.readyState === openState && info.airport === 'YSSY') recipients++;
	}
	return recipients;
}
assert.equal(broadcastForEach(), broadcastForOf());

const controllerSocketIndex = new Map<string, Set<{ id: number }>>();
for (const [socket, info] of sockets) {
	if (info.airport !== 'YSSY' || info.type !== 'controller') continue;
	let indexedSockets = controllerSocketIndex.get(info.controllerId);
	if (!indexedSockets) {
		indexedSockets = new Set();
		controllerSocketIndex.set(info.controllerId, indexedSockets);
	}
	indexedSockets.add(socket);
}
function controllerBroadcastByScan() {
	let recipients = 0;
	for (const [socket, info] of sockets) {
		if (socket.id !== 1 && info.readyState === openState && info.airport === 'YSSY' && info.type === 'controller') recipients++;
	}
	return recipients;
}
function controllerBroadcastByIndex() {
	let recipients = 0;
	for (const indexedSockets of controllerSocketIndex.values()) {
		for (const socket of indexedSockets) {
			if (socket.id !== 1) recipients++;
		}
	}
	return recipients;
}
assert.equal(controllerBroadcastByIndex(), controllerBroadcastByScan());

const packetTypes = [
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
] as const;
const packetTypeSet = new Set<string>(packetTypes);
const packetTypeRecord = Object.assign(Object.create(null) as Record<string, true>, Object.fromEntries(packetTypes.map((type) => [type, true])));
const packetTypeSamples: string[] = [...packetTypes, 'UNKNOWN', 'STATE_UPDATE', 'not-a-packet'];
const packetTypeSwitch = (type: string): boolean => {
	switch (type) {
		case 'HEARTBEAT':
		case 'HEARTBEAT_ACK':
		case 'STATE_UPDATE':
		case 'MULTI_STATE_UPDATE':
		case 'CLOSE':
		case 'SHARED_STATE_UPDATE':
		case 'INITIAL_STATE':
		case 'CONTROLLER_CONNECT':
		case 'CONTROLLER_DISCONNECT':
		case 'ERROR':
		case 'GET_STATE':
		case 'STATE_SNAPSHOT':
		case 'STOPBAR_CROSSING':
			return true;
		default:
			return false;
	}
};
for (const type of packetTypeSamples) {
	assert.equal(packetTypeSet.has(type), packetTypeSwitch(type));
	assert.equal(packetTypeRecord[type] === true, packetTypeSwitch(type));
}
let setTypeIndex = 0;
let recordTypeIndex = 0;
let switchTypeIndex = 0;

function recursiveSafeValue(value: unknown, maxDepth = 20, maxProperties = 100): boolean {
	const seen = new WeakSet<object>();
	const walk = (current: unknown, depth: number): boolean => {
		if (current === null || typeof current !== 'object') return true;
		if (Array.isArray(current)) return current.length <= 1_000 && current.every((item) => walk(item, depth + 1));
		if (depth > maxDepth || seen.has(current)) return false;
		seen.add(current);
		const keys = Object.keys(current as Record<string, unknown>);
		return keys.length <= maxProperties && keys.every((key) => key.length <= 100 && walk((current as Record<string, unknown>)[key], depth + 1));
	};
	return walk(value, 0);
}

function iterativeSafeValue(value: unknown, maxDepth = 20, maxProperties = 100): boolean {
	const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	const seen = new WeakSet<object>();
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (current.value === null || typeof current.value !== 'object') continue;
		if (current.depth > maxDepth || seen.has(current.value)) return false;
		seen.add(current.value);
		if (Array.isArray(current.value)) {
			if (current.value.length > 1_000) return false;
			for (let index = current.value.length - 1; index >= 0; index--) pending.push({ value: current.value[index], depth: current.depth + 1 });
			continue;
		}
		const record = current.value as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length > maxProperties) return false;
		for (const key of keys) {
			if (key.length > 100) return false;
			pending.push({ value: record[key], depth: current.depth + 1 });
		}
	}
	return true;
}
const nestedFixture = {
	profile: 'default',
	nodes: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`TWY_${index}`, (index & 1) === 0])),
	blocks: Array.from({ length: 30 }, (_, index) => ({ id: index, route: [`A${index}`, `B${index}`] })),
};
assert.equal(iterativeSafeValue(nestedFixture), recursiveSafeValue(nestedFixture));
let excessivelyNested: unknown = true;
for (let depth = 0; depth < 30; depth++) excessivelyNested = [excessivelyNested];
assert.equal(iterativeSafeValue(excessivelyNested), false);

const disallowedKeys = new Set(['__proto__', 'constructor', 'prototype']);
const nullObject = (): Record<string, unknown> => Object.create(null) as Record<string, unknown>;
function mergeWithEntryClone(target: unknown, source: unknown, depth = 0): unknown {
	if (depth > 20) throw new Error('depth');
	if (source === null || typeof source !== 'object') return source;
	if (Array.isArray(source)) return [...source];
	const sourceKeys = Object.keys(source);
	if (sourceKeys.length > 100) throw new Error('properties');
	const targetRecord = target !== null && typeof target === 'object' && !Array.isArray(target) ? (target as Record<string, unknown>) : undefined;
	let result = targetRecord ?? nullObject();
	let cloned = !targetRecord;
	const ensureClone = () => {
		if (cloned) return;
		const clone = nullObject();
		for (const [key, value] of Object.entries(targetRecord!)) clone[key] = value;
		result = clone;
		cloned = true;
	};
	for (const key of sourceKeys) {
		if (disallowedKeys.has(key)) throw new Error('key');
		const sourceValue = (source as Record<string, unknown>)[key];
		const targetValue = targetRecord?.[key];
		if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
			const merged = mergeWithEntryClone(targetValue, sourceValue, depth + 1);
			if (merged !== targetValue) {
				ensureClone();
				result[key] = merged;
			}
		} else {
			ensureClone();
			result[key] = sourceValue;
		}
	}
	return result;
}
function mergeWithAssignClone(target: unknown, source: unknown, depth = 0): unknown {
	if (depth > 20) throw new Error('depth');
	if (source === null || typeof source !== 'object') return source;
	if (Array.isArray(source)) return [...source];
	const sourceKeys = Object.keys(source);
	if (sourceKeys.length > 100) throw new Error('properties');
	const targetRecord = target !== null && typeof target === 'object' && !Array.isArray(target) ? (target as Record<string, unknown>) : undefined;
	let result = targetRecord ?? nullObject();
	let cloned = !targetRecord;
	const ensureClone = () => {
		if (cloned) return;
		result = Object.assign(nullObject(), targetRecord);
		cloned = true;
	};
	for (const key of sourceKeys) {
		if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('key');
		const sourceValue = (source as Record<string, unknown>)[key];
		const targetValue = targetRecord?.[key];
		if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
			const merged = mergeWithAssignClone(targetValue, sourceValue, depth + 1);
			if (merged !== targetValue) {
				ensureClone();
				result[key] = merged;
			}
		} else if (sourceValue !== targetValue) {
			ensureClone();
			result[key] = sourceValue;
		}
	}
	return result;
}
const mergeTarget = { profile: 'default', nodes: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`N${index}`, false])), untouched: { value: 1 } };
const mergePatch = { nodes: { N2: true, N17: true, N65: true }, sequence: ['A', 'B', 'C'] };
assert.deepEqual(mergeWithAssignClone(mergeTarget, mergePatch), mergeWithEntryClone(mergeTarget, mergePatch));

const sharedPatch = nestedFixture;
const sharedPacket = {
	type: 'SHARED_STATE_UPDATE',
	airport: 'YSSY',
	data: { sharedStatePatch: sharedPatch, controllerId: '1234567' },
	timestamp: 1_753_000_000_000,
};
function serializeSharedTwice() {
	const patchString = JSON.stringify(sharedPatch);
	return patchString.length + JSON.stringify(sharedPacket).length;
}
function serializeSharedOnce() {
	const patchString = JSON.stringify(sharedPatch);
	const packetString = `{"type":"SHARED_STATE_UPDATE","airport":"YSSY","data":{"sharedStatePatch":${patchString},"controllerId":"1234567"},"timestamp":1753000000000}`;
	return patchString.length + packetString.length;
}
assert.equal(serializeSharedOnce(), serializeSharedTwice());

const encodedPacket = new TextEncoder().encode(JSON.stringify(sharedPacket));
const sharedDecoder = new TextDecoder();
assert.equal(sharedDecoder.decode(encodedPacket), new TextDecoder().decode(encodedPacket));
const heartbeatPacket = { type: 'HEARTBEAT' };
const serializedHeartbeat = JSON.stringify(heartbeatPacket);
const connectRequest = new Request('https://api.stopbars.test/connect?airport=YSSY&key=BARS_test', {
	headers: { Authorization: 'Bearer BARS_test', Upgrade: 'websocket' },
});
function cloneConnectRequest() {
	const headers = new Headers(connectRequest.headers);
	headers.set('Authorization', 'Bearer BARS_test');
	return new Request(connectRequest.url, { method: connectRequest.method, headers, body: connectRequest.body });
}
assert.equal(cloneConnectRequest().url, connectRequest.url);

const dueInfo = { statusCheckInFlight: false, lastStatusCheck: 1_753_000_000_000 };
const dueNow = dueInfo.lastStatusCheck + 1_000;
async function statusDueAsync() {
	if (dueInfo.statusCheckInFlight || dueNow - dueInfo.lastStatusCheck < 120_000) return false;
	return true;
}
function statusDueSync() {
	return !(dueInfo.statusCheckInFlight || dueNow - dueInfo.lastStatusCheck < 120_000);
}
assert.equal(await statusDueAsync(), statusDueSync());

const analyticsEvents = [
	{
		event: 'ws_broadcast',
		properties: { distinct_id: 'anonymous', product: 'Core', airport: 'YSSY', messageType: 'STATE_UPDATE', recipients: 40 },
		$process_person_profile: false,
	},
	{
		event: 'ws_message',
		properties: {
			distinct_id: 'anonymous',
			product: 'Core',
			airport: 'YSSY',
			clientType: 'controller',
			messageType: 'STATE_UPDATE',
			objectId: 'SB1',
		},
		$process_person_profile: false,
	},
] as const;
function serializeAnalyticsSeparately() {
	return analyticsEvents.reduce(
		(total, event) => total + JSON.stringify({ api_key: 'ph_test', ...event }).length,
		0,
	);
}
function serializeAnalyticsBatch() {
	return JSON.stringify({ api_key: 'ph_test', batch: analyticsEvents }).length;
}
const separateAnalyticsPayloads = analyticsEvents.map((event) => JSON.parse(JSON.stringify({ api_key: 'ph_test', ...event })));
const batchAnalyticsPayload = JSON.parse(
	JSON.stringify({ api_key: 'ph_test', batch: analyticsEvents }),
) as { batch: typeof analyticsEvents };
assert.deepEqual(
	batchAnalyticsPayload.batch,
	separateAnalyticsPayloads.map((payload) => ({
		event: payload.event,
		properties: payload.properties,
		$process_person_profile: payload.$process_person_profile,
	})),
);

console.table(
	benchmark([
		{ name: 'snapshot/scan all sockets', iterations: 10_000, run: snapshotByScan },
		{ name: 'snapshot/maintained indexes', iterations: 10_000, run: snapshotByIndex },
		{ name: 'broadcast/Map.forEach', iterations: 10_000, run: broadcastForEach },
		{ name: 'broadcast/for-of', iterations: 10_000, run: broadcastForOf },
		{ name: 'controller broadcast/scan all', iterations: 10_000, run: controllerBroadcastByScan },
		{ name: 'controller broadcast/controller index', iterations: 10_000, run: controllerBroadcastByIndex },
		{
			name: 'packet type/Set.has',
			iterations: 1_000_000,
			run: () => packetTypeSet.has(packetTypeSamples[setTypeIndex++ % packetTypeSamples.length]),
		},
		{
			name: 'packet type/object lookup',
			iterations: 1_000_000,
			run: () => packetTypeRecord[packetTypeSamples[recordTypeIndex++ % packetTypeSamples.length]] === true,
		},
		{
			name: 'packet type/switch',
			iterations: 1_000_000,
			run: () => packetTypeSwitch(packetTypeSamples[switchTypeIndex++ % packetTypeSamples.length]),
		},
		{ name: 'nested validation/recursive', iterations: 20_000, run: () => recursiveSafeValue(nestedFixture) },
		{ name: 'nested validation/iterative', iterations: 20_000, run: () => iterativeSafeValue(nestedFixture) },
		{ name: 'merge/entry clone + Set keys', iterations: 50_000, run: () => mergeWithEntryClone(mergeTarget, mergePatch) },
		{ name: 'merge/assign clone + direct keys', iterations: 50_000, run: () => mergeWithAssignClone(mergeTarget, mergePatch) },
		{ name: 'shared packet/stringify patch twice', iterations: 20_000, run: serializeSharedTwice },
		{ name: 'shared packet/reuse patch JSON', iterations: 20_000, run: serializeSharedOnce },
		{ name: 'binary decode/new decoder', iterations: 50_000, run: () => new TextDecoder().decode(encodedPacket) },
		{ name: 'binary decode/shared decoder', iterations: 50_000, run: () => sharedDecoder.decode(encodedPacket) },
		{ name: 'heartbeat/JSON.stringify', iterations: 1_000_000, run: () => JSON.stringify(heartbeatPacket) },
		{ name: 'heartbeat/pre-serialized', iterations: 1_000_000, run: () => serializedHeartbeat },
		{ name: 'connect/clone headers + request', iterations: 20_000, run: cloneConnectRequest },
		{ name: 'connect/forward original request', iterations: 20_000, run: () => connectRequest },
		{ name: 'status due/async early return', iterations: 100_000, run: statusDueAsync },
		{ name: 'status due/synchronous guard', iterations: 100_000, run: statusDueSync },
		{ name: 'analytics/two capture payloads', iterations: 100_000, run: serializeAnalyticsSeparately },
		{ name: 'analytics/one batch payload', iterations: 100_000, run: serializeAnalyticsBatch },
	]),
);

console.log(
	JSON.stringify({
		semanticEquality: true,
		excessiveArrayDepthRejected: true,
		handshakeDatabaseCalls: { current: 2, combinedPrincipal: 1 },
		statusChecksForDuplicateCid: { current: 'one per socket', coalesced: 'one in-flight request per CID' },
		analyticsRequestsPerBroadcastMessage: { separateCaptures: 2, batched: 1 },
	}),
);
