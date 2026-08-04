export interface XPlaneRemovalSelector {
	feature: string;
	code: number;
	run: number;
	ranges: Array<[number, number]>;
}

export interface XPlaneRemovalArtifact {
	schema: 'bars-xplane-removals/v1';
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
			sawRemovals = true;
			insideRemovals = true;
			continue;
		}

		if (!insideRemovals) {
			continue;
		}
		if (parsed.name !== 'Light') throw new Error(`Invalid X-Plane draft: unsupported ${parsed.name} removal element`);
		if (!parsed.selfClosing) {
			throw new Error('Invalid X-Plane light selector: Light elements must be self-closing');
		}
		removalElementCount += 1;
		if (removalElementCount > MAX_XPLANE_REMOVAL_ELEMENTS) {
			throw new Error(`Invalid X-Plane draft: more than ${MAX_XPLANE_REMOVAL_ELEMENTS} light selectors`);
		}
		addSelector(grouped, parsed.attributes);
	}

	if (!sawFsData) throw new Error('Invalid X-Plane draft: missing FSData root');
	if (!sawRemovals) throw new Error('Invalid X-Plane draft: missing XPlaneRemovals section');
	if (insideRemovals) throw new Error('Invalid X-Plane draft: unclosed XPlaneRemovals section');
	const removalsSource = xml.match(/<XPlaneRemovals\b[\s\S]*?<\/XPlaneRemovals\s*>/)?.[0] ?? '';
	const declaredLightCount = removalsSource.match(/<Light\b/g)?.length ?? 0;
	if (declaredLightCount !== removalElementCount) {
		throw new Error('Invalid X-Plane draft: malformed Light element');
	}

	const selectors = [...grouped.values()]
		.map((selector) => ({ ...selector, ranges: mergeRanges(selector.ranges) }))
		.sort((left, right) => left.feature.localeCompare(right.feature) || left.code - right.code || left.run - right.run);
	const artifact: XPlaneRemovalArtifact = {
		schema: 'bars-xplane-removals/v1',
		icao: icao.trim().toUpperCase(),
		selectors,
	};
	return JSON.stringify(artifact);
}

function parseTag(tag: string): {
	name: string;
	attributes: Record<string, string>;
	closing: boolean;
	selfClosing: boolean;
} {
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
