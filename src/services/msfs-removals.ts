export interface PolygonVertex {
	lat: number;
	lon: number;
}

interface RemovalTarget extends PolygonVertex {
	heading: number;
	supportSizeMeters?: number;
}

interface ExclusionFlags {
	excludeLibraryObjects: boolean;
	excludeVFX: boolean;
	excludeSimPropContainers: boolean;
}

export interface RemovalPolygon {
	id: string;
	vertices: PolygonVertex[];
	altitude: number;
	targets: RemovalTarget[];
	exclusionFlags: ExclusionFlags;
	hasPlan: boolean;
	mode: 'targets' | 'polygon';
}

interface LocalPoint {
	x: number;
	y: number;
}

interface Projection {
	origin: PolygonVertex;
	metersPerDegreeLon: number;
	ring: LocalPoint[];
}

export interface RemovalSupport {
	latitude: number;
	longitude: number;
	width: number;
	length: number;
	heading: number;
	altitude: number;
}

export interface RemovalExclusion {
	latitudeMinimum: number;
	latitudeMaximum: number;
	longitudeMinimum: number;
	longitudeMaximum: number;
	flags: ExclusionFlags;
}

export interface RemovalArtifacts {
	supports: RemovalSupport[];
	exclusions: RemovalExclusion[];
}

interface XmlAttributes {
	[name: string]: string | undefined;
}

const METERS_PER_DEGREE_LAT = 111_320;
const TARGET_SUPPORT_SIZES_METERS = [0.5, 0.35, 0.25, 0.15, 0.1, 0.05, 0.025, 0.01];
const MAXIMUM_TARGET_SUPPORT_SIZE_METERS = 0.75;
const MANUAL_STRIP_HEIGHT_METERS = 0.25;
const CONTAINMENT_MARGIN_METERS = 0.005;
const MAXIMUM_MANUAL_STRIPS = 50_000;

export function parseRemovalPolygons(xmlContent: string): RemovalPolygon[] {
	const polygons: RemovalPolygon[] = [];
	const polygonPattern = /<Polygon\b([^>]*)>([\s\S]*?)<\/Polygon>/gi;
	let polygonMatch: RegExpExecArray | null;
	while ((polygonMatch = polygonPattern.exec(xmlContent)) !== null) {
		const attributes = parseAttributes(polygonMatch[1]);
		if (String(attributes.displayName ?? '').toLowerCase() !== 'remove') continue;

		const vertices: PolygonVertex[] = [];
		const vertexPattern = /<Vertex\b([^>]*)\/?\s*>/gi;
		let vertexMatch: RegExpExecArray | null;
		while ((vertexMatch = vertexPattern.exec(polygonMatch[2])) !== null) {
			const vertexAttributes = parseAttributes(vertexMatch[1]);
			const lat = Number(vertexAttributes.lat);
			const lon = Number(vertexAttributes.lon);
			if (Number.isFinite(lat) && Number.isFinite(lon)) vertices.push({ lat, lon });
		}

		const uniqueVertices = removeClosingAndDuplicateVertices(vertices);
		if (uniqueVertices.length < 3) continue;
		const altitude = Number(attributes.altitude);
		polygons.push({
			id: `remove:${polygons.length}`,
			vertices: uniqueVertices,
			altitude: Number.isFinite(altitude) ? altitude : 0,
			targets: [],
			exclusionFlags: emptyExclusionFlags(),
			hasPlan: false,
			mode: 'targets',
		});
	}

	const planPattern = /<(Removal|Target|Object)\b([^>]*)\/?\s*>/gi;
	let planMatch: RegExpExecArray | null;
	while ((planMatch = planPattern.exec(xmlContent)) !== null) {
		const attributes = parseAttributes(planMatch[2]);
		const removalIndex = Number(attributes.removalIndex);
		const polygon = Number.isInteger(removalIndex) ? polygons[removalIndex] : undefined;
		if (!polygon) continue;
		polygon.hasPlan = true;
		const planType = planMatch[1].toLowerCase();
		if (planType === 'removal') {
			polygon.mode = attributes.mode === 'polygon' ? 'polygon' : 'targets';
			continue;
		}
		if (planType === 'target') {
			const lat = Number(attributes.lat);
			const lon = Number(attributes.lon);
			const heading = Number(attributes.heading);
			const supportSizeMeters = Number(attributes.supportSizeMeters);
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
			polygon.targets.push({
				lat,
				lon,
				heading: Number.isFinite(heading) ? heading : 0,
				...(Number.isFinite(supportSizeMeters) && supportSizeMeters > 0
					? { supportSizeMeters: Math.min(supportSizeMeters, MAXIMUM_TARGET_SUPPORT_SIZE_METERS) }
					: {}),
			});
			continue;
		}
		polygon.exclusionFlags = {
			excludeLibraryObjects: xmlBoolean(attributes.excludeLibraryObjects),
			excludeVFX: xmlBoolean(attributes.excludeVFX),
			excludeSimPropContainers: xmlBoolean(attributes.excludeSimPropContainers),
		};
	}

	for (const polygon of polygons) polygon.targets = deduplicateTargets(polygon.targets);
	return polygons;
}

