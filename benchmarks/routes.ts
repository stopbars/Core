import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Hono } from 'hono';

type Variant<T> = { name: string; iterations: number; run: () => T | Promise<T> };

async function benchmark<T>(variants: Variant<T>[]): Promise<Array<Record<string, number | string>>> {
	const rows: Array<Record<string, number | string>> = [];
	for (const variant of variants) {
		for (let index = 0; index < Math.min(2_000, variant.iterations); index++) await variant.run();
		const samples: number[] = [];
		for (let sample = 0; sample < 11; sample++) {
			const started = performance.now();
			for (let index = 0; index < variant.iterations; index++) await variant.run();
			samples.push(performance.now() - started);
		}
		samples.sort((a, b) => a - b);
		const medianMs = samples[5];
		rows.push({
			variant: variant.name,
			iterations: variant.iterations,
			medianMs: Number(medianMs.toFixed(3)),
			nsPerOperation: Number(((medianMs * 1_000_000) / variant.iterations).toFixed(1)),
		});
	}
	return rows;
}

const request = new Request('https://api.stopbars.test/airports/YSSY/points?q=1');
const pathname = '/airports/YSSY/points';
assert.equal(new URL(request.url).pathname, pathname);

const icaoRegex = /^[A-Z0-9]{4}$/;
assert.equal(Boolean('YSSY'.match(icaoRegex)), icaoRegex.test('YSSY'));

const template = Array.from({ length: 4_000 }, (_, index) => ({ id: `BARS_${index}`, state: (index & 1) === 0 }));
const updates = Array.from({ length: 200 }, (_, index) => ({ objectId: `BARS_${index * 17}`, state: (index & 1) === 0 }));
const defaultStates = new Map(template.map((point) => [point.id, point.state]));
const pruneWithFind = () =>
	updates.filter((update) => template.find((point) => point.id === update.objectId)?.state === update.state).length;
const pruneWithMap = () => updates.filter((update) => defaultStates.get(update.objectId) === update.state).length;
assert.equal(pruneWithFind(), pruneWithMap());

const stateObjects = new Map(
	template.map((point, index) => [
		point.id,
		{ id: point.id, state: point.state, controllerId: `controller-${index % 12}`, timestamp: 1_750_000_000_000 + index },
	]),
);
type PersistedObject = { id: string; state: boolean; controllerId: string; timestamp: number };
const persistWithIntermediates = () =>
	Object.fromEntries(
		Array.from(stateObjects.entries()).map(([id, object]) => [
			id,
			{ id: object.id, state: object.state, controllerId: object.controllerId, timestamp: object.timestamp },
		]),
	);
const persistDirectly = () => {
	const result: Record<string, PersistedObject> = Object.create(null) as Record<string, PersistedObject>;
	for (const [id, object] of stateObjects) {
		result[id] = {
			id: object.id,
			state: object.state,
			controllerId: object.controllerId,
			timestamp: object.timestamp,
		};
	}
	return result;
};
assert.equal(JSON.stringify(persistDirectly()), JSON.stringify(persistWithIntermediates()));

const packet = { type: 'MULTI_STATE_UPDATE', airport: 'YSSY', data: { updates } };
const typedState = { airport: 'YSSY', objects: updates, offline: false };
const doFetchEnvelope = async () => {
	const internalRequest = new Request('https://internal/state?airport=YSSY', { headers: { 'X-Request-Type': 'get_state' } });
	const airport = new URL(internalRequest.url).searchParams.get('airport');
	return Response.json({ ...typedState, airport }).json();
};
assert.deepEqual(await doFetchEnvelope(), typedState);

const oneMiddlewareApp = new Hono();
oneMiddlewareApp.use('*', async (_context, next) => next());
oneMiddlewareApp.get('/health', (context) => context.json({ ok: true }));

const threeMiddlewareApp = new Hono();
for (let index = 0; index < 3; index++) threeMiddlewareApp.use('*', async (_context, next) => next());
threeMiddlewareApp.get('/health', (context) => context.json({ ok: true }));

const results = await benchmark([
	{ name: 'path/new URL', iterations: 100_000, run: () => new URL(request.url).pathname },
	{ name: 'path/Hono pre-parsed', iterations: 100_000, run: () => pathname },
	{ name: 'ICAO/String.match', iterations: 100_000, run: () => 'YSSY'.match(icaoRegex) },
	{ name: 'ICAO/RegExp.test', iterations: 100_000, run: () => icaoRegex.test('YSSY') },
	{ name: 'defaults/Array.find x200', iterations: 2_000, run: pruneWithFind },
	{ name: 'defaults/Map.get x200', iterations: 2_000, run: pruneWithMap },
	{ name: 'packet/redundant stringify', iterations: 20_000, run: () => JSON.stringify(packet).length <= 50_000 },
	{ name: 'packet/pre-checked raw length', iterations: 20_000, run: () => true },
	{ name: 'persist/intermediate arrays', iterations: 1_000, run: persistWithIntermediates },
	{ name: 'persist/direct assignment', iterations: 1_000, run: persistDirectly },
	{ name: 'DO/fetch JSON envelope', iterations: 5_000, run: doFetchEnvelope },
	{ name: 'DO/typed RPC result', iterations: 5_000, run: () => typedState },
	{
		name: 'Hono/one async middleware',
		iterations: 10_000,
		run: async () => (await oneMiddlewareApp.request('https://bench.test/health')).body?.cancel(),
	},
	{
		name: 'Hono/three async middleware',
		iterations: 10_000,
		run: async () => (await threeMiddlewareApp.request('https://bench.test/health')).body?.cancel(),
	},
]);

console.table(results);
