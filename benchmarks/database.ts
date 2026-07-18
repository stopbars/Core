import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

type PointRow = { id: string; airportId: string; name: string };
type DownloadCounts = { versionCount: number; productTotal: number };

class FakeD1 {
	public calls = 0;
	public readonly points = new Map<string, PointRow>();
	public readonly faqOrder = new Map<string, number>();
	public readonly downloads = new Map<string, number>();

	constructor() {
		for (let i = 0; i < 200; i += 1) {
			const id = `BARS_${String(i).padStart(5, '0')}`;
			this.points.set(id, { id, airportId: `Y${String(i % 10).padStart(3, '0')}`, name: `Point ${i}` });
		}
		for (let i = 0; i < 50; i += 1) this.faqOrder.set(`faq-${i}`, i);
		this.downloads.set('Installer@1.0.0', 7);
		this.downloads.set('Installer@0.9.0', 3);
	}

	private transportCost(): void {
		// Fixed work makes the benchmark deterministic while representing per-call
		// binding/serialization overhead. It is intentionally not wall-clock sleep.
		let state = 0x9e3779b9;
		for (let i = 0; i < 12_000; i += 1) state = Math.imul(state ^ i, 1664525) + 1013904223;
		if (state === 0) throw new Error('unreachable');
	}

	async call<T>(operation: () => T): Promise<T> {
		this.calls += 1;
		this.transportCost();
		return operation();
	}

	async batch<T>(operations: Array<() => T>): Promise<T[]> {
		return this.call(() => operations.map((operation) => operation()));
	}
}

const requestedIds = [
	...Array.from({ length: 98 }, (_, index) => `BARS_${String(index).padStart(5, '0')}`),
	'BARS_00007', // duplicate: order and duplicates must be preserved
	'BARS_99999', // missing: null position must be preserved
];

async function pointsSequential(db: FakeD1): Promise<Array<PointRow | null>> {
	const rows: Array<PointRow | null> = [];
	for (const id of requestedIds) rows.push(await db.call(() => db.points.get(id) ?? null));
	return rows;
}

async function pointsConcurrent(db: FakeD1): Promise<Array<PointRow | null>> {
	return Promise.all(requestedIds.map((id) => db.call(() => db.points.get(id) ?? null)));
}

async function pointsInQuery(db: FakeD1): Promise<Array<PointRow | null>> {
	const unique = [...new Set(requestedIds)];
	const rows = await db.call(() => unique.flatMap((id) => (db.points.has(id) ? [db.points.get(id)!] : [])));
	const byId = new Map(rows.map((row) => [row.id, row]));
	return requestedIds.map((id) => byId.get(id) ?? null);
}

async function faqSequential(db: FakeD1): Promise<number[]> {
	for (let i = 0; i < 50; i += 1) await db.call(() => db.faqOrder.set(`faq-${i}`, 49 - i));
	return [...db.faqOrder.values()];
}

async function faqBatch(db: FakeD1): Promise<number[]> {
	await db.batch(Array.from({ length: 50 }, (_, i) => () => db.faqOrder.set(`faq-${i}`, 49 - i)));
	return [...db.faqOrder.values()];
}

async function airportSeparate(db: FakeD1): Promise<{ airport: PointRow | null; runways: string[] }> {
	const airport = await db.call(() => db.points.get('BARS_00001') ?? null);
	const runways = await db.call(() => ['01/19', '09/27']);
	return { airport, runways };
}

async function airportBatch(db: FakeD1): Promise<{ airport: PointRow | null; runways: string[] }> {
	const [airport, runways] = await db.batch([() => db.points.get('BARS_00001') ?? null, () => ['01/19', '09/27']]);
	return { airport: airport as PointRow | null, runways: runways as string[] };
}

async function downloadLegacy(db: FakeD1): Promise<DownloadCounts> {
	const key = 'Installer@1.0.0';
	await db.call(() => db.downloads.has(key)); // ensure row
	await db.call(() => null); // read IP hit
	await db.call(() => true); // insert/update IP hit
	const versionCount = await db.call(() => {
		const count = (db.downloads.get(key) ?? 0) + 1;
		db.downloads.set(key, count);
		return count;
	});
	await db.call(() => true); // expired-hit cleanup
	const productTotal = await db.call(() => [...db.downloads.values()].reduce((sum, count) => sum + count, 0));
	return { versionCount, productTotal };
}

async function downloadBatched(db: FakeD1): Promise<DownloadCounts> {
	const key = 'Installer@1.0.0';
	await db.batch([() => db.downloads.has(key), () => true, () => db.downloads.get(key) ?? 0]);
	const [versionCount] = await db.batch([
		() => {
			const count = (db.downloads.get(key) ?? 0) + 1;
			db.downloads.set(key, count);
			return count;
		},
		() => true,
	]);
	return {
		versionCount: versionCount as number,
		productTotal: [...db.downloads.values()].reduce((sum, count) => sum + count, 0),
	};
}

type Variant<T> = { name: string; run: (db: FakeD1) => Promise<T> };

async function benchmarkGroup<T>(variants: Variant<T>[]): Promise<Array<Record<string, number | string>>> {
	const expected = await variants[0].run(new FakeD1());
	for (const variant of variants.slice(1)) assert.deepEqual(await variant.run(new FakeD1()), expected, `${variant.name} changed results`);

	for (const variant of variants) {
		for (let i = 0; i < 20; i += 1) await variant.run(new FakeD1());
	}

	const rows: Array<Record<string, number | string>> = [];
	for (const variant of variants) {
		const timings: number[] = [];
		let calls = 0;
		for (let i = 0; i < 100; i += 1) {
			const db = new FakeD1();
			const start = performance.now();
			await variant.run(db);
			timings.push(performance.now() - start);
			calls = db.calls;
		}
		timings.sort((a, b) => a - b);
		rows.push({
			variant: variant.name,
			calls,
			p50Ms: Number(timings[50].toFixed(3)),
			p95Ms: Number(timings[95].toFixed(3)),
		});
	}
	return rows;
}

const results = [
	...(await benchmarkGroup([
		{ name: 'points: sequential first()', run: pointsSequential },
		{ name: 'points: concurrent first()', run: pointsConcurrent },
		{ name: 'points: one IN query', run: pointsInQuery },
	])),
	...(await benchmarkGroup([
		{ name: 'FAQ reorder: sequential writes', run: faqSequential },
		{ name: 'FAQ reorder: D1 batch', run: faqBatch },
	])),
	...(await benchmarkGroup([
		{ name: 'airport: separate airport/runway reads', run: airportSeparate },
		{ name: 'airport: read batch', run: airportBatch },
	])),
	...(await benchmarkGroup([
		{ name: 'download: legacy fresh-hit path', run: downloadLegacy },
		{ name: 'download: batched upsert path', run: downloadBatched },
	])),
];

console.table(results);