export function buildRemovalArtifacts(polygons: RemovalPolygon[], options: { alignPolygonSupports?: boolean; coverPolygonEnds?: boolean } = {}): RemovalArtifacts {
	const supports: RemovalSupport[] = [];
	const exclusions: RemovalExclusion[] = [];
	const targetSignatures = new Set<string>();

	for (const polygon of polygons) {
		const polygonTargets = (polygon.mode === 'targets' ? polygon.targets : []).filter((target) => {
			const signature = `${target.lat.toFixed(10)}:${target.lon.toFixed(10)}`;
			if (targetSignatures.has(signature)) return false;
			targetSignatures.add(signature);
			return true;
		});
		const polygonSupports =
			polygon.hasPlan && polygon.mode === 'targets'
				? calculateTargetSupports({ ...polygon, targets: polygonTargets })
				: polygon.hasPlan && polygon.mode === 'polygon'
					? calculatePolygonFallbackSupports(polygon, options.alignPolygonSupports === true, options.coverPolygonEnds === true)
					: calculateManualSupports(polygon);
		for (const support of polygonSupports) supports.push({ ...support, altitude: polygon.altitude });

		if (hasExclusionFlags(polygon.exclusionFlags)) {
			const exclusion = exclusionForPolygon(polygon);
			if (!exclusion) throw new Error(`Object exclusion ${polygon.id} is not safely axis-aligned`);
			exclusions.push({ ...exclusion, flags: polygon.exclusionFlags });
		} else if (!polygon.hasPlan) {
			for (const support of polygonSupports) {
				exclusions.push({
					...exclusionForAxisAlignedSupport(support),
					flags: { ...emptyExclusionFlags(), excludeLibraryObjects: true },
				});
			}
		}
	}
	return { supports, exclusions };
}

export function calculateAirportTestRadius(airport: PolygonVertex, supports: RemovalSupport[], exclusions: RemovalExclusion[]): number {
	let furthest = 0;
	for (const support of supports) {
		furthest = Math.max(
			furthest,
			distanceMeters(airport, { lat: support.latitude, lon: support.longitude }) + Math.hypot(support.width, support.length) / 2,
		);
	}
	for (const exclusion of exclusions) {
		for (const point of [
			{ lat: exclusion.latitudeMinimum, lon: exclusion.longitudeMinimum },
			{ lat: exclusion.latitudeMaximum, lon: exclusion.longitudeMaximum },
		]) {
			furthest = Math.max(furthest, distanceMeters(airport, point));
		}
	}
	return Math.max(1000, Math.ceil(furthest + 100));
}

function calculateTargetSupports(polygon: RemovalPolygon): Omit<RemovalSupport, 'altitude'>[] {
	const projection = projectPolygon(polygon.vertices);
	if (!projection) return [];
	const supports: Omit<RemovalSupport, 'altitude'>[] = [];
	for (const target of polygon.targets) {
		const targetPoint = projectPoint(target, projection);
		const radians = (target.heading * Math.PI) / 180;
		const along = { x: Math.sin(radians), y: Math.cos(radians) };
		const across = { x: Math.cos(radians), y: -Math.sin(radians) };
		let selected: Omit<RemovalSupport, 'altitude'> | undefined;

		for (const size of targetSupportSizes(target)) {
			const half = size / 2;
			for (const targetAlong of [0, half, -half]) {
				for (const targetAcross of [0, half, -half]) {
					const center = {
						x: targetPoint.x - along.x * targetAlong - across.x * targetAcross,
						y: targetPoint.y - along.y * targetAlong - across.y * targetAcross,
					};
					if (!rectangleInsideRing(center, along, across, half, half, projection.ring)) continue;
					selected = supportFromLocal(center, size, size, target.heading, projection);
					break;
				}
				if (selected) break;
			}
			if (selected) break;
		}

		if (!selected) {
			continue;
		}
		supports.push(selected);
	}
	return supports;
}

function targetSupportSizes(target: RemovalTarget): number[] {
	const preferred = Number(target.supportSizeMeters);
	if (!Number.isFinite(preferred) || preferred <= TARGET_SUPPORT_SIZES_METERS[0]) {
		return TARGET_SUPPORT_SIZES_METERS;
	}
	const capped = Math.min(preferred, MAXIMUM_TARGET_SUPPORT_SIZE_METERS);
	return [capped, ...TARGET_SUPPORT_SIZES_METERS.filter((size) => size < capped)];
}

