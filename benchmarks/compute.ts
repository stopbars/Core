import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { calculateDestinationPoint, calculateDistance, calculateHeading, generateEquidistantPoints } from '../src/services/bars/geoUtils';
import type { GeoPoint } from '../src/services/bars/types';
import { sanitizeContributionXml } from '../src/services/xml-sanitizer';

type Variant = {
	name: string;
	operationsPerSample: number;
	run: () => number;
};

type Summary = {
	name: string;
	samplesMs: number[];
	medianMs: number;
	minMs: number;
	operationsPerSecond: number;
	checksum: number;
};

const WARMUP_SAMPLES = 2;
const MEASURED_SAMPLES = 11;
// Mirrors the production XML 1.0 control-character filter being benchmarked.
// eslint-disable-next-line no-control-regex
const DISALLOWED_XML_CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]', 'g');

function runVariant(variant: Variant): Summary {
	const runSample = (): { elapsedMs: number; checksum: number } => {
		let checksum = 0;
		const started = performance.now();
		for (let index = 0; index < variant.operationsPerSample; index++) checksum += variant.run();
		return { elapsedMs: performance.now() - started, checksum };
	};

	for (let index = 0; index < WARMUP_SAMPLES; index++) runSample();
	const samples: number[] = [];
	let checksum = 0;
	for (let index = 0; index < MEASURED_SAMPLES; index++) {
		const sample = runSample();
		samples.push(sample.elapsedMs);
		checksum += sample.checksum;
	}
	const ordered = [...samples].sort((a, b) => a - b);
	const medianMs = ordered[Math.floor(ordered.length / 2)];
	return {
		name: variant.name,
		samplesMs: samples.map((sample) => Number(sample.toFixed(3))),
		medianMs: Number(medianMs.toFixed(3)),
		minMs: Number(ordered[0].toFixed(3)),
		operationsPerSecond: Math.round((variant.operationsPerSample * 1000) / medianMs),
		checksum,
	};
}

// Previous implementation: creates an array entry for every Unicode code point,
// filters it, then joins the whole document again.
function stripControlsArrayFrom(value: string): string {
	return Array.from(value)
		.filter((character) => {
			const code = character.charCodeAt(0);
			return !(code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f));
		})
		.join('');
}

// Alternative considered: scan once and concatenate only the valid slices.
function stripControlsManualSlices(value: string): string {
	let output = '';
	let sliceStart = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)) {
			if (sliceStart < index) output += value.slice(sliceStart, index);
			sliceStart = index + 1;
		}
	}
	if (sliceStart === 0) return value;
	return sliceStart < value.length ? output + value.slice(sliceStart) : output;
}

// Selected implementation in xml-sanitizer.ts.
function stripControlsRegex(value: string): string {
	return value.replace(DISALLOWED_XML_CONTROL_CHARS, '');
}

function generateEquidistantResetScan(points: GeoPoint[], interval: number): GeoPoint[] {
	if (points.length < 2) return points;
	if (interval <= 0) return points.map((point) => ({ ...point }));
	const segmentLengths = new Array<number>(points.length - 1);
	const segmentBearings = new Array<number>(points.length - 1);
	for (let index = 0; index < points.length - 1; index++) {
		segmentLengths[index] = calculateDistance(points[index], points[index + 1]);
		segmentBearings[index] = calculateHeading(points[index], points[index + 1]);
	}
	const totalPathLength = segmentLengths.reduce((sum, length) => sum + length, 0);
	if (totalPathLength === 0) return [{ ...points[0] }];
	const pointCount = Math.max(1, Math.floor(totalPathLength / interval) + 1);
	const startOffset = Math.max(0, (totalPathLength - (pointCount - 1) * interval) / 2);
	const result: GeoPoint[] = [];
	for (let outputIndex = 0; outputIndex < pointCount; outputIndex++) {
		const distance = Math.min(startOffset + outputIndex * interval, totalPathLength);
		if (distance <= 0) {
			result.push({ ...points[0] });
			continue;
		}
		let remaining = distance;
		let segmentIndex = 0;
		while (segmentIndex < segmentLengths.length) {
			const length = segmentLengths[segmentIndex];
			if (remaining <= length) {
				result.push(calculateDestinationPoint(points[segmentIndex], remaining, segmentBearings[segmentIndex]));
				break;
			}
			remaining -= length;
			segmentIndex++;
		}
	}
	return result;
}

