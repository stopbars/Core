import { calculateDistance, calculateHeading } from './bars/geoUtils';
import { GeoPoint } from './bars/types';
import { DatabaseSessionService } from './database-session';
import { HttpError } from './errors';
import { cancelResponseBody } from './http';

type VatSysFormat = 'legacy' | 'intas';

type AirportBounds = {
	bbox_min_lat: number | null;
	bbox_min_lon: number | null;
	bbox_max_lat: number | null;
	bbox_max_lon: number | null;
};

type VatSysTaxiwayCache = {
	version: number;
	fetched_at: string;
	source_signature: string;
	bbox: {
		south: number;
		west: number;
		north: number;
		east: number;
	};
	lines: GeoPoint[][];
	windsocks: GeoPoint[];
};

type VatSysConfig = {
	is_vatsys?: boolean;
	is_legacy?: boolean;
	is_intas?: boolean;
	intas_osm_taxiways?: VatSysTaxiwayCache | null;
	intas?: {
		osm_taxiways?: VatSysTaxiwayCache | null;
	};
	[key: string]: unknown;
};

type VatSysConfigRecord = {
	id: number;
	config: VatSysConfig;
};

type RunwayRow = {
	id: number;
	length_ft: string;
	width_ft: string;
	le_ident: string;
	le_latitude_deg: string;
	le_longitude_deg: string;
	he_ident: string;
	he_latitude_deg: string;
	he_longitude_deg: string;
};

type PointRow = {
	id: string;
	type: 'stopbar' | 'lead_on';
	name: string;
	coordinates: string;
	linked_to: string | null;
};

type ParsedPoint = {
	id: string;
	type: 'stopbar' | 'lead_on';
	name: string;
	coordinates: GeoPoint[];
	linkedTo: string[];
	midpoint: GeoPoint;
	bearing: number | null;
};

type ProfileAxis = {
	start: GeoPoint;
	end: GeoPoint;
	leftEndName: string;
	rightEndName: string;
	lengthMeters: number;
	bearing: number;
};

type ProjectedPoint = {
	point: ParsedPoint;
	runwayId: number;
	x: number;
	y: number;
	angleDiff: number;
	score: number;
};

type LegacyStopbarEntry = {
	slot: number;
	stopbar: ProjectedPoint;
	leadOnIds: string[];
};

type CrossbarConfig = {
	topName: string;
	bottomName: string;
	crossingX: number;
	topBarsId?: string;
	bottomBarsId?: string;
};

type StopbarBoundaryPoint = {
	x: number;
	y: number;
};

type StopbarRunwayExclusionArea = {
	axis: ProfileAxis;
	polygon: StopbarBoundaryPoint[];
};

export type GeneratedVatSysProfile = {
	filename: string;
	xml: string;
	warnings: string[];
};

export type VatSysProfileGenerationResult = {
	format: VatSysFormat;
	icao: string;
	profiles: GeneratedVatSysProfile[];
	warnings: string[];
};

type IntasOsmData = {
	taxiwayLines: GeoPoint[][];
	windsocks: GeoPoint[];
};

export class VatSysProfileGeneratorService {
	private static readonly ICAO_REGEX = /^[A-Z0-9]{4}$/;
	private static readonly MAX_STOPBARS_PER_SIDE = 16;
	private static readonly MAX_PARALLEL_ANGLE_DIFF = 75;
	private static readonly MIN_RUNWAY_LENGTH_METERS = 100;
	private static readonly CROSSING_DISTANCE_METERS = 80;
	private static readonly MIN_TOWER_VIEW_DISTANCE_METERS = 50;
	private static readonly LEAD_ON_RUNWAY_TOUCH_DISTANCE_METERS = 10;
	private static readonly SHARED_STOPBAR_LATERAL_MULTIPLIER = 1.75;
	private static readonly CROSSBAR_SIDE_SNAP_METERS = 35;
	private static readonly INTAS_TAXIWAY_CACHE_VERSION = 21;
	private static readonly INTAS_MIN_TAXIWAY_FRAGMENT_METERS = 0.5;
	private static readonly INTAS_TINY_DISCONNECTED_TAXIWAY_METERS = 60;
	private static readonly INTAS_TAXIWAY_CONNECTION_METERS = 1;
	private static readonly INTAS_STOPBAR_RUNWAY_AREA_PADDING_METERS = 6;
	private static readonly INTAS_LEAD_ON_EXCLUSION_METERS = 10;
	private static readonly INTAS_LEAD_ON_END_EXCLUSION_METERS = 20;

	constructor(private db: D1Database) { }

	async generate(icao: string): Promise<VatSysProfileGenerationResult> {
		const normalizedIcao = icao.toUpperCase().replace(/[^A-Z0-9]/g, '');
		if (!VatSysProfileGeneratorService.ICAO_REGEX.test(normalizedIcao)) {
			throw new HttpError(400, 'Invalid ICAO format. Must be exactly 4 uppercase letters/numbers.');
		}

		const session = new DatabaseSessionService(this.db);
		try {
			const configRecord = await this.getVatSysConfig(session, normalizedIcao);
			const format = this.resolveFormat(configRecord.config, normalizedIcao);

			const points = await this.getPoints(session, normalizedIcao);
			const stopbars = points.filter((point) => point.type === 'stopbar');
			const leadOns = points.filter((point) => point.type === 'lead_on');
			if (stopbars.length === 0) {
				throw new HttpError(422, `No stopbars found for ${normalizedIcao}`);
			}

			if (format === 'intas') {
				const runways = await this.getRunways(session, normalizedIcao);
				const profile = await this.generateIntasProfile(session, normalizedIcao, configRecord, stopbars, leadOns, runways);
				return {
					format,
					icao: normalizedIcao,
					profiles: [profile],
					warnings: profile.warnings,
				};
			}

			const runways = await this.getRunways(session, normalizedIcao);
			if (runways.length === 0) {
				throw new HttpError(422, `No runways found for ${normalizedIcao}`);
			}

			const towerPosition = this.getTowerPosition(runways);
			const profiles = runways.map((runway) =>
				this.generateLegacyProfile(normalizedIcao, runway, runways, towerPosition, stopbars, leadOns),
			);
			const warnings = profiles.flatMap((profile) => profile.warnings.map((warning) => `${profile.filename}: ${warning}`));

			return {
				format: 'legacy',
				icao: normalizedIcao,
				profiles,
				warnings,
			};
		} finally {
			session.closeSession();
		}
	}

	private async getVatSysConfig(session: DatabaseSessionService, icao: string): Promise<VatSysConfigRecord> {
		const result = await session.executeRead<{ id: number; vatsys: string }>(
			`
			SELECT id, vatsys
			FROM division_airports
			WHERE icao = ? AND status = 'approved'
			ORDER BY updated_at DESC, id DESC
			LIMIT 1
			`,
			[icao],
		);
		const row = result.results[0];
		if (!row) {
			throw new HttpError(404, `No approved division airport found for ${icao}`);
		}

		try {
			const parsed = JSON.parse(row.vatsys) as VatSysConfig;
			if (!parsed || typeof parsed !== 'object') {
				throw new Error('Invalid vatSys flags');
			}
			return { id: row.id, config: parsed };
		} catch {
			throw new HttpError(422, `Invalid vatSys configuration for ${icao}`);
		}
	}

	private resolveFormat(config: VatSysConfig, icao: string): VatSysFormat {
		if (config.is_vatsys !== true) {
			throw new HttpError(403, `${icao} is not enabled for vatSys profile generation`);
		}
		if (config.is_legacy !== true && config.is_intas !== true) {
			throw new HttpError(422, `${icao} does not have legacy or INTAS profile generation enabled`);
		}
		return config.is_intas === true ? 'intas' : 'legacy';
	}

	private async getRunways(session: DatabaseSessionService, icao: string): Promise<RunwayRow[]> {
		const result = await session.executeRead<RunwayRow>(
			`
			SELECT id, length_ft, width_ft, le_ident, le_latitude_deg, le_longitude_deg, he_ident, he_latitude_deg, he_longitude_deg
			FROM runways
			WHERE airport_icao = ?
			ORDER BY id ASC
			`,
			[icao],
		);
		return result.results.filter((runway) => this.getRunwayAxis(runway) !== null);
	}

	private async getPoints(session: DatabaseSessionService, icao: string): Promise<ParsedPoint[]> {
		const result = await session.executeRead<PointRow>(
			`
			SELECT id, type, name, coordinates, linked_to
			FROM points
			WHERE airport_id = ? AND type IN ('stopbar', 'lead_on')
			ORDER BY name ASC, id ASC
			`,
			[icao],
		);

		return result.results
			.map((row) => this.parsePoint(row))
			.filter((point): point is ParsedPoint => point !== null);
	}