function calculatePolygonFallbackSupports(polygon: RemovalPolygon, alignToPolygon: boolean, coverEnds: boolean): Omit<RemovalSupport, 'altitude'>[] {
	const rectangleProjection = alignToPolygon ? projectPolygon(polygon.vertices) : undefined;
	if (rectangleProjection) {
		let ring = rectangleProjection.ring;
		let changed = true;
		while (changed && ring.length > 4) {
			changed = false;
			for (let index = 0; index < ring.length; index++) {
				if (pointToSegmentDistance(ring[index], ring[(index + ring.length - 1) % ring.length], ring[(index + 1) % ring.length]) > 0.0001) continue;
				ring = [...ring.slice(0, index), ...ring.slice(index + 1)];
				changed = true;
				break;
			}
		}
		rectangleProjection.ring = ring;
	}
	const rectangle = calculateContainedRectangleSupport(polygon, rectangleProjection ?? undefined);
	if (rectangle) return [rectangle];
	const original = calculateManualSupports(polygon);
	if (!alignToPolygon) return original;
	const originalArea = original.reduce((sum, support) => sum + support.width * support.length, 0);
	const best = original;
	const sections = corridorSections(polygon);
	if (sections) {
		const parentProjection = projectPolygon(polygon.vertices)!;
		for (let refinement = 0; refinement <= 7; refinement++) {
			const fitted = sections.flatMap((section) => {
				const projection = { ...parentProjection, ring: section.vertices.map((point) => projectPoint(point, parentProjection)) };
				const rectangle = calculateContainedRectangleSupport(section, projection) ?? calculateCorridorRectangleSupport(projection);
				return rectangle ? [rectangle] : calculateManualSupports(section, true, 8 / 2 ** refinement, projection);
			});
			fitted.push(...calculateCorridorJoinSupports(parentProjection));
			const area = fitted.reduce((sum, support) => sum + support.width * support.length, 0);
			if (area >= originalArea - 1e-6) return coverEnds ? [...fitted, ...calculateCorridorEndSupports(parentProjection)] : fitted;
		}
	}
	for (let refinement = 0; refinement <= 6; refinement++) {
		const longitudinal = calculateLongitudinalPolygonSupports(polygon, refinement);
		const area = longitudinal.reduce((sum, support) => sum + support.width * support.length, 0);
		if (area >= originalArea - 1e-6) return longitudinal;
	}
	for (let refinement = 0; refinement <= 5; refinement++) {
		const aligned = calculateManualSupports(polygon, true, MANUAL_STRIP_HEIGHT_METERS / 2 ** refinement);
		if (aligned.length >= best.length) return best;
		const area = aligned.reduce((sum, support) => sum + support.width * support.length, 0);
		if (area >= originalArea - 1e-6) return aligned;
	}
	return best;
}

function calculateLongitudinalPolygonSupports(polygon: RemovalPolygon, refinement: number): Omit<RemovalSupport, 'altitude'>[] {
	const projection = projectPolygon(polygon.vertices);
	if (!projection) return [];
	// Cut at changes along the path so each rectangle spans its available width.
	const angle = minimumWidthSweepAngle(projection.ring) + Math.PI / 2;
	const cos = Math.cos(angle), sin = Math.sin(angle);
	const ring = projection.ring.map(point => ({ x: point.x * cos + point.y * sin, y: -point.x * sin + point.y * cos }));
	const events = [...new Set(ring.map(point => point.y))].sort((a, b) => a - b);
	const supports: Omit<RemovalSupport, 'altitude'>[] = [];
	const addBand = (y0: number, y1: number) => {
		if (y1 <= y0) return;
		const middleY = (y0 + y1) / 2;
		let intervals = intersectIntervals(intervalsAtY(ring, y0), intervalsAtY(ring, y1));
		intervals = intersectIntervals(intervals, intervalsAtY(ring, middleY));
		for (const y of events) {
			if (y > y0 && y < y1) intervals = intersectIntervals(intervals, intervalsAtY(ring, y));
		}
		for (const [left, right] of intervals) {
			const halfLength = (right - left) / 2 - 0.001;
			const halfWidth = (y1 - y0) / 2;
			if (halfLength <= 0.005) continue;
			const center = { x: (left + right) / 2, y: middleY };
			if (!rectangleInsideRing(center, { x: 1, y: 0 }, { x: 0, y: -1 }, halfLength, halfWidth, ring)) continue;
			supports.push(supportFromLocal(
				{ x: center.x * cos - center.y * sin, y: center.x * sin + center.y * cos },
				halfWidth * 2, halfLength * 2, 90 - angle * 180 / Math.PI, projection,
			));
		}
	};
	const intervalWidth = (intervals: [number, number][]) => intervals.reduce((sum, [left, right]) => sum + right - left, 0);
	for (let event = 1; event < events.length; event++) {
		const startY = events[event - 1], endY = events[event];
		if (endY - startY <= 0.002) continue;
		const startIntervals = intervalsAtY(ring, startY + 0.001);
		const endIntervals = intervalsAtY(ring, endY - 0.001);
		const meanWidth = (intervalWidth(startIntervals) + intervalWidth(endIntervals)) / 2;
		const containedWidth = intervalWidth(intersectIntervals(startIntervals, endIntervals));
		// Keep nearly rectangular sections whole; refine only the taper at clipped ends.
		const subdivisions = containedWidth >= meanWidth * 0.999 ? 1 : 2 ** refinement;
		const step = (endY - startY) / subdivisions;
		if (step <= 0.002) continue;
		for (let index = 0; index < subdivisions; index++) {
			const overlap = Math.min(0.01, step / 10);
			const y0 = startY + index * step + (index > 0 ? -overlap : 0.001);
			const y1 = startY + (index + 1) * step + (index < subdivisions - 1 ? overlap : -0.001);
			addBand(y0, y1);
		}
	}
	for (let event = 1; event < events.length - 1; event++) {
		const half = Math.min(0.01, (events[event] - events[event - 1]) / 4, (events[event + 1] - events[event]) / 4);
		if (half > 0.001) addBand(events[event] - half, events[event] + half);
	}
	return supports;
}

