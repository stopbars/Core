const baseUrl = (process.env.CORE_BASE_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, '');

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const request = async (path: string, init?: RequestInit): Promise<Response> => fetch(`${baseUrl}${path}`, init);

const percentile = (sorted: number[], fraction: number): number =>
	sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;

const measure = async (name: string, path: (iteration: number) => string, iterations = 20) => {
	const samples: number[] = [];
	for (let iteration = 0; iteration < iterations; iteration++) {
		const startedAt = performance.now();
		const response = await request(path(iteration));
		await response.arrayBuffer();
		assert(response.ok, `${name} returned ${response.status}`);
		samples.push(performance.now() - startedAt);
	}
	const sorted = samples.toSorted((left, right) => left - right);
	return {
		name,
		meanMs: Number((samples.reduce((sum, sample) => sum + sample, 0) / samples.length).toFixed(3)),
		p50Ms: Number(percentile(sorted, 0.5).toFixed(3)),
		p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
		p99Ms: Number(percentile(sorted, 0.99).toFixed(3)),
	};
};

const staticProbes: Array<[path: string, expectedStatus: number]> = [
	['/favicon.ico', 200],
	['/stateid/info.json', 200],
	['/state?airport=YBEN', 200],
	['/faqs', 200],
	['/health?service=database', 200],
	['/docs', 302],
];

for (const [path, expectedStatus] of staticProbes) {
	const response = await request(path, path === '/docs' ? { redirect: 'manual' } : undefined);
	await response.arrayBuffer();
	assert(response.status === expectedStatus, `${path} returned ${response.status}; expected ${expectedStatus}`);
}

const pointResponse = await request('/points?ids=P001,P002,P001,MISSING');
const pointPayload = (await pointResponse.json()) as {
	points: Array<{ id: string }>;
	requested: number;
	found: number;
	notFound?: string[];
};
assert(pointResponse.ok, `/points returned ${pointResponse.status}`);
assert(pointPayload.requested === 4 && pointPayload.found === 3, 'Bulk point counts changed');
assert(pointPayload.points.map((point) => point.id).join(',') === 'P001,P002,P001', 'Bulk point ordering changed');
assert(pointPayload.notFound?.join(',') === 'MISSING', 'Bulk point missing-ID behavior changed');

const probeToken = Date.now();
const latency = [
	await measure('points/100 IDs uncached', (iteration) => {
		const ids = Array.from({ length: 100 }, (_, index) => `P${String(index + 1).padStart(3, '0')}`).join(',');
		return `/points?ids=${ids}&probe=${probeToken}-${iteration}`;
	}),
	await measure('state/typed RPC uncached', (iteration) => `/state?airport=YBEN&probe=${probeToken}-${iteration}`),
	await measure('state-id/cached', () => '/stateid/info.json'),
];

const downloadIp = `2001:db8::${probeToken.toString(16)}`;
const downloadInit = { method: 'POST', headers: { 'CF-Connecting-IP': downloadIp } } satisfies RequestInit;
const firstDownload = await request('/download?product=Installer', downloadInit);
const firstDownloadPayload = (await firstDownload.json()) as { versionCount: number };
const secondDownload = await request('/download?product=Installer', downloadInit);
const secondDownloadPayload = (await secondDownload.json()) as { versionCount: number };
assert(firstDownload.ok && secondDownload.ok, 'Download smoke request failed');
assert(firstDownloadPayload.versionCount === secondDownloadPayload.versionCount, 'Duplicate download incremented the count');

const rateLimitIp = `2001:db8:1::${probeToken.toString(16)}`;
const rateLimitStatuses: number[] = [];
for (let requestNumber = 0; requestNumber < 31; requestNumber++) {
	const response = await request('/connect', { headers: { 'CF-Connecting-IP': rateLimitIp } });
	rateLimitStatuses.push(response.status);
	await response.arrayBuffer();
}
assert(rateLimitStatuses.slice(0, 30).every((status) => status === 400), 'Rate limiter rejected a request too early');
assert(rateLimitStatuses[30] === 429, 'Rate limiter did not reject request 31');

console.table(latency);
console.log(
	JSON.stringify({
		baseUrl,
		functionalProbes: staticProbes.length + 3,
		bulkPointOrdering: true,
		duplicateDownloadSuppression: true,
		rateLimit: { allowed: 30, rejectedStatus: rateLimitStatuses[30] },
	}),
);
