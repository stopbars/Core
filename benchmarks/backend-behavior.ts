import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { CacheService, withCache } from '../src/services/cache';
import { ContactService } from '../src/services/contact';
import { ContributionService, type Contribution } from '../src/services/contributions';
import { StorageService } from '../src/services/storage';
import { VatsimService } from '../src/services/vatsim';

mock.module('cloudflare:workers', () => ({
	DurableObject: class {},
	waitUntil: () => undefined,
}));

class FakeCache {
	readonly entries = new Map<string, Response>();
	matchCalls: string[] = [];
	putCalls: string[] = [];

	async match(request: Request): Promise<Response | undefined> {
		this.matchCalls.push(request.url);
		return this.entries.get(request.url)?.clone();
	}

	async put(request: Request, response: Response): Promise<void> {
		this.putCalls.push(request.url);
		this.entries.set(request.url, response.clone());
	}

	async delete(request: Request): Promise<boolean> {
		return this.entries.delete(request.url);
	}
}

const fakeCache = new FakeCache();
Object.defineProperty(globalThis, 'caches', {
	configurable: true,
	value: { default: fakeCache },
});

const originalDateNow = Date.now;
let currentTime = 1_000_000;
Date.now = () => currentTime;
try {
	const namespace = `backend-behavior-${crypto.randomUUID()}`;
	const cache = new CacheService({} as Env);
	const misses = await Promise.all(Array.from({ length: 100 }, (_, index) => cache.getResponse(`missing-${index}`, namespace)));
	assert(misses.every((value) => value === null));
	assert.equal(fakeCache.matchCalls.filter((url) => url.includes('/__version/')).length, 1);
	assert.equal(fakeCache.matchCalls.filter((url) => url.includes(`/${namespace}/v1/`)).length, 100);

	await cache.getResponse('another-miss', namespace);
	assert.equal(fakeCache.matchCalls.filter((url) => url.includes('/__version/')).length, 1, 'fresh hints avoid marker reads');

	currentTime += 5_001;
	await cache.getResponse('after-revalidation-window', namespace);
	assert.equal(fakeCache.matchCalls.filter((url) => url.includes('/__version/')).length, 2, 'stale hints revalidate');

	const nextVersion = await cache.bumpNamespaceVersion(namespace);
	assert.equal(nextVersion, 2);
	await cache.set('versioned-hit', { ok: true }, { namespace });
	assert.deepEqual(await cache.get<{ ok: boolean }>('versioned-hit', namespace), { ok: true });
	assert(fakeCache.putCalls.some((url) => url.includes(`/${namespace}/v2/versioned-hit`)));

	const xmlNamespace = `xml-behavior-${crypto.randomUUID()}`;
	const middleware = withCache(() => 'latest-map', 60, xmlNamespace);
	const background: Promise<unknown>[] = [];
	let handlerCalls = 0;
	const makeContext = () => ({
		req: { method: 'GET', raw: new Request('https://api.stopbars.test/maps/YSSY/latest') },
		env: {} as Env,
		res: new Response(null),
		header: () => undefined,
		executionCtx: { waitUntil: (promise: Promise<unknown>) => void background.push(promise) },
	});
	const firstContext = makeContext();
	await middleware(firstContext as never, async () => {
		handlerCalls += 1;
		firstContext.res = new Response('<Map/>', { headers: { 'Content-Type': 'application/xml' } });
	});
	await Promise.all(background.splice(0));
	const secondContext = makeContext();
	const cachedXml = await middleware(secondContext as never, async () => {
		handlerCalls += 1;
	});
	assert(cachedXml instanceof Response);
	assert.equal(await cachedXml.text(), '<Map/>');
	assert.equal(cachedXml.headers.get('X-Cache'), 'HIT');
	assert.equal(handlerCalls, 1, 'XML responses must be served from Cache API after the first request');
} finally {
	Date.now = originalDateNow;
}

const originalFetch = globalThis.fetch;
let connectionFetches = 0;
globalThis.fetch = (async () => {
	connectionFetches += 1;
	await Promise.resolve();
	return new Response('1234567,YSSY_TWR,atc');
}) as typeof fetch;
try {
	const vatsim = new VatsimService('client', 'secret');
	const [status, csv] = await Promise.all([vatsim.getUserStatus('1234567'), vatsim.getUserConnectionsCsv('1234567')]);
	assert.deepEqual(status, { cid: '1234567', callsign: 'YSSY_TWR', type: 'atc' });
	assert.equal(csv, '1234567,YSSY_TWR,atc');
	assert.equal(vatsim.isController(status), true);
	assert.equal(vatsim.isController({ callsign: 'YSSY_APP_TWR', type: 'atc' }), true);
	assert.equal(vatsim.isController({ callsign: 'YSSY_', type: 'atc' }), false);
	assert.equal(vatsim.isObserver({ callsign: 'YSSY_OBS', type: 'atc' }), true);
	assert.equal(connectionFetches, 1, 'concurrent status consumers must share one upstream request');
	await vatsim.getUserStatus('1234567');
	assert.equal(connectionFetches, 2, 'completed requests are not cached or made stale');
	assert.equal(await vatsim.getUserStatus('invalid'), null);
	assert.equal(connectionFetches, 2);
} finally {
	globalThis.fetch = originalFetch;
}