function calculateCorridorRectangleSupport(projection: Projection): Omit<RemovalSupport, 'altitude'> | undefined {
	const ring = projection.ring;
	const start = { x: (ring[0].x + ring[3].x) / 2, y: (ring[0].y + ring[3].y) / 2 };
	const end = { x: (ring[1].x + ring[2].x) / 2, y: (ring[1].y + ring[2].y) / 2 };
	const length = Math.hypot(end.x - start.x, end.y - start.y);
	if (length < 0.02) return undefined;
	const along = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
	const across = { x: along.y, y: -along.x };
	const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
	const halfWidth = Math.min(...ring.map(point => Math.abs((point.x - center.x) * across.x + (point.y - center.y) * across.y))) - 0.001;
	if (halfWidth <= 0.01) return undefined;
	let low = 0, high = length / 2;
	for (let iteration = 0; iteration < 32; iteration++) {
		const middle = (low + high) / 2;
		if (rectangleInsideRing(center, along, across, middle, halfWidth, ring)) low = middle;
		else high = middle;
	}
	if (low < length * 0.4) return undefined;
	return supportFromLocal(center, halfWidth * 2, Math.max(0, low * 2 - 0.002), Math.atan2(along.x, along.y) * 180 / Math.PI, projection);
}

function calculateCorridorJoinSupports(projection: Projection): Omit<RemovalSupport, 'altitude'>[] {
	const supports: Omit<RemovalSupport, 'altitude'>[] = [];
	const ring = projection.ring;
	for (let index = 1; index < ring.length / 2 - 1; index++) {
		const left = ring[index], right = ring[ring.length - 1 - index];
		const center = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
		const width = Math.hypot(left.x - right.x, left.y - right.y);
		if (width <= 0.02) continue;
		const across = { x: (left.x - right.x) / width, y: (left.y - right.y) / width };
		const along = { x: -across.y, y: across.x };
		let half = width / 2 - 0.001;
		while (half >= 0.01 && !rectangleInsideRing(center, along, across, half, half, ring)) half *= 0.8;
		if (half < 0.01) continue;
		supports.push(supportFromLocal(center, half * 2, half * 2, Math.atan2(along.x, along.y) * 180 / Math.PI, projection));
	}
	return supports;
}

