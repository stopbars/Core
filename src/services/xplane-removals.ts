export interface XPlaneDsfSelector {
	kind: 'dsf-string' | 'dsf-object';
	source: string;
	sha256: string;
	definition: string;
	command: number;
	pool: number;
	filter: number;
	index: number;
}

export interface XPlaneRemovalSelector {
	feature: string;
	code: number;
	run: number;
	ranges: Array<[number, number]>;
}

export interface XPlaneRemovalArtifact {
	schema: 'bars-xplane-removals/v1' | 'bars-xplane-removals/v2';
	dsfSelectors?: XPlaneDsfSelector[];
	icao: string;
	selectors: XPlaneRemovalSelector[];
}

const FEATURE_PATTERN = /^[a-f0-9]{16}$/i;
const XPLANE_LIGHT_CODES = new Set([101, 102, 103, 104, 105, 106, 107, 108]);
const FRACTION_BOUNDARY_TOLERANCE = 0.00001;
const MAX_XPLANE_REMOVAL_ELEMENTS = 20_000;
const MAX_XPLANE_XML_CHARS = 5 * 1024 * 1024;
const MAX_TAG_CHARS = 2_048;
const TAG_PATTERN = /<(?:[^>"']|"[^"]*"|'[^']*')+>/g;
const ATTRIBUTE_PATTERN = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

/**
 * Parse the compact X-Plane removal section without accepting partial or
 * ambiguously quoted attributes. The scanner is deliberately bounded because
 * contribution XML is user-controlled and executes inside a Worker isolate.
 */
export function generateXPlaneRemovalsJson(xml: string, icao: string): string {
	if (xml.length > MAX_XPLANE_XML_CHARS) throw new Error('Invalid X-Plane draft: XML is too large');
	const grouped = new Map<string, XPlaneRemovalSelector>();
	const dsfSelectors = new Map<string, XPlaneDsfSelector>();
	let version = '1';
	let dsfElementCount = 0;
	let sawFsData = false;
	let sawRemovals = false;
	let insideRemovals = false;
	let removalElementCount = 0;

	for (const match of xml.matchAll(TAG_PATTERN)) {
		const tag = match[0];
		if (tag.length > MAX_TAG_CHARS) {
			throw new Error('Invalid X-Plane draft: XML tag is too large');
		}
		if (tag.startsWith('<!--') || tag.startsWith('<?') || tag.startsWith('<!')) {
			continue;
		}

		const parsed = parseTag(tag);
		if (parsed.closing) {
			if (parsed.name === 'XPlaneRemovals') {
				if (!insideRemovals) throw new Error('Invalid X-Plane draft: unexpected XPlaneRemovals closing tag');
				insideRemovals = false;
			} else if (insideRemovals) {
				throw new Error(`Invalid X-Plane draft: unexpected closing ${parsed.name} tag`);
			}
			continue;
		}

		if (parsed.name === 'FSData') {
			if (sawFsData) throw new Error('Invalid X-Plane draft: multiple FSData roots');
			sawFsData = true;
			if (parsed.attributes.simulator?.toLowerCase() !== 'xplane') {
				throw new Error('X-Plane draft is missing simulator="xplane"');
			}
			continue;
		}

		if (parsed.name === 'XPlaneRemovals') {
			if (!sawFsData || sawRemovals || parsed.selfClosing) {
				throw new Error('Invalid X-Plane draft: expected one non-empty XPlaneRemovals section');
			}
			version = parsed.attributes.version ?? '1';
			if (!['1', '2'].includes(version)) throw new Error('Unsupported X-Plane removal version');
			sawRemovals = true;
			insideRemovals = true;
			continue;
		}

		if (!insideRemovals) {
			continue;
		}
		if (parsed.name === 'Dsf') {
			if (version !== '2' || !parsed.selfClosing) throw new Error('DSF removals require version 2 and self-closing elements');
			if (++dsfElementCount + removalElementCount > MAX_XPLANE_REMOVAL_ELEMENTS)
				throw new Error('Too many X-Plane removal selectors');
			const selector = parseDsfSelector(parsed.attributes);
			const key = JSON.stringify(selector);
			dsfSelectors.set(key, selector);
			continue;
		}
		if (parsed.name !== 'Light') throw new Error(`Invalid X-Plane draft: unsupported ${parsed.name} removal element`);
		if (!parsed.selfClosing) {
			throw new Error('Invalid X-Plane light selector: Light elements must be self-closing');
		}
		removalElementCount += 1;
		if (removalElementCount + dsfElementCount > MAX_XPLANE_REMOVAL_ELEMENTS) {
			throw new Error(`Invalid X-Plane draft: more than ${MAX_XPLANE_REMOVAL_ELEMENTS} light selectors`);
		}
		addSelector(grouped, parsed.attributes);
	}

	if (!sawFsData) throw new Error('Invalid X-Plane draft: missing FSData root');
	if (!sawRemovals) throw new Error('Invalid X-Plane draft: missing XPlaneRemovals section');
	if (insideRemovals) throw new Error('Invalid X-Plane draft: unclosed XPlaneRemovals section');
	const removalsSource = xml.match(/<XPlaneRemovals\b[\s\S]*?<\/XPlaneRemovals\s*>/)?.[0] ?? '';
	const declaredLightCount = removalsSource.match(/<Light\b/g)?.length ?? 0;
	if ((removalsSource.match(/<Dsf\b/g)?.length ?? 0) !== dsfElementCount || declaredLightCount !== removalElementCount) {
		throw new Error('Invalid X-Plane draft: malformed Light element');
	}

	const selectors = [...grouped.values()]
		.map((selector) => ({ ...selector, ranges: mergeRanges(selector.ranges) }))
		.sort((left, right) => left.feature.localeCompare(right.feature) || left.code - right.code || left.run - right.run);
	const artifact: XPlaneRemovalArtifact = {
		schema: version === '2' ? 'bars-xplane-removals/v2' : 'bars-xplane-removals/v1',
		...(version === '2' ? { dsfSelectors: [...dsfSelectors.values()] } : {}),
		icao: icao.trim().toUpperCase(),
		selectors,
	};
	return JSON.stringify(artifact);
}

interface ParsedXmlTag {
	name: string;
	attributes: Record<string, string>;
	closing: boolean;
	selfClosing: boolean;
}

function parseTag(tag: string): ParsedXmlTag {
	const closing = /^<\s*\//.test(tag);
	const selfClosing = /\/\s*>$/.test(tag);
	const nameMatch = tag.match(/^<\s*\/?\s*([A-Za-z_:][\w:.-]*)/);
	if (!nameMatch) throw new Error('Invalid X-Plane draft: malformed XML tag');
	if (closing) return { name: nameMatch[1], attributes: {}, closing, selfClosing: false };

	const end = tag.length - (selfClosing ? 2 : 1);
	let offset = nameMatch[0].length;
	const attributes: Record<string, string> = {};
	while (offset < end) {
		ATTRIBUTE_PATTERN.lastIndex = offset;
		const attribute = ATTRIBUTE_PATTERN.exec(tag);
		if (!attribute || attribute.index !== offset || ATTRIBUTE_PATTERN.lastIndex > end) {
			if (/^\s*$/.test(tag.slice(offset, end))) break;
			throw new Error(`Invalid X-Plane draft: malformed attributes on ${nameMatch[1]}`);
		}
		const name = attribute[1];
		if (Object.prototype.hasOwnProperty.call(attributes, name)) {
			throw new Error(`Invalid X-Plane draft: duplicate ${name} attribute`);
		}
		attributes[name] = attribute[2] ?? attribute[3] ?? '';
		offset = ATTRIBUTE_PATTERN.lastIndex;
	}
	return { name: nameMatch[1], attributes, closing, selfClosing };
}

function addSelector(grouped: Map<string, XPlaneRemovalSelector>, attributes: Record<string, string>): void {
	const required = ['feature', 'code', 'run', 'start', 'end'] as const;
	if (required.some((name) => !Object.prototype.hasOwnProperty.call(attributes, name))) {
		throw new Error('Invalid X-Plane light selector: missing required attribute');
	}
	const feature = attributes.feature.toLowerCase();
	const code = Number(attributes.code);
	const run = Number(attributes.run);
	const start = Number(attributes.start);
	const end = Number(attributes.end);
	const normalizedStart = clampAndRoundFraction(start);
	const normalizedEnd = clampAndRoundFraction(end);

	if (
		!FEATURE_PATTERN.test(feature) ||
		!XPLANE_LIGHT_CODES.has(code) ||
		!Number.isInteger(run) ||
		run < 0 ||
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		start < -FRACTION_BOUNDARY_TOLERANCE ||
		start > 1 + FRACTION_BOUNDARY_TOLERANCE ||
		end < -FRACTION_BOUNDARY_TOLERANCE ||
		end > 1 + FRACTION_BOUNDARY_TOLERANCE ||
		normalizedEnd <= normalizedStart
	) {
		throw new Error('Invalid X-Plane light selector');
	}

	const key = `${feature}:${code}:${run}`;
	const selector = grouped.get(key) ?? { feature, code, run, ranges: [] };
	selector.ranges.push([normalizedStart, normalizedEnd]);
	grouped.set(key, selector);
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
	const ordered = [...ranges].sort((left, right) => left[0] - right[0]);
	const merged: Array<[number, number]> = [];
	for (const range of ordered) {
		const previous = merged[merged.length - 1];
		if (previous && range[0] <= previous[1] + 0.000001) {
			previous[1] = Math.max(previous[1], range[1]);
		} else {
			merged.push([...range]);
		}
	}
	return merged;
}

function roundFraction(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function clampAndRoundFraction(value: number): number {
	return roundFraction(Math.min(1, Math.max(0, value)));
}

function parseDsfSelector(attributes: Record<string, string>): XPlaneDsfSelector {
	const keys = ['kind', 'source', 'sha256', 'definition', 'command', 'pool', 'filter', 'index'];
	if (Object.keys(attributes).length !== keys.length || keys.some((key) => !attributes[key]))
		throw new Error('Invalid DSF selector attributes');
	const { kind, source, sha256, definition } = attributes;
	const command = Number(attributes.command),
		pool = Number(attributes.pool),
		filter = Number(attributes.filter),
		index = Number(attributes.index);
	if (
		!['dsf-string', 'dsf-object'].includes(kind) ||
		!/^Earth nav data\/[+-]\d{2}[+-]\d{3}\/[+-]\d{2}[+-]\d{3}\.dsf$/.test(source) ||
		!/^[a-f0-9]{64}$/.test(sha256) ||
		definition.length > 512 ||
		/[<>"&]/.test(definition) || [...definition].some((character) => character.charCodeAt(0) < 32) ||
		!definition.endsWith(kind === 'dsf-string' ? '.str' : '.obj') ||
		![command, pool, filter, index].every(Number.isInteger) ||
		command < 12 ||
		command > 0x7fffffff ||
		pool < 0 ||
		pool > 65535 ||
		filter < -1 ||
		filter > 0x7fffffff ||
		index < 0 ||
		index > 65535
	)
		throw new Error('Invalid DSF removal selector');
	return { kind: kind as XPlaneDsfSelector['kind'], source, sha256, definition, command, pool, filter, index };
}