const rangeRequests: Array<{ key: string; options?: R2GetOptions }> = [];
const fakeBucket = {
	get: async (key: string, options?: R2GetOptions) => {
		rangeRequests.push({ key, options });
		const ranged = Boolean(options?.range);
		return {
			body: new Response(ranged ? '2345' : '0123456789').body,
			size: 10,
			etag: 'etag-value',
			httpEtag: '"etag-value"',
			range: ranged ? { offset: 2, length: 4, suffix: undefined } : undefined,
			writeHttpMetadata: (headers: Headers) => {
				headers.set('Content-Type', 'application/octet-stream');
				headers.set('Cache-Control', 'public, max-age=60');
			},
		};
	},
} as unknown as R2Bucket;
const storage = new StorageService(fakeBucket);
const ranged = await storage.getFile('/large.bin', new Headers({ Range: 'bytes=2-5' }));
assert(ranged);
assert.equal(rangeRequests[0].key, 'large.bin');
assert(rangeRequests[0].options?.range instanceof Headers);
assert.equal(ranged.status, 206);
assert.equal(ranged.headers.get('Content-Range'), 'bytes 2-5/10');
assert.equal(ranged.headers.get('Content-Length'), '4');
assert.equal(ranged.headers.get('ETag'), '"etag-value"');
assert.equal(await ranged.text(), '2345');
const full = await storage.getFile('large.bin');
assert(full);
assert.equal(rangeRequests[1].options, undefined);
assert.equal(full.status, 200);
assert.equal(await full.text(), '0123456789');

const worker = (await import('../src/index')).default;
const routeResponse = await worker.fetch(
	new Request('https://api.stopbars.test/cdn/files/maps/YSSY.xml', { headers: { Range: 'bytes=2-5' } }),
	{ BARS_STORAGE: fakeBucket } as Env,
	{ waitUntil: () => undefined } as unknown as ExecutionContext,
);
assert.equal(routeResponse.status, 206);
assert.equal(rangeRequests.at(-1)?.key, 'maps/YSSY.xml', 'named Hono route must preserve nested R2 keys');
assert.equal(routeResponse.headers.get('Content-Range'), 'bytes 2-5/10');
assert.equal(await routeResponse.text(), '2345');

const queries: Array<{ query: string; params: unknown[] }> = [];
const queuedResults: unknown[][] = [];
const fakeDb = {
	withSession: () => ({
		prepare: (query: string) => {
			let params: unknown[] = [];
			const statement = {
				bind: (...values: unknown[]) => {
					params = values;
					return statement;
				},
				all: async () => {
					queries.push({ query, params });
					return { results: queuedResults.shift() ?? [], success: true, meta: {} };
				},
				run: async () => {
					queries.push({ query, params });
					return { results: queuedResults.shift() ?? [], success: true, meta: {} };
				},
			};
			return statement;
		},
		getBookmark: () => null,
	}),
} as unknown as D1Database;
const contributions = new ContributionService(fakeDb, {} as never, '', {} as R2Bucket);
queuedResults.push([{ packageName: 'Sydney Ground', simulator: 'msfs2024' }]);
assert.deepEqual(await contributions.getLatestApprovedMapDescriptor('YSSY', 'Sydney Ground', 'msfs2024'), {
	packageName: 'Sydney Ground',
	simulator: 'msfs2024',
});
assert(!queries[0].query.includes('submitted_xml'));
assert(!queries[0].query.includes('datetime(c.decision_date)'));
assert(queries[0].query.includes('ORDER BY c.decision_date DESC'));

const contribution: Contribution = {
	id: 'contribution-id',
	userId: '7654321',
	userDisplayName: 'Submitter',
	airportIcao: 'YSSY',
	packageName: 'Sydney Ground',
	submittedXml: '<FSData/>',
	notes: null,
	simulator: 'msfs2024',
	submissionDate: '2026-07-19T00:00:00.000Z',
	status: 'pending',
	rejectionReason: null,
	decisionDate: null,
};
queuedResults.push([{ ...contribution, actorIsProductManager: 1 }]);
type ContributionInternals = {
	getContributionActionContext(
		vatsimId: string,
		contributionId: string,
	): Promise<{ isProductManager: boolean; contribution: Contribution | null } | null>;
};
const actionContext = await (contributions as unknown as ContributionInternals).getContributionActionContext(
	'1234567',
	'contribution-id',
);
assert.deepEqual(actionContext, { isProductManager: true, contribution });
assert.equal(queries.length, 2, 'actor and contribution context must use one D1 query');
assert(queries[1].query.includes('LEFT JOIN contributions c ON c.id = ?'));

queuedResults.push([{ id: null, actorIsProductManager: 0 }]);
assert.deepEqual(
	await (contributions as unknown as ContributionInternals).getContributionActionContext('1234567', 'missing'),
	{ isProductManager: false, contribution: null },
);
queuedResults.push([]);
assert.equal(
	await (contributions as unknown as ContributionInternals).getContributionActionContext('missing-user', 'contribution-id'),
	null,
);

const contact = new ContactService(fakeDb);
queuedResults.push([{ id: 'contact-id' }]);
assert.equal(await contact.deleteMessage('contact-id'), true);
assert(queries.at(-1)?.query.includes('DELETE FROM contact_messages WHERE id = ? RETURNING id'));
queuedResults.push([]);
assert.equal(await contact.deleteMessage('missing-contact'), false);

console.log(
	JSON.stringify({
		cacheCoalescing: 'passed',
		cacheRevalidation: 'passed',
		xmlCache: 'passed',
		vatsimCoalescing: 'passed',
		r2Range: 'passed',
		nestedCdnRoute: 'passed',
		contributionQueryShape: 'passed',
		returningDelete: 'passed',
	}),
);