function calculateCorridorEndSupports(projection: Projection): Omit<RemovalSupport, 'altitude'>[] {
	const supports: Omit<RemovalSupport, 'altitude'>[] = [];
	const ring = projection.ring;
	const last = ring.length / 2 - 1;
	for (const index of [0, last]) {
		const left = ring[index], right = ring[ring.length - 1 - index];
		const endpoint = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
		const nextIndex = index === 0 ? 1 : last - 1;
		const nextLeft = ring[nextIndex], nextRight = ring[ring.length - 1 - nextIndex];
		const inward = { x: (nextLeft.x + nextRight.x) / 2 - endpoint.x, y: (nextLeft.y + nextRight.y) / 2 - endpoint.y };
		const width = Math.hypot(left.x - right.x, left.y - right.y);
		if (width <= 0.02) continue;
		const across = { x: (left.x - right.x) / width, y: (left.y - right.y) / width };
		const direction = Math.sign(-across.y * inward.x + across.x * inward.y);
		const along = { x: -across.y * direction, y: across.x * direction };
		let halfWidth = width / 2 - 0.001;
		let halfLength = Math.min(halfWidth, Math.hypot(inward.x, inward.y) / 2);
		while (halfWidth >= 0.01 && halfLength >= 0.01) {
			const center = { x: endpoint.x + along.x * (halfLength + 0.001), y: endpoint.y + along.y * (halfLength + 0.001) };
			if (rectangleInsideRing(center, along, across, halfLength, halfWidth, ring)) {
				supports.push(supportFromLocal(center, halfWidth * 2, halfLength * 2, Math.atan2(along.x, along.y) * 180 / Math.PI, projection));
				break;
			}
			halfWidth *= 0.8;
			halfLength *= 0.8;
		}
	}
	return supports;
}