	private generateLegacyProfile(
		icao: string,
		runway: RunwayRow,
		allRunways: RunwayRow[],
		towerPosition: GeoPoint,
		stopbars: ParsedPoint[],
		leadOns: ParsedPoint[],
	): GeneratedVatSysProfile {
		const axis = this.getRunwayAxis(runway, towerPosition);
		if (!axis) {
			throw new HttpError(422, `Runway ${runway.le_ident}/${runway.he_ident} has invalid geometry`);
		}

		const leftEndName = axis.leftEndName;
		const rightEndName = axis.rightEndName;
		const crossbar = this.getCrossbarConfig(runway, allRunways, axis, stopbars);
		const linkedLeadOns = this.buildLeadOnLookup(leadOns);
		const projectedStopbars = this.getStopbarsForRunway(runway, allRunways, towerPosition, stopbars, linkedLeadOns).filter(
			(stopbar) => !this.isCrossbarPoint(stopbar.point, crossbar),
		);

		const warnings: string[] = [];
		if (projectedStopbars.length === 0) {
			warnings.push(`No stopbars matched runway ${rightEndName}-${leftEndName}`);
		}

		const top = projectedStopbars.filter((stopbar) => stopbar.y >= 0).sort((a, b) => a.x - b.x || a.point.id.localeCompare(b.point.id));
		const bottom = projectedStopbars.filter((stopbar) => stopbar.y < 0).sort((a, b) => a.x - b.x || a.point.id.localeCompare(b.point.id));

		if (top.length > VatSysProfileGeneratorService.MAX_STOPBARS_PER_SIDE) {
			throw new HttpError(422, `Runway ${rightEndName}-${leftEndName} has more than 16 stopbars on the top side`);
		}
		if (bottom.length > VatSysProfileGeneratorService.MAX_STOPBARS_PER_SIDE) {
			throw new HttpError(422, `Runway ${rightEndName}-${leftEndName} has more than 16 stopbars on the bottom side`);
		}

		const entries = this.alignOppositeStopbarSlots([
			...this.assignLegacySlots(top, 1, axis, crossbar, linkedLeadOns, warnings),
			...this.assignLegacySlots(bottom, 17, axis, crossbar, linkedLeadOns, warnings),
		]).sort((a, b) => a.slot - b.slot);

		const filename = `${icao}_${this.sanitizeFilenamePart(leftEndName)}-${this.sanitizeFilenamePart(rightEndName)}.xml`;
		return {
			filename,
			xml: this.buildLegacyXml(icao, leftEndName, rightEndName, entries, crossbar),
			warnings: [...new Set(warnings)],
		};
	}

	private async generateIntasProfile(
		session: DatabaseSessionService,
		icao: string,
		configRecord: VatSysConfigRecord,
		stopbars: ParsedPoint[],
		leadOns: ParsedPoint[],
		runways: RunwayRow[],
	): Promise<GeneratedVatSysProfile> {
		const warnings: string[] = [];
		const taxiwayCache = await this.getIntasTaxiwayCache(session, icao, configRecord, stopbars, leadOns, runways, warnings);
		const filename = `${icao}.xml`;

		return {
			filename,
			xml: this.buildIntasXml(taxiwayCache.lines, taxiwayCache.windsocks, stopbars, leadOns),
			warnings: [...new Set(warnings)],
		};
	}

	private async getIntasTaxiwayCache(
		session: DatabaseSessionService,
		icao: string,
		configRecord: VatSysConfigRecord,
		stopbars: ParsedPoint[],
		leadOns: ParsedPoint[],
		runways: RunwayRow[],
		warnings: string[],
	): Promise<VatSysTaxiwayCache> {
		const bbox = await this.getAirportBounds(session, icao);
		const sourceSignature = this.buildIntasTaxiwayCacheSignature(bbox, stopbars, leadOns, runways);
		const cached = this.parseIntasTaxiwayCache(configRecord.config, sourceSignature);
		if (cached) {
			return cached;
		}

		const osmData = await this.fetchIntasOsmData(icao, bbox);
		const filteredLines = this.filterAndSplitTaxiways(osmData.taxiwayLines, stopbars, leadOns, runways);
		if (filteredLines.length === 0) {
			warnings.push('No usable OSM taxiway geometry remained after INTAS filtering');
		}

		const cache: VatSysTaxiwayCache = {
			version: VatSysProfileGeneratorService.INTAS_TAXIWAY_CACHE_VERSION,
			fetched_at: new Date().toISOString(),
			source_signature: sourceSignature,
			bbox,
			lines: filteredLines,
			windsocks: osmData.windsocks,
		};

		await this.storeIntasTaxiwayCache(session, configRecord, cache);
		return cache;
	}

	private parseIntasTaxiwayCache(config: VatSysConfig, sourceSignature: string): VatSysTaxiwayCache | null {
		const cache = config.intas_osm_taxiways ?? config.intas?.osm_taxiways;
		if (
			!cache ||
			cache.version !== VatSysProfileGeneratorService.INTAS_TAXIWAY_CACHE_VERSION ||
			cache.source_signature !== sourceSignature
		) {
			return null;
		}
		if (!Array.isArray(cache.lines)) {
			return null;
		}

		const lines = cache.lines
			.map((line) => this.normalizeTaxiwayLine(line))
			.filter((line): line is GeoPoint[] => line !== null);
		if (lines.length === 0) {
			return null;
		}
		const windsocks = Array.isArray(cache.windsocks)
			? cache.windsocks
				.map((point) => this.normalizeGeoPoint(point))
				.filter((point): point is GeoPoint => point !== null)
			: [];

		return {
			...cache,
			lines,
			windsocks,
		};
	}

	private buildIntasTaxiwayCacheSignature(
		bbox: { south: number; west: number; north: number; east: number },
		stopbars: ParsedPoint[],
		leadOns: ParsedPoint[],
		runways: RunwayRow[],
	): string {
		const payload = {
			bbox: this.normalizeBboxForSignature(bbox),
			filtering: {
				minTaxiwayFragmentMeters: VatSysProfileGeneratorService.INTAS_MIN_TAXIWAY_FRAGMENT_METERS,
				tinyDisconnectedTaxiwayMeters: VatSysProfileGeneratorService.INTAS_TINY_DISCONNECTED_TAXIWAY_METERS,
				taxiwayConnectionMeters: VatSysProfileGeneratorService.INTAS_TAXIWAY_CONNECTION_METERS,
				stopbarRunwayAreaPaddingMeters: VatSysProfileGeneratorService.INTAS_STOPBAR_RUNWAY_AREA_PADDING_METERS,
				leadOnExclusionMeters: VatSysProfileGeneratorService.INTAS_LEAD_ON_EXCLUSION_METERS,
				leadOnEndExclusionMeters: VatSysProfileGeneratorService.INTAS_LEAD_ON_END_EXCLUSION_METERS,
				leadOnRunwayTouchDistanceMeters: VatSysProfileGeneratorService.LEAD_ON_RUNWAY_TOUCH_DISTANCE_METERS,
				sharedStopbarLateralMultiplier: VatSysProfileGeneratorService.SHARED_STOPBAR_LATERAL_MULTIPLIER,
			},
			stopbars: stopbars.map((point) => this.normalizePointForSignature(point)).sort((a, b) => a.id.localeCompare(b.id)),
			leadOns: leadOns.map((point) => this.normalizePointForSignature(point)).sort((a, b) => a.id.localeCompare(b.id)),
			runways: runways.map((runway) => this.normalizeRunwayForSignature(runway)).sort((a, b) => a.id - b.id),
		};
		return `v1:${this.hashString(JSON.stringify(payload))}`;
	}

	private normalizeBboxForSignature(bbox: { south: number; west: number; north: number; east: number }): Record<string, string> {
		return {
			south: this.formatCoordinate(bbox.south),
			west: this.formatCoordinate(bbox.west),
			north: this.formatCoordinate(bbox.north),
			east: this.formatCoordinate(bbox.east),
		};
	}

	private normalizePointForSignature(point: ParsedPoint): {
		id: string;
		type: ParsedPoint['type'];
		coordinates: Array<{ lat: string; lon: string }>;
		linkedTo: string[];
	} {
		return {
			id: point.id,
			type: point.type,
			coordinates: point.coordinates.map((coordinate) => this.formatPointForSignature(coordinate)),
			linkedTo: [...point.linkedTo].sort((a, b) => a.localeCompare(b)),
		};
	}

	private normalizeRunwayForSignature(runway: RunwayRow): {
		id: number;
		widthFt: string;
		leIdent: string;
		lePoint: { lat: string; lon: string };
		heIdent: string;
		hePoint: { lat: string; lon: string };
	} {
		return {
			id: runway.id,
			widthFt: runway.width_ft,
			leIdent: runway.le_ident,
			lePoint: this.formatPointForSignature({
				lat: Number.parseFloat(runway.le_latitude_deg),
				lon: Number.parseFloat(runway.le_longitude_deg),
			}),
			heIdent: runway.he_ident,
			hePoint: this.formatPointForSignature({
				lat: Number.parseFloat(runway.he_latitude_deg),
				lon: Number.parseFloat(runway.he_longitude_deg),
			}),
		};
	}

