import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { AirportService, parseAirportCreateInput, parseAirportUpdateInput, type AirportRecord } from '../src/services/airport';
import { AuthService } from '../src/services/auth';
import { CacheService, withCache } from '../src/services/cache';
import { ContactService } from '../src/services/contact';
import { ContributionService, type Contribution } from '../src/services/contributions';
import { StorageService } from '../src/services/storage';
import { VatsimService } from '../src/services/vatsim';

mock.module('cloudflare:workers', () => ({
	DurableObject: class {},
	waitUntil: () => undefined,
}));

const parsedAirport = parseAirportCreateInput({
	icao: ' yxyz ',
	latitude: -31.25,
	longitude: 115.75,
	name: 'New Test Airport',
	continent: 'oc',
	country_code: 'au',
	elevation_ft: 100,
	runways: [
		{
			length_ft: 5000,
			width_ft: '150',
			le_ident: '09',
			le_latitude_deg: -31.26,
			le_longitude_deg: 115.7,
			he_ident: '27',
			he_latitude_deg: -31.24,
			he_longitude_deg: 115.8,
		},
	],
});
assert.equal(parsedAirport.icao, 'YXYZ');
assert.equal(parsedAirport.continent, 'OC');
assert.equal(parsedAirport.country_code, 'AU');
assert.equal(parsedAirport.elevation_m, 30.48);
assert.equal(parsedAirport.runways[0].length_ft, '5000');
assert.throws(() => parseAirportUpdateInput({ bbox_min_lat: -31 }), /All four bounding-box fields must be supplied together/);
assert.throws(() => parseAirportUpdateInput({ icao: 'YSSY' }), /Unknown or immutable field: icao/);
assert.throws(
	() =>
		parseAirportUpdateInput({
			runways: [
				{
					length_ft: 5000,
					width_ft: 150,
					le_ident: '09',
					le_latitude_deg: -31,
					le_longitude_deg: 115,
					he_ident: '27',
					he_latitude_deg: -31.1,
					he_longitude_deg: 115.1,
					typo: true,
				},
			],
		}),
	/Unknown field: runways\[0\]\.typo/,
);
assert.throws(
	() =>
		parseAirportCreateInput({
			icao: 'YXYZ',
			latitude: 91,
			longitude: 115.75,
			name: 'Invalid Airport',
			continent: 'OC',
		}),
	/latitude must be a number between -90 and 90/,
);

interface FakeAirportStatement {
	query: string;
	params: unknown[];
}

const airportBatches: FakeAirportStatement[][] = [];
const airportRow: AirportRecord = {
	icao: 'YXYZ',
	latitude: -31.25,
	longitude: 115.75,
	name: 'New Test Airport',
	continent: 'OC',
	country_code: 'AU',
	country_name: null,
	region_name: null,
	elevation_ft: 100,
	elevation_m: 30.48,
	bbox_min_lat: null,
	bbox_min_lon: null,
	bbox_max_lat: null,
	bbox_max_lon: null,
};
const airportReadRow: AirportRecord = {
	...airportRow,
	country_name: 'Australia',
	region_name: 'Western Australia',
	bbox_min_lat: -31.3,
	bbox_min_lon: 115.6,
	bbox_max_lat: -31.2,
	bbox_max_lon: 115.9,
};
const fakeAirportDb = {
	withSession: () => ({
		prepare: (query: string) => {
			let params: unknown[] = [];
			const statement = {
				query,
				get params() {
					return params;
				},
				bind: (...values: unknown[]) => {
					params = values;
					return statement;
				},
			};
			return statement;
		},
		batch: async (statements: FakeAirportStatement[]) => {
			airportBatches.push(statements.map((statement) => ({ query: statement.query, params: statement.params })));
			return statements.map((statement, index) => {
				let results: unknown[] = [];
				if (statement.query.includes('SELECT id') && statement.query.includes('FROM division_airports')) {
					results = [{ id: 42 }];
				} else if (index === 0) {
					results = statement.query.trimStart().startsWith('SELECT')
						? [{ ...airportReadRow, ...(statement.query.includes(') AS id') ? { id: 42 } : {}) }]
						: [airportRow];
				} else if (statement.query.includes('SELECT length_ft')) {
					results = parsedAirport.runways;
				}
				return { success: true, results, meta: {} };
			});
		},
		getBookmark: () => null,
	}),
} as unknown as D1Database;
const airportService = new AirportService(fakeAirportDb, '');
assert.deepEqual(await airportService.createAirport(parsedAirport), { ...airportRow, runways: parsedAirport.runways });
assert.equal(airportBatches.length, 1, 'airport and runways should be created in one D1 batch');
assert.equal(airportBatches[0].length, 2);
assert(airportBatches[0][1].query.includes('WHERE EXISTS'));

const parsedUpdate = parseAirportUpdateInput({ name: 'Renamed Airport', elevation_ft: 200, runways: [] });
const updatedAirport = await airportService.updateAirport('YXYZ', parsedUpdate);
assert.equal(updatedAirport.name, airportRow.name);
assert.equal(airportBatches.length, 2, 'airport patch and runway replacement should use one D1 batch');
assert(airportBatches[1][0].query.includes('UPDATE airports SET name = ?, elevation_ft = ?, elevation_m = ?'));
assert(airportBatches[1].some((statement) => statement.query.includes('DELETE FROM runways')));
assert(airportBatches[1].some((statement) => statement.query.includes('SELECT length_ft')));

const fetchedAirport = await airportService.getAirport('YXYZ');
assert.equal(fetchedAirport?.id, 42, 'ICAO airport lookup should expose the approved division airport ID');
assert.equal(airportBatches.length, 3);
assert(airportBatches[2].some((statement) => statement.query.includes("status = 'approved'")));
const fetchedAirports = await airportService.getAirports(['YXYZ']);
assert.equal((fetchedAirports.YXYZ as { id: number }).id, 42, 'batch ICAO lookups should expose the same numeric ID');

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

const deleteQueryStart = queries.length;
queuedResults.push([
	{
		id: 'delete-id',
		userId: '1234567',
		status: 'pending',
		simulator: 'msfs2024',
		actorIsProductManager: 0,
	},
]);
queuedResults.push([]);
assert.equal(await contributions.deleteContribution('delete-id', '1234567'), true);
const deleteQueries = queries.slice(deleteQueryStart);
assert.equal(deleteQueries.length, 2, 'delete authorization and mutation should use two D1 statements');
assert(!deleteQueries[0].query.includes('submitted_xml'), 'delete authorization must not transfer contribution XML');

type AuthInternals = {
	fetchLoginState(vatsimId: string): Promise<unknown>;
};
const auth = new AuthService(fakeDb, new VatsimService('client', 'secret'));
queuedResults.push([]);
await assert.rejects(
	() => (auth as unknown as AuthInternals).fetchLoginState('1234567'),
	/Failed to load login state/,
	'an impossible empty anchor result should fail with an explicit invariant error',
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