function corridorSections(polygon: RemovalPolygon): RemovalPolygon[] | undefined {
	const projection = projectPolygon(polygon.vertices);
	if (!projection || projection.ring.length % 2 !== 0) return undefined;
	const ring = projection.ring;
	const signedArea = (points: LocalPoint[]) =>
		points.reduce((sum, point, index) => {
			const next = points[(index + 1) % points.length];
			return sum + point.x * next.y - next.x * point.y;
		}, 0) / 2;
	const winding = Math.sign(signedArea(ring));
	if (!winding) return undefined;
	const sections: RemovalPolygon[] = [];
	for (let index = 0; index < ring.length / 2 - 1; index++) {
		const indexes = [index, index + 1, ring.length - 2 - index, ring.length - 1 - index];
		const quad = indexes.map((i) => ring[i]);
		if (signedArea(quad) * winding <= 1e-8) return undefined;
		for (let edge = 0; edge < 4; edge++) {
			const start = quad[edge],
				end = quad[(edge + 1) % 4];
			if (orientation(start, end, quad[(edge + 2) % 4]) * winding < -1e-8) return undefined;
			if (!pointInRing({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, ring)) return undefined;
			for (let boundary = 0; boundary < ring.length; boundary++) {
				if (segmentsProperlyIntersect(start, end, ring[boundary], ring[(boundary + 1) % ring.length])) return undefined;
			}
		}
		sections.push({ ...polygon, vertices: indexes.map((i) => polygon.vertices[i]) });
	}
	return sections;
}

function calculateContainedRectangleSupport(
	polygon: RemovalPolygon,
	sectionProjection?: Projection,
): Omit<RemovalSupport, 'altitude'> | undefined {
	const projection = sectionProjection ?? projectPolygon(polygon.vertices);
	if (!projection || projection.ring.length !== 4) return undefined;
	const ring = projection.ring;
	let longestEdgeIndex = 0;
	let longestEdgeLength = 0;
	for (let index = 0; index < ring.length; index++) {
		const next = ring[(index + 1) % ring.length];
		const length = Math.hypot(next.x - ring[index].x, next.y - ring[index].y);
		if (length > longestEdgeLength) {
			longestEdgeIndex = index;
			longestEdgeLength = length;
		}
	}
	if (longestEdgeLength <= CONTAINMENT_MARGIN_METERS * 2) return undefined;

	const edgeStart = ring[longestEdgeIndex];
	const edgeEnd = ring[(longestEdgeIndex + 1) % ring.length];
	const along = {
		x: (edgeEnd.x - edgeStart.x) / longestEdgeLength,
		y: (edgeEnd.y - edgeStart.y) / longestEdgeLength,
	};
	const across = { x: along.y, y: -along.x };
	const center = {
		x: ring.reduce((sum, point) => sum + point.x, 0) / ring.length,
		y: ring.reduce((sum, point) => sum + point.y, 0) / ring.length,
	};
	const alongOffsets = ring.map((point) => (point.x - center.x) * along.x + (point.y - center.y) * along.y);
	const acrossOffsets = ring.map((point) => (point.x - center.x) * across.x + (point.y - center.y) * across.y);
	const rawHalfLength = (Math.max(...alongOffsets) - Math.min(...alongOffsets)) / 2;
	const rawHalfWidth = (Math.max(...acrossOffsets) - Math.min(...acrossOffsets)) / 2;
	const rectangleInsetMeters = 0.001;
	const halfLength = rawHalfLength - rectangleInsetMeters;
	const halfWidth = rawHalfWidth - rectangleInsetMeters;
	if (halfLength <= CONTAINMENT_MARGIN_METERS || halfWidth <= CONTAINMENT_MARGIN_METERS) return undefined;

	const expectedCorners = [
		combineAxes(center, along, across, -rawHalfLength, -rawHalfWidth),
		combineAxes(center, along, across, rawHalfLength, -rawHalfWidth),
		combineAxes(center, along, across, rawHalfLength, rawHalfWidth),
		combineAxes(center, along, across, -rawHalfLength, rawHalfWidth),
	];
	const cornerToleranceMeters = 0.02;
	if (
		!ring.every((point) =>
			expectedCorners.some((corner) => Math.hypot(point.x - corner.x, point.y - corner.y) <= cornerToleranceMeters),
		) ||
		!expectedCorners.every((corner) =>
			ring.some((point) => Math.hypot(point.x - corner.x, point.y - corner.y) <= cornerToleranceMeters),
		)
	) {
		return undefined;
	}
	if (!rectangleInsideRing(center, along, across, halfLength, halfWidth, ring)) return undefined;

	const heading = ((Math.atan2(along.x, along.y) * 180) / Math.PI + 360) % 360;
	return supportFromLocal(center, halfWidth * 2, halfLength * 2, heading, projection);
}

function calculateManualSupports(
	polygon: RemovalPolygon,
	alignToPolygon = false,
	requestedStripHeight = MANUAL_STRIP_HEIGHT_METERS,
	sectionProjection?: Projection,
): Omit<RemovalSupport, 'altitude'>[] {
	const projection = sectionProjection ?? projectPolygon(polygon.vertices);
	if (!projection) return [];
	const angle = alignToPolygon ? minimumWidthSweepAngle(projection.ring) : 0;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const ring = projection.ring.map((point) => ({ x: point.x * cos + point.y * sin, y: -point.x * sin + point.y * cos }));
	const minY = Math.min(...ring.map((point) => point.y));
	const maxY = Math.max(...ring.map((point) => point.y));
	const spanY = maxY - minY;
	if (spanY <= CONTAINMENT_MARGIN_METERS * 2) return [];
	const stripHeight = Math.max(requestedStripHeight, spanY / MAXIMUM_MANUAL_STRIPS);
	const rowCount = Math.max(1, Math.ceil(spanY / stripHeight));
	const actualHeight = spanY / rowCount;
	// Refined strips need a proportional inset so their gaps do not consume the recovered coverage.
	const inset = alignToPolygon ? Math.min(0.001, actualHeight / 1000) : CONTAINMENT_MARGIN_METERS;
	const supports: Omit<RemovalSupport, 'altitude'>[] = [];

	for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
		const overlap = alignToPolygon ? Math.min(0.01, actualHeight / 10) : 0;
		const y0 = minY + rowIndex * actualHeight + (rowIndex > 0 && alignToPolygon ? -overlap : inset);
		const y1 = minY + (rowIndex + 1) * actualHeight + (rowIndex < rowCount - 1 && alignToPolygon ? overlap : -inset);
		if (y1 <= y0) continue;
		const middleY = (y0 + y1) / 2;
		let intervals = intervalsAtY(ring, y0);
		intervals = intersectIntervals(intervals, intervalsAtY(ring, middleY));
		intervals = intersectIntervals(intervals, intervalsAtY(ring, y1));

		for (const [rawStart, rawEnd] of intervals) {
			const start = rawStart + CONTAINMENT_MARGIN_METERS;
			const end = rawEnd - CONTAINMENT_MARGIN_METERS;
			if (end - start <= CONTAINMENT_MARGIN_METERS * 2) continue;
			const center = { x: (start + end) / 2, y: middleY };
			const halfLength = (end - start) / 2;
			const halfWidth = (y1 - y0) / 2;
			if (!rectangleInsideRing(center, { x: 1, y: 0 }, { x: 0, y: -1 }, halfLength, halfWidth, ring)) {
				continue;
			}
			supports.push(
				supportFromLocal(
					{ x: center.x * cos - center.y * sin, y: center.x * sin + center.y * cos },
					halfWidth * 2,
					halfLength * 2,
					90 - (angle * 180) / Math.PI,
					projection,
				),
			);
		}
	}
	return supports;
}

function minimumWidthSweepAngle(ring: LocalPoint[]): number {
	let bestAngle = 0;
	let bestWidth = Math.max(...ring.map((point) => point.y)) - Math.min(...ring.map((point) => point.y));
	// Sweep across the corridor, rather than generating a band for every 25 cm along it.
	for (let index = 0; index < ring.length; index++) {
		const start = ring[index];
		const end = ring[(index + 1) % ring.length];
		if (Math.hypot(end.x - start.x, end.y - start.y) < CONTAINMENT_MARGIN_METERS) continue;
		const angle = Math.atan2(end.y - start.y, end.x - start.x);
		const sin = Math.sin(angle);
		const cos = Math.cos(angle);
		let minimum = Infinity;
		let maximum = -Infinity;
		for (const point of ring) {
			const offset = -point.x * sin + point.y * cos;
			minimum = Math.min(minimum, offset);
			maximum = Math.max(maximum, offset);
		}
		if (maximum - minimum < bestWidth - 1e-6) {
			bestWidth = maximum - minimum;
			bestAngle = angle;
		}
	}
	return bestAngle;
}