// Alternative considered: cumulative lengths plus a binary search per output.
function generateEquidistantBinarySearch(points: GeoPoint[], interval: number): GeoPoint[] {
	if (points.length < 2) return points;
	if (interval <= 0) return points.map((point) => ({ ...point }));
	const segmentLengths = new Array<number>(points.length - 1);
	const segmentBearings = new Array<number>(points.length - 1);
	const cumulative = new Array<number>(points.length);
	cumulative[0] = 0;
	for (let index = 0; index < segmentLengths.length; index++) {
		segmentLengths[index] = calculateDistance(points[index], points[index + 1]);
		segmentBearings[index] = calculateHeading(points[index], points[index + 1]);
		cumulative[index + 1] = cumulative[index] + segmentLengths[index];
	}
	const totalPathLength = cumulative[cumulative.length - 1];
	if (totalPathLength === 0) return [{ ...points[0] }];
	const pointCount = Math.max(1, Math.floor(totalPathLength / interval) + 1);
	const startOffset = Math.max(0, (totalPathLength - (pointCount - 1) * interval) / 2);
	const result: GeoPoint[] = [];
	for (let outputIndex = 0; outputIndex < pointCount; outputIndex++) {
		const distance = Math.min(startOffset + outputIndex * interval, totalPathLength);
		let low = 0;
		let high = segmentLengths.length - 1;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (distance <= cumulative[middle + 1]) high = middle;
			else low = middle + 1;
		}
		result.push(calculateDestinationPoint(points[low], distance - cumulative[low], segmentBearings[low]));
	}
	return result;
}

function generateEquidistantHybrid(points: GeoPoint[], interval: number, maxBinarySegments: number): GeoPoint[] {
	if (points.length < 2) return points;
	if (interval <= 0) return points.map((point) => ({ ...point }));
	const segmentCount = points.length - 1;
	const segmentLengths = new Array<number>(segmentCount);
	const segmentBearings = new Array<number>(segmentCount);
	const useResetScan = segmentCount <= 32;
	const useBinarySearch = !useResetScan && segmentCount <= maxBinarySegments;
	const cumulative = useBinarySearch ? new Array<number>(points.length) : undefined;
	if (cumulative) cumulative[0] = 0;
	let totalPathLength = 0;
	for (let index = 0; index < segmentCount; index++) {
		const length = calculateDistance(points[index], points[index + 1]);
		segmentLengths[index] = length;
		segmentBearings[index] = calculateHeading(points[index], points[index + 1]);
		totalPathLength += length;
		if (cumulative) cumulative[index + 1] = totalPathLength;
	}
	if (totalPathLength === 0) return [{ ...points[0] }];
	const pointCount = Math.max(1, Math.floor(totalPathLength / interval) + 1);
	const startOffset = Math.max(0, (totalPathLength - (pointCount - 1) * interval) / 2);
	const result: GeoPoint[] = [];
	if (useResetScan) {
		for (let outputIndex = 0; outputIndex < pointCount; outputIndex++) {
			const distance = Math.min(startOffset + outputIndex * interval, totalPathLength);
			if (distance <= 0) {
				result.push({ ...points[0] });
				continue;
			}
			let remaining = distance;
			let segmentIndex = 0;
			while (segmentIndex < segmentCount - 1 && remaining > segmentLengths[segmentIndex]) {
				remaining -= segmentLengths[segmentIndex++];
			}
			result.push(calculateDestinationPoint(points[segmentIndex], remaining, segmentBearings[segmentIndex]));
		}
		return result;
	}
	if (cumulative) {
		for (let outputIndex = 0; outputIndex < pointCount; outputIndex++) {
			const distance = Math.min(startOffset + outputIndex * interval, totalPathLength);
			let low = 0;
			let high = segmentCount - 1;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (distance <= cumulative[middle + 1]) high = middle;
				else low = middle + 1;
			}
			result.push(calculateDestinationPoint(points[low], distance - cumulative[low], segmentBearings[low]));
		}
		return result;
	}
	let segmentIndex = 0;
	let segmentStartDistance = 0;
	for (let outputIndex = 0; outputIndex < pointCount; outputIndex++) {
		const distance = Math.min(startOffset + outputIndex * interval, totalPathLength);
		if (distance <= 0) {
			result.push({ ...points[0] });
			continue;
		}
		while (segmentIndex < segmentCount - 1 && distance - segmentStartDistance > segmentLengths[segmentIndex]) {
			segmentStartDistance += segmentLengths[segmentIndex++];
		}
		result.push(calculateDestinationPoint(points[segmentIndex], distance - segmentStartDistance, segmentBearings[segmentIndex]));
	}
	return result;
}

function assertPointsEquivalent(actual: GeoPoint[], expected: GeoPoint[]): number {
	assert.equal(actual.length, expected.length);
	let maxDeltaMeters = 0;
	for (let index = 0; index < actual.length; index++) {
		const deltaMeters = calculateDistance(actual[index], expected[index]);
		maxDeltaMeters = Math.max(maxDeltaMeters, deltaMeters);
		assert.ok(deltaMeters <= 0.2, `point differs by ${deltaMeters} meters at ${index}`);
	}
	return maxDeltaMeters;
}