	private formatPointForSignature(point: GeoPoint): { lat: string; lon: string } {
		return {
			lat: this.formatCoordinate(point.lat),
			lon: this.formatCoordinate(point.lon),
		};
	}

	private hashString(value: string): string {
		let hash = 0x811c9dc5;
		for (let index = 0; index < value.length; index++) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193);
		}
		return (hash >>> 0).toString(36);
	}

	private async storeIntasTaxiwayCache(
		session: DatabaseSessionService,
		configRecord: VatSysConfigRecord,
		cache: VatSysTaxiwayCache,
	): Promise<void> {
		const nextConfig: VatSysConfig = {
			...configRecord.config,
			intas_osm_taxiways: cache,
		};
		await session.executeWrite(
			`
			UPDATE division_airports
			SET vatsys = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
			`,
			[JSON.stringify(nextConfig), configRecord.id],
		);
	}

	private async getAirportBounds(
		session: DatabaseSessionService,
		icao: string,
	): Promise<{ south: number; west: number; north: number; east: number }> {
		const result = await session.executeRead<AirportBounds>(
			`
			SELECT bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon
			FROM airports
			WHERE icao = ?
			LIMIT 1
			`,
			[icao],
		);
		const row = result.results[0];
		if (!row) {
			throw new HttpError(422, `No airport metadata found for ${icao}`);
		}

		const { bbox_min_lat: south, bbox_min_lon: west, bbox_max_lat: north, bbox_max_lon: east } = row;
		if (
			south === null ||
			west === null ||
			north === null ||
			east === null ||
			!Number.isFinite(south) ||
			!Number.isFinite(west) ||
			!Number.isFinite(north) ||
			!Number.isFinite(east) ||
			south >= north ||
			west >= east
		) {
			throw new HttpError(422, `Airport bounding box is unavailable for ${icao}`);
		}

		return { south, west, north, east };
	}

	private async fetchIntasOsmData(
		icao: string,
		bbox: { south: number; west: number; north: number; east: number },
	): Promise<IntasOsmData> {
		type OverpassElement = {
			type: string;
			id: number;
			geometry?: Array<{ lat?: number; lon?: number }>;
			lat?: number;
			lon?: number;
			tags?: Record<string, string>;
		};
		type OverpassResponse = {
			elements?: OverpassElement[];
		};

		const query = `[out:json][timeout:25];(way["aeroway"="taxiway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});nwr["aeroway"="windsock"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out body geom;`;
		const body = new URLSearchParams({ data: query }).toString();
		const maxAttempts = 3;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const response = await fetch('https://overpass-api.de/api/interpreter', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
						'User-Agent': `BARS-Core/1.0 (INTAS taxiway lookup ${icao})`,
					},
					body,
				});

				if (!response.ok) {
					await cancelResponseBody(response);
					if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts - 1) {
						await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
						continue;
					}
					throw new HttpError(503, `OSM taxiway data unavailable for ${icao}`);
				}

				const json = (await response.json()) as OverpassResponse;
				const taxiwayLines =
					json.elements
						?.filter((element) => element.type === 'way' && element.tags?.aeroway === 'taxiway' && Array.isArray(element.geometry))
						.map((element) =>
							this.normalizeTaxiwayLine(
								element.geometry!.map((point) => ({
									lat: point.lat,
									lon: point.lon,
								})),
							),
						)
						.filter((line): line is GeoPoint[] => line !== null) ?? [];
				const windsocks = this.deduplicatePoints(
					json.elements
						?.filter((element) => element.tags?.aeroway === 'windsock')
						.map((element) => this.getOsmElementPoint(element))
						.filter((point): point is GeoPoint => point !== null) ?? [],
				);

				return { taxiwayLines, windsocks };
			} catch (error) {
				if (error instanceof HttpError) {
					throw error;
				}
				if (attempt < maxAttempts - 1) {
					await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
					continue;
				}
				throw new HttpError(503, `OSM taxiway data unavailable for ${icao}`);
			}
		}

		throw new HttpError(503, `OSM taxiway data unavailable for ${icao}`);
	}

	private buildIntasXml(taxiwayLines: GeoPoint[][], windsocks: GeoPoint[], stopbars: ParsedPoint[], leadOns: ParsedPoint[]): string {
		const linkedLeadOns = this.buildLeadOnLookup(leadOns);
		const lines = ['<?xml version="1.0" ?>', '<Objects>', '  <Taxiways id="Taxiways">'];

		for (const taxiwayLine of taxiwayLines) {
			this.appendIntasLineElement(lines, taxiwayLine, 4);
		}

		lines.push('  </Taxiways>');

		for (const leadOn of [...leadOns].sort((a, b) => a.id.localeCompare(b.id))) {
			lines.push(`  <LeadOn id="${this.escapeXml(leadOn.id)}">`, `    <BARSId>${this.escapeXml(leadOn.id)}</BARSId>`);
			this.appendIntasLineElement(lines, leadOn.coordinates, 4);
			lines.push('  </LeadOn>');
		}

		lines.push('  <Windsocks>');
		for (const windsock of [...windsocks].sort((a, b) => a.lat - b.lat || a.lon - b.lon)) {
			lines.push(`    <Windsock lon="${this.formatCoordinate(windsock.lon)}" lat="${this.formatCoordinate(windsock.lat)}"/>`);
		}
		lines.push('  </Windsocks>', '  <Stopbars>');

		for (const stopbar of [...stopbars].sort((a, b) => a.id.localeCompare(b.id))) {
			const leadOnIds = (linkedLeadOns.get(stopbar.id) ?? []).sort((a, b) => a.id.localeCompare(b.id)).map((leadOn) => leadOn.id);
			lines.push(
				'    <Stopbar>',
				`      <BARSId>${this.escapeXml(stopbar.id)}</BARSId>`,
				`      <DisplayName>${this.escapeXml(stopbar.name)}</DisplayName>`,
				`      <Position lon="${this.formatCoordinate(stopbar.midpoint.lon)}" lat="${this.formatCoordinate(stopbar.midpoint.lat)}"/>`,
				`      <Heading>${Math.round(this.normalizeHeading(stopbar.bearing ?? 0))}</Heading>`,
			);

			for (const leadOnId of leadOnIds) {
				lines.push(`      <LeadOn id="${this.escapeXml(leadOnId)}"/>`);
			}

			lines.push('    </Stopbar>');
		}

		lines.push('  </Stopbars>', '</Objects>');
		return `${lines.join('\n')}\n`;
	}

	private appendIntasLineElement(lines: string[], points: GeoPoint[], baseIndent: number): void {
		const indent = ' '.repeat(baseIndent);
		lines.push(`${indent}<Line>`);
		for (const point of points) {
			lines.push(
				`${indent}  <Point lon="${this.formatCoordinate(point.lon)}" lat="${this.formatCoordinate(point.lat)}"/>`,
			);
		}
		lines.push(`${indent}</Line>`);
	}

	private filterAndSplitTaxiways(lines: GeoPoint[][], stopbars: ParsedPoint[], leadOns: ParsedPoint[], runways: RunwayRow[]): GeoPoint[][] {
		const filtered: GeoPoint[][] = [];
		const runwayExclusionAreas = this.getStopbarRunwayExclusionAreas(runways, stopbars, leadOns);

		for (const line of lines) {
			let current: GeoPoint[] = [];

			for (let index = 0; index < line.length - 1; index++) {
				const start = line[index];
				const end = line[index + 1];
				if (calculateDistance(start, end) < VatSysProfileGeneratorService.INTAS_MIN_TAXIWAY_FRAGMENT_METERS) {
					continue;
				}

				const keptRanges = this.getTaxiwaySegmentKeptRanges(start, end, runwayExclusionAreas);
				for (const range of keptRanges) {
					const rangeStart = this.interpolateGeoPoint(start, end, range.start);
					const rangeEnd = this.interpolateGeoPoint(start, end, range.end);
					if (current.length === 0) {
						current = [rangeStart];
					} else if (calculateDistance(current[current.length - 1], rangeStart) > 0.5) {
						this.pushTaxiwayFragment(filtered, current);
						current = [rangeStart];
					}
					if (calculateDistance(current[current.length - 1], rangeEnd) >= 0.2) {
						current.push(rangeEnd);
					}
				}
			}

			this.pushTaxiwayFragment(filtered, current);
		}

		return this.removeTinyDisconnectedTaxiways(filtered);
	}

	private pushTaxiwayFragment(target: GeoPoint[][], fragment: GeoPoint[]): void {
		const normalized = this.normalizeTaxiwayLine(fragment);
		if (!normalized) return;

		const length = normalized.reduce((sum, point, index) => {
			if (index === 0) return sum;
			return sum + calculateDistance(normalized[index - 1], point);
		}, 0);
		if (length < VatSysProfileGeneratorService.INTAS_MIN_TAXIWAY_FRAGMENT_METERS) return;

		target.push(normalized);
	}

	private removeTinyDisconnectedTaxiways(lines: GeoPoint[][]): GeoPoint[][] {
		return lines.filter((line, lineIndex) => {
			if (this.getTaxiwayLineLength(line) >= VatSysProfileGeneratorService.INTAS_TINY_DISCONNECTED_TAXIWAY_METERS) {
				return true;
			}

			return this.isTaxiwayLineConnected(line, lineIndex, lines);
		});
	}

	private isTaxiwayLineConnected(line: GeoPoint[], lineIndex: number, allLines: GeoPoint[][]): boolean {
		const endpoints = [line[0], line[line.length - 1]].filter((point): point is GeoPoint => point !== undefined);
		return endpoints.some((endpoint) =>
			allLines.some(
				(candidateLine, candidateIndex) =>
					candidateIndex !== lineIndex &&
					candidateLine.some(
						(candidatePoint) =>
							calculateDistance(endpoint, candidatePoint) <=
							VatSysProfileGeneratorService.INTAS_TAXIWAY_CONNECTION_METERS,
					),
			),
		);
	}

	private getTaxiwayLineLength(line: GeoPoint[]): number {
		return line.reduce((sum, point, index) => {
			if (index === 0) return sum;
			return sum + calculateDistance(line[index - 1], point);
		}, 0);
	}

	private getTaxiwaySegmentKeptRanges(
		start: GeoPoint,
		end: GeoPoint,
		runwayExclusionAreas: StopbarRunwayExclusionArea[],
	): Array<{ start: number; end: number }> {
		const segmentLength = calculateDistance(start, end);
		if (segmentLength < VatSysProfileGeneratorService.INTAS_MIN_TAXIWAY_FRAGMENT_METERS) {
			return [];
		}

		const removalRanges = this.getRunwayRemovalRanges(start, end, runwayExclusionAreas);
		if (removalRanges.length === 0) {
			return [{ start: 0, end: 1 }];
		}

		const keptRanges: Array<{ start: number; end: number }> = [];
		let cursor = 0;
		for (const removalRange of removalRanges) {
			if (removalRange.start > cursor) {
				keptRanges.push({ start: cursor, end: removalRange.start });
			}
			cursor = Math.max(cursor, removalRange.end);
		}
		if (cursor < 1) {
			keptRanges.push({ start: cursor, end: 1 });
		}

		const minRatio = VatSysProfileGeneratorService.INTAS_MIN_TAXIWAY_FRAGMENT_METERS / segmentLength;
		return keptRanges.filter((range) => range.end - range.start >= minRatio);
	}

	private getStopbarRunwayExclusionAreas(
		runways: RunwayRow[],
		stopbars: ParsedPoint[],
		leadOns: ParsedPoint[],
	): StopbarRunwayExclusionArea[] {
		const towerPosition = this.getTowerPosition(runways);
		const linkedLeadOns = this.buildLeadOnLookup(leadOns);
		const areas: StopbarRunwayExclusionArea[] = [];

		for (const runway of runways) {
			const axis = this.getRunwayAxis(runway, towerPosition);
			if (!axis) continue;

			const runwayWidthMeters = Number.parseFloat(runway.width_ft) * 0.3048;
			const halfWidthMeters = Number.isFinite(runwayWidthMeters) ? runwayWidthMeters / 2 : 30;
			areas.push({
				axis,
				polygon: this.buildRunwayPavementPolygon(axis, halfWidthMeters),
			});

			const matchedStopbars = this.getStopbarsForRunway(runway, runways, towerPosition, stopbars, linkedLeadOns);
			for (const stopbar of matchedStopbars) {
				const polygon = this.buildStopbarRunwaySidePolygon(stopbar.point, axis, halfWidthMeters);
				if (polygon.length >= 3) {
					areas.push({ axis, polygon });
				}
			}
		}

		for (const leadOn of leadOns) {
			areas.push(...this.buildLeadOnExclusionAreas(leadOn));
		}

		return areas;
	}

	private buildRunwayPavementPolygon(axis: ProfileAxis, halfWidthMeters: number): StopbarBoundaryPoint[] {
		return [
			{ x: 0, y: -halfWidthMeters },
			{ x: axis.lengthMeters, y: -halfWidthMeters },
			{ x: axis.lengthMeters, y: halfWidthMeters },
			{ x: 0, y: halfWidthMeters },
		];
	}

	private buildStopbarRunwaySidePolygon(stopbar: ParsedPoint, axis: ProfileAxis, halfWidthMeters: number): StopbarBoundaryPoint[] {
		if (stopbar.coordinates.length < 2) {
			return [];
		}

		const padding = VatSysProfileGeneratorService.INTAS_STOPBAR_RUNWAY_AREA_PADDING_METERS;
		const midpointProjection = this.projectToAxis(stopbar.midpoint, axis);
		const runwaySideY = midpointProjection.y >= 0 ? -halfWidthMeters - padding : halfWidthMeters + padding;
		const stopbarBoundary = stopbar.coordinates.map((point) => this.projectToAxis(point, axis));
		const runwaySideBoundary = stopbarBoundary
			.map((point) => ({ x: point.x, y: runwaySideY }))
			.reverse();

		return [...stopbarBoundary, ...runwaySideBoundary];
	}

	private buildLeadOnExclusionAreas(leadOn: ParsedPoint): StopbarRunwayExclusionArea[] {
		const areas: StopbarRunwayExclusionArea[] = [];
		const halfWidthMeters = VatSysProfileGeneratorService.INTAS_LEAD_ON_EXCLUSION_METERS;

		for (let index = 0; index < leadOn.coordinates.length - 1; index++) {
			const start = leadOn.coordinates[index];
			const end = leadOn.coordinates[index + 1];
			const lengthMeters = calculateDistance(start, end);
			if (lengthMeters < VatSysProfileGeneratorService.INTAS_MIN_TAXIWAY_FRAGMENT_METERS) {
				continue;
			}
			const endExtensionMeters =
				index === leadOn.coordinates.length - 2
					? VatSysProfileGeneratorService.INTAS_LEAD_ON_END_EXCLUSION_METERS
					: 0;

			areas.push({
				axis: {
					start,
					end,
					leftEndName: leadOn.id,
					rightEndName: leadOn.id,
					lengthMeters,
					bearing: calculateHeading(start, end),
				},
				polygon: [
					{ x: 0, y: -halfWidthMeters },
					{ x: lengthMeters + endExtensionMeters, y: -halfWidthMeters },
					{ x: lengthMeters + endExtensionMeters, y: halfWidthMeters },
					{ x: 0, y: halfWidthMeters },
				],
			});
		}

		return areas;
	}

	private getRunwayRemovalRanges(
		start: GeoPoint,
		end: GeoPoint,
		runwayExclusionAreas: StopbarRunwayExclusionArea[],
	): Array<{ start: number; end: number }> {
		if (runwayExclusionAreas.length === 0) {
			return [];
		}

		const ranges: Array<{ start: number; end: number }> = [];

		for (const runway of runwayExclusionAreas) {
			const projectedStart = this.projectToAxis(start, runway.axis);
			const projectedEnd = this.projectToAxis(end, runway.axis);
			const intersections = this.getLinePolygonIntersectionTs(projectedStart, projectedEnd, runway.polygon);
			const splitTs = [...new Set([0, 1, ...intersections].map((value) => Number(value.toFixed(6))))]
				.sort((a, b) => a - b);

			for (let index = 0; index < splitTs.length - 1; index++) {
				const rangeStart = splitTs[index];
				const rangeEnd = splitTs[index + 1];
				if (rangeEnd - rangeStart < 0.000001) continue;

				const midpointT = (rangeStart + rangeEnd) / 2;
				const midpoint = {
					x: projectedStart.x + (projectedEnd.x - projectedStart.x) * midpointT,
					y: projectedStart.y + (projectedEnd.y - projectedStart.y) * midpointT,
				};
				if (this.isPointInPolygon(midpoint, runway.polygon)) {
					ranges.push({ start: rangeStart, end: rangeEnd });
				}
			}
		}

		return this.mergeRanges(ranges);
	}

	private getLinePolygonIntersectionTs(
		start: StopbarBoundaryPoint,
		end: StopbarBoundaryPoint,
		polygon: StopbarBoundaryPoint[],
	): number[] {
		const intersections: number[] = [];
		for (let index = 0; index < polygon.length; index++) {
			const edgeStart = polygon[index];
			const edgeEnd = polygon[(index + 1) % polygon.length];
			const t = this.getLocalSegmentIntersectionT(start, end, edgeStart, edgeEnd);
			if (t !== null && t > 0.000001 && t < 0.999999) {
				intersections.push(t);
			}
		}
		return intersections;
	}

	private getLocalSegmentIntersectionT(
		segmentStart: StopbarBoundaryPoint,
		segmentEnd: StopbarBoundaryPoint,
		edgeStart: StopbarBoundaryPoint,
		edgeEnd: StopbarBoundaryPoint,
	): number | null {
		const r = { x: segmentEnd.x - segmentStart.x, y: segmentEnd.y - segmentStart.y };
		const s = { x: edgeEnd.x - edgeStart.x, y: edgeEnd.y - edgeStart.y };
		const denominator = this.crossLocal(r, s);
		if (Math.abs(denominator) < 0.000001) {
			return null;
		}

		const edgeDelta = { x: edgeStart.x - segmentStart.x, y: edgeStart.y - segmentStart.y };
		const t = this.crossLocal(edgeDelta, s) / denominator;
		const u = this.crossLocal(edgeDelta, r) / denominator;
		if (t < -0.000001 || t > 1.000001 || u < -0.000001 || u > 1.000001) {
			return null;
		}

		return this.clamp(t, 0, 1);
	}

	private isPointInPolygon(point: StopbarBoundaryPoint, polygon: StopbarBoundaryPoint[]): boolean {
		let inside = false;
		for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index++) {
			const current = polygon[index];
			const previous = polygon[previousIndex];
			const intersects =
				current.y > point.y !== previous.y > point.y &&
				point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
			if (intersects) {
				inside = !inside;
			}
		}
		return inside;
	}

	private crossLocal(a: StopbarBoundaryPoint, b: StopbarBoundaryPoint): number {
		return a.x * b.y - a.y * b.x;
	}

	private mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
		const sorted = ranges
			.filter((range) => range.end > range.start)
			.sort((a, b) => a.start - b.start || a.end - b.end);
		const merged: Array<{ start: number; end: number }> = [];

		for (const range of sorted) {
			const previous = merged[merged.length - 1];
			if (!previous || range.start > previous.end + 0.001) {
				merged.push({ ...range });
			} else {
				previous.end = Math.max(previous.end, range.end);
			}
		}

		return merged;
	}

	private interpolateGeoPoint(start: GeoPoint, end: GeoPoint, t: number): GeoPoint {
		return {
			lat: start.lat + (end.lat - start.lat) * t,
			lon: start.lon + (end.lon - start.lon) * t,
		};
	}

	private normalizeTaxiwayLine(rawLine: Array<Partial<GeoPoint>>): GeoPoint[] | null {
		const points: GeoPoint[] = [];
		for (const point of rawLine) {
			const normalized = this.normalizeGeoPoint(point);
			if (!normalized) continue;
			const previous = points[points.length - 1];
			if (previous && calculateDistance(previous, normalized) < 0.1) {
				continue;
			}
			points.push(normalized);
		}

		return points.length >= 2 ? points : null;
	}

	private normalizeGeoPoint(point: Partial<GeoPoint>): GeoPoint | null {
		const lat = point.lat;
		const lon = point.lon;
		if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
			return null;
		}
		return {
			lat: this.roundCoordinate(lat),
			lon: this.roundCoordinate(lon),
		};
	}

	private getOsmElementPoint(element: { lat?: number; lon?: number; geometry?: Array<{ lat?: number; lon?: number }> }): GeoPoint | null {
		const nodePoint = this.normalizeGeoPoint({ lat: element.lat, lon: element.lon });
		if (nodePoint) return nodePoint;
		const geometry = element.geometry ?? [];
		const points = geometry.map((point) => this.normalizeGeoPoint(point)).filter((point): point is GeoPoint => point !== null);
		return points.length > 0 ? this.getMidpoint(points) : null;
	}

	private deduplicatePoints(points: GeoPoint[]): GeoPoint[] {
		const deduplicated: GeoPoint[] = [];
		for (const point of points) {
			if (!deduplicated.some((existing) => calculateDistance(existing, point) <= 1)) {
				deduplicated.push(point);
			}
		}
		return deduplicated;
	}

	private parsePoint(row: PointRow): ParsedPoint | null {
		const coordinates = this.parseCoordinates(row.coordinates);
		if (coordinates.length === 0) {
			return null;
		}

		return {
			id: row.id,
			type: row.type,
			name: row.name,
			coordinates,
			linkedTo: this.parseLinkedTo(row.linked_to),
			midpoint: this.getMidpoint(coordinates),
			bearing: coordinates.length >= 2 ? calculateHeading(coordinates[0], coordinates[coordinates.length - 1]) : null,
		};
	}

	private parseCoordinates(rawCoordinates: string): GeoPoint[] {
		try {
			const parsed = JSON.parse(rawCoordinates) as unknown;
			const rawPoints = Array.isArray(parsed) ? parsed : [parsed];
			return rawPoints
				.map((value) => {
					if (!value || typeof value !== 'object') return null;
					const point = value as { lat?: unknown; lng?: unknown; lon?: unknown };
					const lat = typeof point.lat === 'number' ? point.lat : null;
					const lon = typeof point.lng === 'number' ? point.lng : typeof point.lon === 'number' ? point.lon : null;
					if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
					return { lat, lon };
				})
				.filter((point): point is GeoPoint => point !== null);
		} catch {
			return [];
		}
	}

	private parseLinkedTo(rawLinkedTo: string | null): string[] {
		if (!rawLinkedTo) return [];
		try {
			const parsed = JSON.parse(rawLinkedTo) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
			}
			if (typeof parsed === 'string' && parsed.length > 0) {
				return [parsed];
			}
		} catch {
			return [rawLinkedTo];
		}
		return [];
	}

	private getRunwayAxis(runway: RunwayRow, towerPosition?: GeoPoint): ProfileAxis | null {
		const leEnd = this.parseRunwayPoint(runway.le_latitude_deg, runway.le_longitude_deg);
		const heEnd = this.parseRunwayPoint(runway.he_latitude_deg, runway.he_longitude_deg);
		if (!leEnd || !heEnd) return null;

		const lengthMeters = calculateDistance(leEnd, heEnd);
		if (!Number.isFinite(lengthMeters) || lengthMeters < VatSysProfileGeneratorService.MIN_RUNWAY_LENGTH_METERS) {
			return null;
		}

		const oriented = this.orientRunwayEnds(runway, leEnd, heEnd, towerPosition);
		return {
			start: oriented.leftEnd,
			end: oriented.rightEnd,
			leftEndName: oriented.leftEndName,
			rightEndName: oriented.rightEndName,
			lengthMeters,
			bearing: calculateHeading(oriented.leftEnd, oriented.rightEnd),
		};
	}

	private orientRunwayEnds(
		runway: RunwayRow,
		leEnd: GeoPoint,
		heEnd: GeoPoint,
		towerPosition?: GeoPoint,
	): { leftEnd: GeoPoint; rightEnd: GeoPoint; leftEndName: string; rightEndName: string } {
		const mapOriented = this.orientRunwayEndsByMapAxis(runway, leEnd, heEnd);
		if (mapOriented) {
			return mapOriented;
		}

		if (towerPosition) {
			const center = this.getMidpoint([leEnd, heEnd]);
			const towerLocal = this.toLocalMeters(towerPosition, towerPosition);
			const centerLocal = this.toLocalMeters(center, towerPosition);
			const forwardEast = centerLocal.east - towerLocal.east;
			const forwardNorth = centerLocal.north - towerLocal.north;
			const forwardLength = Math.hypot(forwardEast, forwardNorth);

			if (forwardLength >= VatSysProfileGeneratorService.MIN_TOWER_VIEW_DISTANCE_METERS) {
				const normalizedForwardEast = forwardEast / forwardLength;
				const normalizedForwardNorth = forwardNorth / forwardLength;
				const rightVector = {
					east: normalizedForwardNorth,
					north: -normalizedForwardEast,
				};
				const leLocal = this.toLocalMeters(leEnd, towerPosition);
				const heLocal = this.toLocalMeters(heEnd, towerPosition);
				const leRight = leLocal.east * rightVector.east + leLocal.north * rightVector.north;
				const heRight = heLocal.east * rightVector.east + heLocal.north * rightVector.north;

				if (leRight < heRight) {
					return { leftEnd: leEnd, rightEnd: heEnd, leftEndName: runway.le_ident, rightEndName: runway.he_ident };
				}
				return { leftEnd: heEnd, rightEnd: leEnd, leftEndName: runway.he_ident, rightEndName: runway.le_ident };
			}
		}

		const leLocal = this.toLocalMeters(leEnd, leEnd);
		const heLocal = this.toLocalMeters(heEnd, leEnd);
		if (Math.abs(heLocal.east - leLocal.east) >= Math.abs(heLocal.north - leLocal.north)) {
			if (leLocal.east <= heLocal.east) {
				return { leftEnd: leEnd, rightEnd: heEnd, leftEndName: runway.le_ident, rightEndName: runway.he_ident };
			}
			return { leftEnd: heEnd, rightEnd: leEnd, leftEndName: runway.he_ident, rightEndName: runway.le_ident };
		}

		if (leLocal.north >= heLocal.north) {
			return { leftEnd: leEnd, rightEnd: heEnd, leftEndName: runway.le_ident, rightEndName: runway.he_ident };
		}
		return { leftEnd: heEnd, rightEnd: leEnd, leftEndName: runway.he_ident, rightEndName: runway.le_ident };
	}

	private orientRunwayEndsByMapAxis(
		runway: RunwayRow,
		leEnd: GeoPoint,
		heEnd: GeoPoint,
	): { leftEnd: GeoPoint; rightEnd: GeoPoint; leftEndName: string; rightEndName: string } | null {
		const heLocal = this.toLocalMeters(heEnd, leEnd);
		const absEast = Math.abs(heLocal.east);
		const absNorth = Math.abs(heLocal.north);
		const dominantRatio = 1.25;

		if (absEast >= absNorth * dominantRatio) {
			if (heLocal.east >= 0) {
				return { leftEnd: leEnd, rightEnd: heEnd, leftEndName: runway.le_ident, rightEndName: runway.he_ident };
			}
			return { leftEnd: heEnd, rightEnd: leEnd, leftEndName: runway.he_ident, rightEndName: runway.le_ident };
		}

		if (absNorth >= absEast * dominantRatio) {
			if (heLocal.north <= 0) {
				return { leftEnd: leEnd, rightEnd: heEnd, leftEndName: runway.le_ident, rightEndName: runway.he_ident };
			}
			return { leftEnd: heEnd, rightEnd: leEnd, leftEndName: runway.he_ident, rightEndName: runway.le_ident };
		}

		return null;
	}

	private parseRunwayPoint(rawLat: string, rawLon: string): GeoPoint | null {
		const lat = Number.parseFloat(rawLat);
		const lon = Number.parseFloat(rawLon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
		return { lat, lon };
	}

	private getTowerPosition(runways: RunwayRow[]): GeoPoint {
		const runwayPoints = runways.flatMap((runway) => {
			const leEnd = this.parseRunwayPoint(runway.le_latitude_deg, runway.le_longitude_deg);
			const heEnd = this.parseRunwayPoint(runway.he_latitude_deg, runway.he_longitude_deg);
			return [leEnd, heEnd].filter((point): point is GeoPoint => point !== null);
		});
		return this.getMidpoint(runwayPoints);
	}

	private getStopbarsForRunway(
		selectedRunway: RunwayRow,
		allRunways: RunwayRow[],
		towerPosition: GeoPoint,
		stopbars: ParsedPoint[],
		linkedLeadOns: Map<string, ParsedPoint[]>,
	): ProjectedPoint[] {
		const selectedAxis = this.getRunwayAxis(selectedRunway, towerPosition);
		if (!selectedAxis) return [];

		return stopbars
			.map((stopbar) => {
				const bestMatch = this.getBestRunwayMatch(stopbar, allRunways, towerPosition);
				if (bestMatch?.runwayId === selectedRunway.id) {
					return bestMatch;
				}
				return this.getSharedRunwayProjection(stopbar, selectedRunway, selectedAxis, linkedLeadOns.get(stopbar.id) ?? []);
			})
			.filter((match): match is ProjectedPoint => match !== null)
			.sort((a, b) => a.x - b.x || a.point.id.localeCompare(b.point.id));
	}

	private getSharedRunwayProjection(
		stopbar: ParsedPoint,
		runway: RunwayRow,
		axis: ProfileAxis,
		linkedLeadOns: ParsedPoint[],
	): ProjectedPoint | null {
		const touchProjection = this.getLeadOnRunwayTouchProjection(linkedLeadOns, axis);
		if (!touchProjection) {
			return null;
		}

		const projected = this.projectStopbar(stopbar, runway, axis, this.getStopbarPositionForAxis(stopbar, axis));
		if (!projected) return null;
		projected.x = touchProjection.x;

		const lateralLimit = this.getRunwayLateralLimit(runway) * VatSysProfileGeneratorService.SHARED_STOPBAR_LATERAL_MULTIPLIER;
		const longitudinalPadding = this.getRunwayLongitudinalPadding(axis);
		if (
			projected.x < -longitudinalPadding ||
			projected.x > axis.lengthMeters + longitudinalPadding ||
			Math.abs(projected.y) > lateralLimit
		) {
			return null;
		}

		return projected;
	}

	private getLeadOnRunwayTouchProjection(linkedLeadOns: ParsedPoint[], axis: ProfileAxis): { x: number; y: number } | null {
		const touches = linkedLeadOns
			.flatMap((leadOn) => this.getLeadOnEndpoints(leadOn))
			.map((endpoint) => this.projectToAxis(endpoint, axis))
			.filter(
				(projected) =>
					projected.x >= -VatSysProfileGeneratorService.LEAD_ON_RUNWAY_TOUCH_DISTANCE_METERS &&
					projected.x <= axis.lengthMeters + VatSysProfileGeneratorService.LEAD_ON_RUNWAY_TOUCH_DISTANCE_METERS &&
					Math.abs(projected.y) <= VatSysProfileGeneratorService.LEAD_ON_RUNWAY_TOUCH_DISTANCE_METERS,
			)
			.sort((a, b) => Math.abs(a.y) - Math.abs(b.y) || a.x - b.x);

		return touches[0] ?? null;
	}

	private getLeadOnEndpoints(leadOn: ParsedPoint): GeoPoint[] {
		if (leadOn.coordinates.length === 0) return [];
		if (leadOn.coordinates.length === 1) return [leadOn.coordinates[0]];
		const first = leadOn.coordinates[0];
		const last = leadOn.coordinates[leadOn.coordinates.length - 1];
		return [first, last];
	}

	private getBestRunwayMatch(stopbar: ParsedPoint, runways: RunwayRow[], towerPosition: GeoPoint): ProjectedPoint | null {
		const matches = runways
			.map((runway) => {
				const axis = this.getRunwayAxis(runway, towerPosition);
				if (!axis) return null;
				const projected = this.projectStopbar(stopbar, runway, axis);
				if (!projected || !this.isStopbarRelevant(projected, axis, runway)) return null;
				return projected;
			})
			.filter((match): match is ProjectedPoint => match !== null)
			.sort((a, b) => a.score - b.score || a.runwayId - b.runwayId);

		return matches[0] ?? null;
	}

	private projectStopbar(stopbar: ParsedPoint, runway: RunwayRow, axis: ProfileAxis, position = stopbar.midpoint): ProjectedPoint | null {
		if (stopbar.bearing === null) return null;
		const projected = this.projectToAxis(position, axis);
		const angleDiff = this.getLineAngleDifference(stopbar.bearing, axis.bearing);
		const lateralLimit = this.getRunwayLateralLimit(runway);
		const longitudinalPadding = this.getRunwayLongitudinalPadding(axis);
		const longitudinalOverflow = Math.max(0, -projected.x, projected.x - axis.lengthMeters);
		return {
			point: stopbar,
			runwayId: runway.id,
			x: projected.x,
			y: projected.y,
			angleDiff,
			score:
				Math.abs(projected.y) / lateralLimit +
				angleDiff / VatSysProfileGeneratorService.MAX_PARALLEL_ANGLE_DIFF +
				longitudinalOverflow / longitudinalPadding,
		};
	}

	private getStopbarPositionForAxis(stopbar: ParsedPoint, axis: ProfileAxis): GeoPoint {
		return [stopbar.midpoint, ...stopbar.coordinates].sort((a, b) => {
			const projectedA = this.projectToAxis(a, axis);
			const projectedB = this.projectToAxis(b, axis);
			const lateralDiff = Math.abs(projectedA.y) - Math.abs(projectedB.y);
			if (lateralDiff !== 0) return lateralDiff;
			return Math.abs(projectedA.x - axis.lengthMeters / 2) - Math.abs(projectedB.x - axis.lengthMeters / 2);
		})[0];
	}

	private isStopbarRelevant(stopbar: ProjectedPoint, axis: ProfileAxis, runway: RunwayRow): boolean {
		const lateralLimit = this.getRunwayLateralLimit(runway);
		const longitudinalPadding = this.getRunwayLongitudinalPadding(axis);
		return (
			stopbar.angleDiff <= VatSysProfileGeneratorService.MAX_PARALLEL_ANGLE_DIFF &&
			stopbar.x >= -longitudinalPadding &&
			stopbar.x <= axis.lengthMeters + longitudinalPadding &&
			Math.abs(stopbar.y) <= lateralLimit
		);
	}

	private getRunwayLateralLimit(runway: RunwayRow): number {
		const runwayWidthMeters = Number.parseFloat(runway.width_ft) * 0.3048;
		const widthBasedLimit = Number.isFinite(runwayWidthMeters) ? runwayWidthMeters * 5 : 220;
		return this.clamp(widthBasedLimit, 180, 320);
	}

	private getRunwayLongitudinalPadding(axis: ProfileAxis): number {
		return this.clamp(axis.lengthMeters * 0.04, 100, 220);
	}

	private projectToAxis(point: GeoPoint, axis: ProfileAxis): { x: number; y: number } {
		const { east, north } = this.toLocalMeters(point, axis.start);
		const bearingRad = (axis.bearing * Math.PI) / 180;
		const unitEast = Math.sin(bearingRad);
		const unitNorth = Math.cos(bearingRad);

		return {
			x: east * unitEast + north * unitNorth,
			y: east * -unitNorth + north * unitEast,
		};
	}

	private toLocalMeters(point: GeoPoint, origin: GeoPoint): { east: number; north: number } {
		const earthRadiusMeters = 6371000;
		const originLatRad = (origin.lat * Math.PI) / 180;
		const deltaLat = ((point.lat - origin.lat) * Math.PI) / 180;
		const deltaLon = ((point.lon - origin.lon) * Math.PI) / 180;
		return {
			east: deltaLon * Math.cos(originLatRad) * earthRadiusMeters,
			north: deltaLat * earthRadiusMeters,
		};
	}

	private getLineAngleDifference(a: number, b: number): number {
		const diff = Math.abs((((a - b) % 180) + 180) % 180);
		return diff > 90 ? 180 - diff : diff;
	}

	private normalizeHeading(value: number): number {
		const normalized = value % 360;
		return normalized < 0 ? normalized + 360 : normalized;
	}

	private buildLeadOnLookup(leadOns: ParsedPoint[]): Map<string, ParsedPoint[]> {
		const lookup = new Map<string, ParsedPoint[]>();
		for (const leadOn of leadOns) {
			for (const stopbarId of leadOn.linkedTo) {
				const existing = lookup.get(stopbarId) ?? [];
				existing.push(leadOn);
				lookup.set(stopbarId, existing);
			}
		}
		return lookup;
	}

	private assignLegacySlots(
		stopbars: ProjectedPoint[],
		firstSlot: number,
		axis: ProfileAxis,
		crossbar: CrossbarConfig | null,
		linkedLeadOns: Map<string, ParsedPoint[]>,
		warnings: string[],
	): LegacyStopbarEntry[] {
		const sorted = [...stopbars].sort((a, b) => a.x - b.x || a.point.id.localeCompare(b.point.id));
		const desiredIndexes = sorted.map((stopbar) => this.getLegacySlotIndex(stopbar, axis, crossbar));
		const assignedIndexes = this.assignOrderedIndexes(desiredIndexes, VatSysProfileGeneratorService.MAX_STOPBARS_PER_SIDE);

		return sorted.map((stopbar, index) =>
			this.toLegacyStopbarEntry(stopbar, firstSlot + assignedIndexes[index], linkedLeadOns, warnings),
		);
	}

	private getLegacySlotIndex(stopbar: ProjectedPoint, axis: ProfileAxis, crossbar: CrossbarConfig | null): number {
		if (!crossbar) {
			const ratio = axis.lengthMeters > 0 ? this.clamp(stopbar.x / axis.lengthMeters, 0, 1) : 0;
			return Math.round(ratio * (VatSysProfileGeneratorService.MAX_STOPBARS_PER_SIDE - 1));
		}

		const splitX = this.clamp(crossbar.crossingX, axis.lengthMeters * 0.2, axis.lengthMeters * 0.8);
		const slotX = this.getCrossbarAwareSlotX(stopbar, axis, splitX);
		if (slotX <= splitX) {
			const leftRatio = splitX > 0 ? this.clamp(slotX / splitX, 0, 1) : 0;
			return Math.round(leftRatio * 7);
		}

		const rightLength = Math.max(1, axis.lengthMeters - splitX);
		const rightRatio = this.clamp((slotX - splitX) / rightLength, 0, 1);
		return 8 + Math.round(rightRatio * 7);
	}

	private getCrossbarAwareSlotX(stopbar: ProjectedPoint, axis: ProfileAxis, splitX: number): number {
		const coordinateXs = stopbar.point.coordinates.map((point) => this.projectToAxis(point, axis).x);
		if (coordinateXs.length === 0) return stopbar.x;

		const minX = Math.min(...coordinateXs, stopbar.x);
		const maxX = Math.max(...coordinateXs, stopbar.x);
		const closeToSplit = Math.abs(stopbar.x - splitX) <= VatSysProfileGeneratorService.CROSSBAR_SIDE_SNAP_METERS;
		if (!closeToSplit || minX > splitX || maxX <= splitX) {
			return stopbar.x;
		}

		return stopbar.x <= splitX ? maxX : minX;
	}

	private assignOrderedIndexes(desiredIndexes: number[], slotCount: number): number[] {
		if (desiredIndexes.length === 0) return [];

		const desiredSpan = desiredIndexes[desiredIndexes.length - 1] - desiredIndexes[0] + 1;
		if (desiredSpan < desiredIndexes.length) {
			const averageDesired = desiredIndexes.reduce((sum, value) => sum + value, 0) / desiredIndexes.length;
			const firstIndex = Math.round(averageDesired - (desiredIndexes.length - 1) / 2);
			const clampedFirstIndex = this.clamp(firstIndex, 0, slotCount - desiredIndexes.length);
			return desiredIndexes.map((_, index) => clampedFirstIndex + index);
		}

		const assigned = [...desiredIndexes];
		for (let index = assigned.length - 1; index >= 0; index--) {
			const latestAvailable = slotCount - (assigned.length - index);
			assigned[index] = Math.min(assigned[index], latestAvailable);
		}
		for (let index = 0; index < assigned.length; index++) {
			const earliestAvailable = index === 0 ? 0 : assigned[index - 1] + 1;
			assigned[index] = Math.max(assigned[index], earliestAvailable);
		}
		return assigned;
	}

	private alignOppositeStopbarSlots(entries: LegacyStopbarEntry[]): LegacyStopbarEntry[] {
		const aligned = entries.map((entry) => ({ ...entry }));
		const topByName = new Map<string, LegacyStopbarEntry[]>();
		const bottomByName = new Map<string, LegacyStopbarEntry[]>();
		const occupiedTop = new Set<number>();
		const occupiedBottom = new Set<number>();

		for (const entry of aligned) {
			const rowIndex = this.getLegacyRowIndex(entry.slot);
			if (rowIndex === null) continue;
			if (entry.slot <= VatSysProfileGeneratorService.MAX_STOPBARS_PER_SIDE) {
				occupiedTop.add(rowIndex);
				this.addEntryByName(topByName, entry);
			} else {
				occupiedBottom.add(rowIndex);
				this.addEntryByName(bottomByName, entry);
			}
		}

		const usedBottomEntries = new Set<LegacyStopbarEntry>();
		for (const [name, topEntries] of topByName) {
			const bottomEntries = bottomByName.get(name) ?? [];
			for (const topEntry of topEntries.sort((a, b) => a.stopbar.x - b.stopbar.x)) {
				const bottomEntry = bottomEntries
					.filter((entry) => !usedBottomEntries.has(entry))
					.sort((a, b) => Math.abs(a.stopbar.x - topEntry.stopbar.x) - Math.abs(b.stopbar.x - topEntry.stopbar.x))[0];
				if (!bottomEntry) continue;

				if (this.alignOppositeStopbarPair(topEntry, bottomEntry, occupiedTop, occupiedBottom)) {
					usedBottomEntries.add(bottomEntry);
				}
			}
		}

		return aligned;
	}

	private addEntryByName(entriesByName: Map<string, LegacyStopbarEntry[]>, entry: LegacyStopbarEntry): void {
		const normalizedName = entry.stopbar.point.name.trim().toUpperCase();
		const entries = entriesByName.get(normalizedName) ?? [];
		entries.push(entry);
		entriesByName.set(normalizedName, entries);
	}

	private alignOppositeStopbarPair(
		topEntry: LegacyStopbarEntry,
		bottomEntry: LegacyStopbarEntry,
		occupiedTop: Set<number>,
		occupiedBottom: Set<number>,
	): boolean {
		const topIndex = this.getLegacyRowIndex(topEntry.slot);
		const bottomIndex = this.getLegacyRowIndex(bottomEntry.slot);
		if (topIndex === null || bottomIndex === null) return false;

		const slotGap = Math.abs(topIndex - bottomIndex);
		const closeEnough = Math.abs(topEntry.stopbar.x - bottomEntry.stopbar.x) <= 240;
		if (!closeEnough || slotGap === 0 || slotGap > 2) return false;

		if (topIndex < bottomIndex) {
			if (this.moveEntryToRowIndex(topEntry, bottomIndex, occupiedTop, 1)) return true;
			return this.moveEntryToRowIndex(bottomEntry, topIndex, occupiedBottom, 17);
		}

		if (this.moveEntryToRowIndex(topEntry, bottomIndex, occupiedTop, 1)) return true;
		return this.moveEntryToRowIndex(bottomEntry, topIndex, occupiedBottom, 17);
	}

	private moveEntryToRowIndex(entry: LegacyStopbarEntry, targetIndex: number, occupied: Set<number>, firstSlot: number): boolean {
		const currentIndex = this.getLegacyRowIndex(entry.slot);
		if (currentIndex === null || occupied.has(targetIndex)) return false;

		occupied.delete(currentIndex);
		occupied.add(targetIndex);
		entry.slot = firstSlot + targetIndex;
		return true;
	}

	private getLegacyRowIndex(slot: number): number | null {
		if (slot >= 1 && slot <= 16) return slot - 1;
		if (slot >= 17 && slot <= 32) return slot - 17;
		return null;
	}

	private toLegacyStopbarEntry(
		stopbar: ProjectedPoint,
		slot: number,
		linkedLeadOns: Map<string, ParsedPoint[]>,
		warnings: string[],
	): LegacyStopbarEntry {
		const linkedLeadOnCandidates = linkedLeadOns.get(stopbar.point.id) ?? [];
		const leadOnIds = linkedLeadOnCandidates
			.filter((leadOn) => {
				if (leadOn.coordinates.length === 0) {
					warnings.push(`Linked lead-on ${leadOn.id} for stopbar ${stopbar.point.id} has no usable coordinates`);
					return false;
				}
				return true;
			})
			.sort((a, b) => {
				const distanceDiff = calculateDistance(a.midpoint, stopbar.point.midpoint) - calculateDistance(b.midpoint, stopbar.point.midpoint);
				if (distanceDiff !== 0) return distanceDiff;
				return a.id.localeCompare(b.id);
			})
			.map((leadOn) => leadOn.id);

		return { slot, stopbar, leadOnIds };
	}

	private getCrossbarConfig(
		selectedRunway: RunwayRow,
		allRunways: RunwayRow[],
		axis: ProfileAxis,
		stopbars: ParsedPoint[],
	): CrossbarConfig | null {
		for (const runway of allRunways) {
			if (runway.id === selectedRunway.id) continue;

			const otherStart = this.parseRunwayPoint(runway.le_latitude_deg, runway.le_longitude_deg);
			const otherEnd = this.parseRunwayPoint(runway.he_latitude_deg, runway.he_longitude_deg);
			if (!otherStart || !otherEnd) continue;

			const startProjection = this.projectToAxis(otherStart, axis);
			const endProjection = this.projectToAxis(otherEnd, axis);
			const crossesSide = startProjection.y === 0 || endProjection.y === 0 || Math.sign(startProjection.y) !== Math.sign(endProjection.y);
			const crossingX = this.interpolateCrossingX(startProjection, endProjection);
			const withinRunway = crossingX >= -VatSysProfileGeneratorService.CROSSING_DISTANCE_METERS && crossingX <= axis.lengthMeters + VatSysProfileGeneratorService.CROSSING_DISTANCE_METERS;

			if (!crossesSide || !withinRunway) continue;

			const topName = startProjection.y >= endProjection.y ? runway.le_ident : runway.he_ident;
			const bottomName = startProjection.y < endProjection.y ? runway.le_ident : runway.he_ident;
			const topPoint = this.findCrossbarPoint(topName, crossingX, axis, stopbars);
			const bottomPoint = this.findCrossbarPoint(bottomName, crossingX, axis, stopbars);
			return {
				topName,
				bottomName,
				crossingX,
				topBarsId: topPoint?.id,
				bottomBarsId: bottomPoint?.id,
			};
		}
		return null;
	}

	private findCrossbarPoint(name: string, crossingX: number, axis: ProfileAxis, stopbars: ParsedPoint[]): ParsedPoint | null {
		const candidates = stopbars
			.filter((stopbar) => stopbar.name.trim().toUpperCase() === name.trim().toUpperCase())
			.map((stopbar) => {
				const projected = this.projectToAxis(stopbar.midpoint, axis);
				return {
					stopbar,
					distance: Math.hypot(projected.x - crossingX, projected.y),
				};
			})
			.filter((candidate) => candidate.distance <= 300)
			.sort((a, b) => a.distance - b.distance || a.stopbar.id.localeCompare(b.stopbar.id));

		return candidates[0]?.stopbar ?? null;
	}

	private isCrossbarPoint(point: ParsedPoint, crossbar: CrossbarConfig | null): boolean {
		if (!crossbar) return false;
		return point.id === crossbar.topBarsId || point.id === crossbar.bottomBarsId;
	}

	private interpolateCrossingX(start: { x: number; y: number }, end: { x: number; y: number }): number {
		const denominator = start.y - end.y;
		if (Math.abs(denominator) < 0.0001) {
			return (start.x + end.x) / 2;
		}
		const ratio = start.y / denominator;
		return start.x + (end.x - start.x) * ratio;
	}

	private clamp(value: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, value));
	}

	private roundCoordinate(value: number): number {
		return Math.round(value * 10_000_000) / 10_000_000;
	}

	private formatCoordinate(value: number): string {
		return this.roundCoordinate(value).toString();
	}

	private getMidpoint(points: GeoPoint[]): GeoPoint {
		const totals = points.reduce(
			(acc, point) => ({
				lat: acc.lat + point.lat,
				lon: acc.lon + point.lon,
			}),
			{ lat: 0, lon: 0 },
		);
		return {
			lat: totals.lat / points.length,
			lon: totals.lon / points.length,
		};
	}

	private buildLegacyXml(
		icao: string,
		leftEndName: string,
		rightEndName: string,
		stopbars: LegacyStopbarEntry[],
		crossbar: CrossbarConfig | null,
	): string {
		const lines = [
			'<?xml version="1.0" encoding="utf-8"?>',
			'<BARSProfile>',
			'  <AirportInfo>',
			`    <ICAO>${this.escapeXml(icao)}</ICAO>`,
			'  </AirportInfo>',
			'  <RunwayConfig>',
			'    <HorizontalRunway>',
			'      <Visible>true</Visible>',
			'      <LeftEnd>',
			`        <Name>${this.escapeXml(leftEndName)}</Name>`,
			'      </LeftEnd>',
			'      <RightEnd>',
			`        <Name>${this.escapeXml(rightEndName)}</Name>`,
			'      </RightEnd>',
			'    </HorizontalRunway>',
		];

		if (crossbar) {
			lines.push(
				'    <VerticalRunway>',
				'      <Visible>true</Visible>',
				'      <TopEnd>',
				`        <Name>${this.escapeXml(crossbar.topName)}</Name>`,
				'      </TopEnd>',
				'      <BottomEnd>',
				`        <Name>${this.escapeXml(crossbar.bottomName)}</Name>`,
				'      </BottomEnd>',
				'    </VerticalRunway>',
			);
		}

		lines.push('  </RunwayConfig>', '  <Stopbars>');

		for (const entry of stopbars) {
			lines.push(
				'    <Stopbar>',
				`      <ID>s${entry.slot}</ID>`,
				`      <BARSId>${this.escapeXml(entry.stopbar.point.id)}</BARSId>`,
				`      <DisplayName>${this.escapeXml(entry.stopbar.point.name)}</DisplayName>`,
			);
			for (const leadOnId of entry.leadOnIds) {
				lines.push(`      <LeadOnId>${this.escapeXml(leadOnId)}</LeadOnId>`);
			}
			lines.push('    </Stopbar>');
		}

		lines.push('  </Stopbars>');

		if (crossbar?.topBarsId && crossbar.bottomBarsId) {
			lines.push(
				'  <CrossbarsConfig>',
				'    <Crossbar>',
				'      <ID>T_S</ID>',
				`      <BARSId>${this.escapeXml(crossbar.topBarsId)}</BARSId>`,
				`      <DisplayName>${this.escapeXml(crossbar.topName)}</DisplayName>`,
				'    </Crossbar>',
				'    <Crossbar>',
				'      <ID>B_S</ID>',
				`      <BARSId>${this.escapeXml(crossbar.bottomBarsId)}</BARSId>`,
				`      <DisplayName>${this.escapeXml(crossbar.bottomName)}</DisplayName>`,
				'    </Crossbar>',
				'  </CrossbarsConfig>',
			);
		}

		lines.push('</BARSProfile>');
		return `${lines.join('\n')}\n`;
	}

	private escapeXml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;');
	}

	private sanitizeFilenamePart(value: string): string {
		return value.replace(/[^A-Za-z0-9-]/g, '');
	}
}