function parseAttributes(source: string): XmlAttributes {
	const attributes: XmlAttributes = {};
	const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source)) !== null) attributes[match[1]] = match[3];
	return attributes;
}

function xmlBoolean(value: string | undefined): boolean {
	return String(value ?? '').toLowerCase() === 'true';
}

function emptyExclusionFlags(): ExclusionFlags {
	return {
		excludeLibraryObjects: false,
		excludeVFX: false,
		excludeSimPropContainers: false,
	};
}

function hasExclusionFlags(flags: ExclusionFlags): boolean {
	return flags.excludeLibraryObjects || flags.excludeVFX || flags.excludeSimPropContainers;
}

function removeClosingAndDuplicateVertices(vertices: PolygonVertex[]): PolygonVertex[] {
	const result: PolygonVertex[] = [];
	for (const vertex of vertices) {
		const previous = result[result.length - 1];
		if (!previous || Math.abs(previous.lat - vertex.lat) > 1e-12 || Math.abs(previous.lon - vertex.lon) > 1e-12) {
			result.push(vertex);
		}
	}
	if (result.length > 1) {
		const first = result[0];
		const last = result[result.length - 1];
		if (Math.abs(first.lat - last.lat) <= 1e-12 && Math.abs(first.lon - last.lon) <= 1e-12) {
			result.pop();
		}
	}
	return result;
}

function deduplicateTargets(targets: RemovalTarget[]): RemovalTarget[] {
	const seen = new Set<string>();
	return targets.filter((target) => {
		const signature = `${target.lat.toFixed(10)}:${target.lon.toFixed(10)}`;
		if (seen.has(signature)) return false;
		seen.add(signature);
		return true;
	});
}

function projectPolygon(vertices: PolygonVertex[]): Projection | undefined {
	if (vertices.length < 3) return undefined;
	const origin = {
		lat: vertices.reduce((sum, point) => sum + point.lat, 0) / vertices.length,
		lon: vertices.reduce((sum, point) => sum + point.lon, 0) / vertices.length,
	};
	const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.max(0.001, Math.cos((origin.lat * Math.PI) / 180));
	return {
		origin,
		metersPerDegreeLon,
		ring: vertices.map((point) => ({
			x: (point.lon - origin.lon) * metersPerDegreeLon,
			y: (point.lat - origin.lat) * METERS_PER_DEGREE_LAT,
		})),
	};
}

function projectPoint(point: PolygonVertex, projection: Projection): LocalPoint {
	return {
		x: (point.lon - projection.origin.lon) * projection.metersPerDegreeLon,
		y: (point.lat - projection.origin.lat) * METERS_PER_DEGREE_LAT,
	};
}

function supportFromLocal(
	center: LocalPoint,
	width: number,
	length: number,
	heading: number,
	projection: Projection,
): Omit<RemovalSupport, 'altitude'> {
	return {
		latitude: projection.origin.lat + center.y / METERS_PER_DEGREE_LAT,
		longitude: projection.origin.lon + center.x / projection.metersPerDegreeLon,
		width,
		length,
		heading: ((heading % 360) + 360) % 360,
	};
}

function rectangleInsideRing(
	center: LocalPoint,
	along: LocalPoint,
	across: LocalPoint,
	halfLength: number,
	halfWidth: number,
	ring: LocalPoint[],
): boolean {
	const corners = [
		combineAxes(center, along, across, -halfLength, -halfWidth),
		combineAxes(center, along, across, halfLength, -halfWidth),
		combineAxes(center, along, across, halfLength, halfWidth),
		combineAxes(center, along, across, -halfLength, halfWidth),
	];
	if (!corners.every((corner) => pointInRing(corner, ring))) return false;
	for (let rectangleIndex = 0; rectangleIndex < corners.length; rectangleIndex++) {
		const start = corners[rectangleIndex];
		const end = corners[(rectangleIndex + 1) % corners.length];
		for (let ringIndex = 0; ringIndex < ring.length; ringIndex++) {
			if (segmentsProperlyIntersect(start, end, ring[ringIndex], ring[(ringIndex + 1) % ring.length])) {
				return false;
			}
		}
	}
	return true;
}

