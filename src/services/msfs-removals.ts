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

export function buildRemovalArtifacts(polygons: RemovalPolygon[]): RemovalArtifacts {
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
					? calculatePolygonFallbackSupports(polygon)
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

function calculatePolygonFallbackSupports(polygon: RemovalPolygon): Omit<RemovalSupport, 'altitude'>[] {
	const rectangle = calculateContainedRectangleSupport(polygon);
	return rectangle ? [rectangle] : calculateManualSupports(polygon);
}

function calculateContainedRectangleSupport(polygon: RemovalPolygon): Omit<RemovalSupport, 'altitude'> | undefined {
	const projection = projectPolygon(polygon.vertices);
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

function calculateManualSupports(polygon: RemovalPolygon): Omit<RemovalSupport, 'altitude'>[] {
	const projection = projectPolygon(polygon.vertices);
	if (!projection) return [];
	const ring = projection.ring;
	const minY = Math.min(...ring.map((point) => point.y));
	const maxY = Math.max(...ring.map((point) => point.y));
	const spanY = maxY - minY;
	if (spanY <= CONTAINMENT_MARGIN_METERS * 2) return [];
	const stripHeight = Math.max(MANUAL_STRIP_HEIGHT_METERS, spanY / MAXIMUM_MANUAL_STRIPS);
	const rowCount = Math.max(1, Math.ceil(spanY / stripHeight));
	const actualHeight = spanY / rowCount;
	const supports: Omit<RemovalSupport, 'altitude'>[] = [];

	for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
		const y0 = minY + rowIndex * actualHeight + CONTAINMENT_MARGIN_METERS;
		const y1 = minY + (rowIndex + 1) * actualHeight - CONTAINMENT_MARGIN_METERS;
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
			supports.push(supportFromLocal(center, halfWidth * 2, halfLength * 2, 90, projection));
		}
	}
	return supports;
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
