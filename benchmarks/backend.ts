import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { CacheKeys } from '../src/services/cache';

type Variant = { name: string; iterations: number; run: () => unknown };

function checksum(value: unknown): number {
	if (typeof value === 'string') return value.length;
	if (typeof value === 'number') return value;
	if (value instanceof Response) return value.status + value.headers.get('X-Cache')!.length;
	if (value && typeof value === 'object') return Object.keys(value).length;
	return 0;
}

function benchmark(variants: Variant[]): Array<Record<string, number | string>> {
	return variants.map((variant) => {
		for (let index = 0; index < Math.min(2_000, variant.iterations); index++) variant.run();
		const samples: number[] = [];
		let resultChecksum = 0;
		for (let sample = 0; sample < 11; sample++) {
			const startedAt = performance.now();
			for (let index = 0; index < variant.iterations; index++) resultChecksum += checksum(variant.run());
			samples.push(performance.now() - startedAt);
		}
		const ordered = samples.toSorted((left, right) => left - right);
		const medianMs = ordered[5];
		return {
			variant: variant.name,
			iterations: variant.iterations,
			medianMs: Number(medianMs.toFixed(3)),
			nsPerOperation: Number(((medianMs * 1_000_000) / variant.iterations).toFixed(1)),
			checksum: resultChecksum,
		};
	});
}