const xmlNodes = Array.from({ length: 20_000 }, (_, index) => `<Node id="${index}">value-${index}\u0001🙂</Node>`).join('\n');
const dirtyXml = `  <?xml version="1.0"?>\n<?unsafe remove?>\n<FSData>${xmlNodes}</FSData>  `;
const trimmedXml = dirtyXml.trim().replace(/(<\?)(?!xml)([\s\S]*?\?>)/gi, '');
const expectedControls = stripControlsArrayFrom(trimmedXml);
assert.equal(stripControlsManualSlices(trimmedXml), expectedControls);
assert.equal(stripControlsRegex(trimmedXml), expectedControls);
assert.equal(sanitizeContributionXml(dirtyXml, { maxBytes: dirtyXml.length + 1 }), stripControlsRegex(trimmedXml).replace(/>\s+</g, '><'));

const makePath = (pointCount: number): GeoPoint[] =>
	Array.from({ length: pointCount }, (_, index) => ({
		lat: -31.94 + index * 0.000045 + Math.sin(index / 8) * 0.00001,
		lon: 115.96 + index * 0.00005,
	}));
const geometryScenarios = [
	{ name: 'short', points: makePath(16), interval: 11.25, operationsPerSample: 2_000 },
	{ name: 'medium', points: makePath(80), interval: 3, operationsPerSample: 1_000 },
	{ name: 'long', points: makePath(240), interval: 3, operationsPerSample: 400 },
	{ name: 'crossover', points: makePath(400), interval: 3, operationsPerSample: 200 },
	{ name: 'very-long', points: makePath(1_000), interval: 3, operationsPerSample: 50 },
];
let maxGeometryDeltaMeters = 0;
for (const scenario of geometryScenarios) {
	const expectedPoints = generateEquidistantResetScan(scenario.points, scenario.interval);
	maxGeometryDeltaMeters = Math.max(
		maxGeometryDeltaMeters,
		assertPointsEquivalent(generateEquidistantBinarySearch(scenario.points, scenario.interval), expectedPoints),
		assertPointsEquivalent(generateEquidistantPoints(scenario.points, scenario.interval), expectedPoints),
		assertPointsEquivalent(generateEquidistantHybrid(scenario.points, scenario.interval, 256), expectedPoints),
		assertPointsEquivalent(generateEquidistantHybrid(scenario.points, scenario.interval, 512), expectedPoints),
	);
}

const variants: Variant[] = [
	{ name: 'xml/array-from (before)', operationsPerSample: 20, run: () => stripControlsArrayFrom(trimmedXml).length },
	{ name: 'xml/manual-slices', operationsPerSample: 20, run: () => stripControlsManualSlices(trimmedXml).length },
	{ name: 'xml/regex (current)', operationsPerSample: 20, run: () => stripControlsRegex(trimmedXml).length },
	...geometryScenarios.flatMap(({ name, points, interval, operationsPerSample }) => [
		{
			name: `geometry/${name}/reset-scan (before)`,
			operationsPerSample,
			run: () => generateEquidistantResetScan(points, interval).length,
		},
		{
			name: `geometry/${name}/binary-search`,
			operationsPerSample,
			run: () => generateEquidistantBinarySearch(points, interval).length,
		},
		{
			name: `geometry/${name}/single-sweep (current)`,
			operationsPerSample,
			run: () => generateEquidistantPoints(points, interval).length,
		},
		{
			name: `geometry/${name}/hybrid-256`,
			operationsPerSample,
			run: () => generateEquidistantHybrid(points, interval, 256).length,
		},
		{
			name: `geometry/${name}/hybrid-512`,
			operationsPerSample,
			run: () => generateEquidistantHybrid(points, interval, 512).length,
		},
	]),
];

const summaries = variants.map(runVariant);
const byName = new Map(summaries.map((summary) => [summary.name, summary]));
const speedups = {
	xml: Number((byName.get('xml/array-from (before)')!.medianMs / byName.get('xml/regex (current)')!.medianMs).toFixed(2)),
	geometry: Number(
		(
			geometryScenarios.reduce(
				(total, scenario) => total + byName.get(`geometry/${scenario.name}/reset-scan (before)`)!.medianMs,
				0,
			) /
			geometryScenarios.reduce(
				(total, scenario) => total + byName.get(`geometry/${scenario.name}/single-sweep (current)`)!.medianMs,
				0,
			)
		).toFixed(2),
	),
};
const report = {
	generatedAt: new Date().toISOString(),
	runtime: process.version,
	warmupSamples: WARMUP_SAMPLES,
	measuredSamples: MEASURED_SAMPLES,
	fixtures: {
		xmlCharacters: dirtyXml.length,
		geometry: geometryScenarios.map(({ name, points, interval }) => ({ name, pathPoints: points.length, intervalMeters: interval })),
	},
	semanticEquality: {
		xmlExact: true,
		geometryToleranceMeters: 0.2,
		maxGeometryDeltaMeters,
	},
	speedups,
	results: summaries,
};

console.table(summaries.map(({ name, medianMs, minMs, operationsPerSecond }) => ({ name, medianMs, minMs, operationsPerSecond })));
console.log(JSON.stringify(report));