function combineAxes(center: LocalPoint, along: LocalPoint, across: LocalPoint, alongDistance: number, acrossDistance: number): LocalPoint {
	return {
		x: center.x + along.x * alongDistance + across.x * acrossDistance,
		y: center.y + along.y * alongDistance + across.y * acrossDistance,
	};
}

function pointInRing(point: LocalPoint, ring: LocalPoint[]): boolean {
	let inside = false;
	for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
		const start = ring[previous];
		const end = ring[index];
		if (pointToSegmentDistance(point, start, end) <= 0.0005) return true;
		if (start.y > point.y !== end.y > point.y && point.x < start.x + ((point.y - start.y) * (end.x - start.x)) / (end.y - start.y)) {
			inside = !inside;
		}
	}
	return inside;
}

function pointToSegmentDistance(point: LocalPoint, start: LocalPoint, end: LocalPoint): number {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const lengthSquared = dx * dx + dy * dy;
	const ratio =
		lengthSquared <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
	return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio));
}

function segmentsProperlyIntersect(a: LocalPoint, b: LocalPoint, c: LocalPoint, d: LocalPoint): boolean {
	const abC = orientation(a, b, c);
	const abD = orientation(a, b, d);
	const cdA = orientation(c, d, a);
	const cdB = orientation(c, d, b);
	const epsilon = 1e-9;
	return abC * abD < -epsilon && cdA * cdB < -epsilon;
}

function orientation(a: LocalPoint, b: LocalPoint, c: LocalPoint): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function intervalsAtY(ring: LocalPoint[], y: number): Array<[number, number]> {
	const intersections: number[] = [];
	for (let index = 0; index < ring.length; index++) {
		const start = ring[index];
		const end = ring[(index + 1) % ring.length];
		if (start.y > y === end.y > y) continue;
		intersections.push(start.x + ((y - start.y) * (end.x - start.x)) / (end.y - start.y));
	}
	intersections.sort((left, right) => left - right);
	const intervals: Array<[number, number]> = [];
	for (let index = 0; index + 1 < intersections.length; index += 2) {
		intervals.push([intersections[index], intersections[index + 1]]);
	}
	return intervals;
}

function intersectIntervals(left: Array<[number, number]>, right: Array<[number, number]>): Array<[number, number]> {
	const result: Array<[number, number]> = [];
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		const start = Math.max(left[leftIndex][0], right[rightIndex][0]);
		const end = Math.min(left[leftIndex][1], right[rightIndex][1]);
		if (end > start) result.push([start, end]);
		if (left[leftIndex][1] < right[rightIndex][1]) leftIndex++;
		else rightIndex++;
	}
	return result;
}

function exclusionForPolygon(polygon: RemovalPolygon): Omit<RemovalExclusion, 'flags'> | undefined {
	const minLat = Math.min(...polygon.vertices.map((point) => point.lat));
	const maxLat = Math.max(...polygon.vertices.map((point) => point.lat));
	const minLon = Math.min(...polygon.vertices.map((point) => point.lon));
	const maxLon = Math.max(...polygon.vertices.map((point) => point.lon));
	const projection = projectPolygon(polygon.vertices);
	if (!projection) return undefined;
	const corners = [
		{ lat: minLat, lon: minLon },
		{ lat: minLat, lon: maxLon },
		{ lat: maxLat, lon: maxLon },
		{ lat: maxLat, lon: minLon },
	];
	if (!corners.every((corner) => pointInRing(projectPoint(corner, projection), projection.ring))) {
		return undefined;
	}
	return {
		latitudeMinimum: minLat,
		latitudeMaximum: maxLat,
		longitudeMinimum: minLon,
		longitudeMaximum: maxLon,
	};
}

function exclusionForAxisAlignedSupport(support: Omit<RemovalSupport, 'altitude'>): Omit<RemovalExclusion, 'flags'> {
	const halfLat = support.width / (2 * METERS_PER_DEGREE_LAT);
	const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.max(0.001, Math.cos((support.latitude * Math.PI) / 180));
	const halfLon = support.length / (2 * metersPerDegreeLon);
	return {
		latitudeMinimum: support.latitude - halfLat,
		latitudeMaximum: support.latitude + halfLat,
		longitudeMinimum: support.longitude - halfLon,
		longitudeMaximum: support.longitude + halfLon,
	};
}

function distanceMeters(left: PolygonVertex, right: PolygonVertex): number {
	const meanLatitude = ((left.lat + right.lat) * Math.PI) / 360;
	const north = (right.lat - left.lat) * METERS_PER_DEGREE_LAT;
	const east = (right.lon - left.lon) * METERS_PER_DEGREE_LAT * Math.cos(meanLatitude);
	return Math.hypot(east, north);
}