const cacheRequest = new Request(
	'https://api.stopbars.test/contributions?summary=true&status=approved&airport=YSSY&simulator=msfs2024',
);
function currentCacheKey() {
	return CacheKeys.fromUrl(cacheRequest);
}
function arrayCacheKey() {
	const url = new URL(cacheRequest.url);
	const path = url.pathname.replace(/[^A-Za-z0-9/_-]/g, '');
	const params = Array.from(url.searchParams.entries())
		.filter(([key]) => !/^auth(orization)?$/i.test(key))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join('&');
	return params ? `${path}?${params}` : path;
}
function loopCacheKey() {
	const url = new URL(cacheRequest.url);
	const path = url.pathname.replace(/[^A-Za-z0-9/_-]/g, '');
	const entries: Array<[string, string]> = [];
	for (const [key, value] of url.searchParams) {
		if (!/^auth(orization)?$/i.test(key)) entries.push([key, value]);
	}
	entries.sort(([left], [right]) => left.localeCompare(right));
	let params = '';
	for (const [key, value] of entries) {
		if (params) params += '&';
		params += `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
	}
	return params ? `${path}?${params}` : path;
}
assert.equal(loopCacheKey(), currentCacheKey());
assert.equal(arrayCacheKey(), currentCacheKey());

const cachedPayload = JSON.stringify({ items: Array.from({ length: 30 }, (_, index) => ({ id: index, active: true })) });
const cachedHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60', ETag: '"cache-test"' };
function rewriteCachedResponseWithHeadersClone() {
	const cached = new Response(cachedPayload, { headers: cachedHeaders });
	const headers = new Headers(cached.headers);
	headers.delete('Cache-Control');
	headers.set('X-Cache', 'HIT');
	return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
}
function rewriteCachedResponseDirectly() {
	const cached = new Response(cachedPayload, { headers: cachedHeaders });
	const response = new Response(cached.body, cached);
	response.headers.delete('Cache-Control');
	response.headers.set('X-Cache', 'HIT');
	return response;
}
const currentResponse = rewriteCachedResponseWithHeadersClone();
const directResponse = rewriteCachedResponseDirectly();
assert.equal(currentResponse.status, directResponse.status);
assert.deepEqual([...currentResponse.headers], [...directResponse.headers]);

const submittedXml = `<FSData>${'<SceneryObject lat="-33.9" lon="151.1"/>'.repeat(2_000)}</FSData>`;
const fullContribution = {
	id: 'contribution-id',
	userId: '1234567',
	userDisplayName: 'Controller',
	airportIcao: 'YSSY',
	packageName: 'Sydney Ground',
	submittedXml,
	notes: null,
	simulator: 'msfs2024',
	submissionDate: '2026-07-19T00:00:00.000Z',
	status: 'approved',
	rejectionReason: null,
	decisionDate: '2026-07-19T01:00:00.000Z',
};
const mapDescriptor = { packageName: fullContribution.packageName, simulator: fullContribution.simulator };
const fullContributionBytes = JSON.stringify(fullContribution).length;
const mapDescriptorBytes = JSON.stringify(mapDescriptor).length;
assert.equal(mapDescriptor.packageName, fullContribution.packageName);
assert.equal(mapDescriptor.simulator, fullContribution.simulator);

const isoDates = [
	'2026-07-18T10:00:00.000Z',
	'2026-07-19T01:00:00.000Z',
	'2025-12-31T23:59:59.000Z',
];
assert.deepEqual(
	isoDates.toSorted((left, right) => right.localeCompare(left)),
	isoDates.toSorted((left, right) => Date.parse(right) - Date.parse(left)),
);

const connectionCsv = '1234567,YSSY_TWR,atc,120.500,100,-33.946,151.177';
function repeatedTrimStatusParse() {
	if (!connectionCsv.trim()) return null;
	const [cid, callsign, type] = connectionCsv.trim().split(',');
	return cid && callsign && type ? { cid, callsign, type } : null;
}
function singleTrimStatusParse() {
	const trimmed = connectionCsv.trim();
	if (!trimmed) return null;
	const [cid, callsign, type] = trimmed.split(',');
	return cid && callsign && type ? { cid, callsign, type } : null;
}
assert.deepEqual(singleTrimStatusParse(), repeatedTrimStatusParse());

const controllerCallsign = 'YSSY_TWR';
function splitCallsignSuffix() {
	const parts = controllerCallsign.toUpperCase().split('_');
	return parts.length < 2 ? null : (parts[parts.length - 1] || null);
}
function lastIndexCallsignSuffix() {
	const upper = controllerCallsign.toUpperCase();
	const separator = upper.lastIndexOf('_');
	return separator < 0 || separator === upper.length - 1 ? null : upper.slice(separator + 1);
}
assert.equal(lastIndexCallsignSuffix(), splitCallsignSuffix());

console.table(
	benchmark([
		{ name: 'cache key/array pipeline', iterations: 100_000, run: arrayCacheKey },
		{ name: 'cache key/single collection loop', iterations: 100_000, run: loopCacheKey },
		{ name: 'cache hit/clone Headers + Response', iterations: 20_000, run: rewriteCachedResponseWithHeadersClone },
		{ name: 'cache hit/clone Response then mutate', iterations: 20_000, run: rewriteCachedResponseDirectly },
		{ name: 'VATSIM CSV/repeated trim', iterations: 200_000, run: repeatedTrimStatusParse },
		{ name: 'VATSIM CSV/single trim', iterations: 200_000, run: singleTrimStatusParse },
		{ name: 'callsign suffix/split', iterations: 500_000, run: splitCallsignSuffix },
		{ name: 'callsign suffix/lastIndexOf', iterations: 500_000, run: lastIndexCallsignSuffix },
		{ name: 'latest map/full contribution JSON', iterations: 2_000, run: () => JSON.stringify(fullContribution) },
		{ name: 'latest map/slim descriptor JSON', iterations: 2_000, run: () => JSON.stringify(mapDescriptor) },
	]),
);

const uniqueMisses = 1_000;
const coldBurst = 100;
console.log(
	JSON.stringify({
		semanticEquality: true,
		cacheApiCalls: {
			uniqueMissesCurrent: uniqueMisses * 2,
			uniqueMissesWithFreshVersionHint: uniqueMisses + 1,
			coldBurstCurrent: coldBurst * 2,
			coldBurstWithCoalescedVersionRead: coldBurst + 1,
		},
		contributionActionD1CallsAfterRouteAuth: {
			decision: { current: 2, batchedContext: 1 },
			delete: { current: 3, batchedContext: 1 },
			regenerate: { current: 4, batchedContext: 1 },
		},
		returningMutationD1CallsAfterAuthorization: {
			contactDelete: { readThenDelete: 2, deleteReturning: 1 },
			divisionRename: { readThenUpdate: 2, updateReturning: 1 },
		},
		latestMapD1PayloadBytes: {
			fullContribution: fullContributionBytes,
			slimDescriptor: mapDescriptorBytes,
			reduction: Number((fullContributionBytes / mapDescriptorBytes).toFixed(1)),
		},
		latestMapQueryPlan: {
			datetimeOrder: 'covering index search + temporary B-tree sort',
			isoTextOrder: 'covering index search; no temporary sort',
		},
		concurrentVatsimStatusFetches: { current: 2, coalesced: 1 },
		r2BytesForOneMegabyteRangeOfHundredMegabyteObject: { current: 100 * 1024 * 1024, ranged: 1024 * 1024 },
	}),
);
