import { DatabaseSessionService } from './database-session';
import { PostHogService } from './posthog';
import { calculateDistance } from './bars/geoUtils';
import { HttpError } from './errors';
import { cancelResponseBody } from './http';

interface AirportData {
	latitude_deg?: number;
	longitude_deg?: number;
	name?: string;
	continent?: string;
	iso_country?: string;
	country?: {
		code?: string;
		name?: string;
	};
	region?: {
		name?: string;
	};
	elevation_ft?: string;
	runways?: Array<{
		length_ft: string;
		width_ft: string;
		le_ident: string;
		le_latitude_deg: string;
		le_longitude_deg: string;
		he_ident: string;
		he_latitude_deg: string;
		he_longitude_deg: string;
		closed?: string;
	}>;
}

export type AirportRecord = {
	icao: string;
	latitude: number | null;
	longitude: number | null;
	name: string;
	continent: string;
	country_code: string | null;
	country_name: string | null;
	region_name: string | null;
	elevation_ft: number | null;
	elevation_m: number | null;
	bbox_min_lat: number | null;
	bbox_min_lon: number | null;
	bbox_max_lat: number | null;
	bbox_max_lon: number | null;
};

type AirportReadRecord = AirportRecord & {
	id: number | null;
};

export type RunwayRecord = {
	length_ft: string;
	width_ft: string;
	le_ident: string;
	le_latitude_deg: string;
	le_longitude_deg: string;
	he_ident: string;
	he_latitude_deg: string;
	he_longitude_deg: string;
};

export interface AirportCreateInput {
	icao: string;
	latitude: number;
	longitude: number;
	name: string;
	continent: string;
	country_code: string | null;
	country_name: string | null;
	region_name: string | null;
	elevation_ft: number | null;
	elevation_m: number | null;
	bbox_min_lat: number | null;
	bbox_min_lon: number | null;
	bbox_max_lat: number | null;
	bbox_max_lon: number | null;
	runways: RunwayRecord[];
}

export type AirportUpdateInput = Partial<Omit<AirportCreateInput, 'icao' | 'runways'>> & {
	runways?: RunwayRecord[];
};

const AIRPORT_FIELDS = new Set([
	'icao',
	'latitude',
	'longitude',
	'name',
	'continent',
	'country_code',
	'country_name',
	'region_name',
	'elevation_ft',
	'bbox_min_lat',
	'bbox_min_lon',
	'bbox_max_lat',
	'bbox_max_lon',
	'runways',
]);
const BBOX_FIELDS = ['bbox_min_lat', 'bbox_min_lon', 'bbox_max_lat', 'bbox_max_lon'] as const;
const CONTINENTS = new Set(['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA']);
const RUNWAY_FIELDS = new Set([
	'length_ft',
	'width_ft',
	'le_ident',
	'le_latitude_deg',
	'le_longitude_deg',
	'he_ident',
	'he_latitude_deg',
	'he_longitude_deg',
]);

const requireObject = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new HttpError(400, 'Request body must be a JSON object');
	}
	return value as Record<string, unknown>;
};

const requireNumber = (value: unknown, field: string, min: number, max: number): number => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
		throw new HttpError(400, `${field} must be a number between ${min} and ${max}`);
	}
	return value;
};

const requireString = (value: unknown, field: string, maxLength: number): string => {
	if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
	const normalized = value.trim();
	if (!normalized || normalized.length > maxLength) {
		throw new HttpError(400, `${field} must contain 1-${maxLength} characters`);
	}
	return normalized;
};

const optionalString = (value: unknown, field: string, maxLength: number): string | null => {
	if (value === null) return null;
	return requireString(value, field, maxLength);
};

const numericString = (value: unknown, field: string, min: number, max: number): string => {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
		throw new HttpError(400, `${field} must be a number between ${min} and ${max}`);
	}
	return String(parsed);
};

const parseRunways = (value: unknown): RunwayRecord[] => {
	if (!Array.isArray(value)) throw new HttpError(400, 'runways must be an array');
	if (value.length > 100) throw new HttpError(400, 'runways cannot contain more than 100 entries');

	return value.map((raw, index) => {
		const runway = requireObject(raw);
		const prefix = `runways[${index}]`;
		for (const field of Object.keys(runway)) {
			if (!RUNWAY_FIELDS.has(field)) throw new HttpError(400, `Unknown field: ${prefix}.${field}`);
		}
		const leIdent = requireString(runway.le_ident, `${prefix}.le_ident`, 8).toUpperCase();
		const heIdent = requireString(runway.he_ident, `${prefix}.he_ident`, 8).toUpperCase();
		if (!/^[A-Z0-9]+$/.test(leIdent) || !/^[A-Z0-9]+$/.test(heIdent)) {
			throw new HttpError(400, `${prefix} runway identifiers must be alphanumeric`);
		}
		return {
			length_ft: numericString(runway.length_ft, `${prefix}.length_ft`, 1, 100_000),
			width_ft: numericString(runway.width_ft, `${prefix}.width_ft`, 1, 10_000),
			le_ident: leIdent,
			le_latitude_deg: numericString(runway.le_latitude_deg, `${prefix}.le_latitude_deg`, -90, 90),
			le_longitude_deg: numericString(runway.le_longitude_deg, `${prefix}.le_longitude_deg`, -180, 180),
			he_ident: heIdent,
			he_latitude_deg: numericString(runway.he_latitude_deg, `${prefix}.he_latitude_deg`, -90, 90),
			he_longitude_deg: numericString(runway.he_longitude_deg, `${prefix}.he_longitude_deg`, -180, 180),
		};
	});
};

const validateKnownFields = (body: Record<string, unknown>, allowIcao: boolean) => {
	for (const field of Object.keys(body)) {
		if (!AIRPORT_FIELDS.has(field) || (!allowIcao && field === 'icao')) {
			throw new HttpError(400, `Unknown or immutable field: ${field}`);
		}
	}
};

const parseOptionalFields = (body: Record<string, unknown>, target: AirportUpdateInput) => {
	if ('latitude' in body) target.latitude = requireNumber(body.latitude, 'latitude', -90, 90);
	if ('longitude' in body) target.longitude = requireNumber(body.longitude, 'longitude', -180, 180);
	if ('name' in body) target.name = requireString(body.name, 'name', 200);
	if ('continent' in body) {
		const continent = requireString(body.continent, 'continent', 2).toUpperCase();
		if (!CONTINENTS.has(continent)) throw new HttpError(400, 'continent must be a valid two-letter continent code');
		target.continent = continent;
	}
	if ('country_code' in body) {
		const countryCode = optionalString(body.country_code, 'country_code', 2)?.toUpperCase() ?? null;
		if (countryCode !== null && !/^[A-Z]{2}$/.test(countryCode)) {
			throw new HttpError(400, 'country_code must be a two-letter ISO code or null');
		}
		target.country_code = countryCode;
	}
	if ('country_name' in body) target.country_name = optionalString(body.country_name, 'country_name', 120);
	if ('region_name' in body) target.region_name = optionalString(body.region_name, 'region_name', 120);
	if ('elevation_ft' in body) {
		if (body.elevation_ft === null) {
			target.elevation_ft = null;
			target.elevation_m = null;
		} else {
			const elevationFt = requireNumber(body.elevation_ft, 'elevation_ft', -2_000, 60_000);
			if (!Number.isInteger(elevationFt)) throw new HttpError(400, 'elevation_ft must be an integer');
			target.elevation_ft = elevationFt;
			target.elevation_m = Math.round(elevationFt * 0.3048 * 100) / 100;
		}
	}

	const suppliedBboxFields = BBOX_FIELDS.filter((field) => field in body);
	if (suppliedBboxFields.length > 0) {
		if (suppliedBboxFields.length !== BBOX_FIELDS.length) {
			throw new HttpError(400, 'All four bounding-box fields must be supplied together');
		}
		const values = BBOX_FIELDS.map((field) => body[field]);
		const allNull = values.every((value) => value === null);
		if (!allNull && values.some((value) => value === null)) {
			throw new HttpError(400, 'Bounding-box fields must either all be numbers or all be null');
		}
		if (allNull) {
			for (const field of BBOX_FIELDS) target[field] = null;
		} else {
			const minLat = requireNumber(body.bbox_min_lat, 'bbox_min_lat', -90, 90);
			const minLon = requireNumber(body.bbox_min_lon, 'bbox_min_lon', -180, 180);
			const maxLat = requireNumber(body.bbox_max_lat, 'bbox_max_lat', -90, 90);
			const maxLon = requireNumber(body.bbox_max_lon, 'bbox_max_lon', -180, 180);
			if (minLat > maxLat || minLon > maxLon) throw new HttpError(400, 'Bounding-box minimums cannot exceed maximums');
			Object.assign(target, {
				bbox_min_lat: minLat,
				bbox_min_lon: minLon,
				bbox_max_lat: maxLat,
				bbox_max_lon: maxLon,
			});
		}
	}
	if ('runways' in body) target.runways = parseRunways(body.runways);
};

export const parseAirportCreateInput = (value: unknown): AirportCreateInput => {
	const body = requireObject(value);
	validateKnownFields(body, true);
	const icao = requireString(body.icao, 'icao', 4).toUpperCase();
	if (!/^[A-Z0-9]{4}$/.test(icao)) throw new HttpError(400, 'icao must be a valid four-character ICAO code');

	const parsed: AirportUpdateInput = {};
	parseOptionalFields(body, parsed);
	for (const required of ['latitude', 'longitude', 'name', 'continent'] as const) {
		if (!(required in parsed)) throw new HttpError(400, `${required} is required`);
	}
	return {
		icao,
		latitude: parsed.latitude!,
		longitude: parsed.longitude!,
		name: parsed.name!,
		continent: parsed.continent!,
		country_code: parsed.country_code ?? null,
		country_name: parsed.country_name ?? null,
		region_name: parsed.region_name ?? null,
		elevation_ft: parsed.elevation_ft ?? null,
		elevation_m: parsed.elevation_m ?? null,
		bbox_min_lat: parsed.bbox_min_lat ?? null,
		bbox_min_lon: parsed.bbox_min_lon ?? null,
		bbox_max_lat: parsed.bbox_max_lat ?? null,
		bbox_max_lon: parsed.bbox_max_lon ?? null,
		runways: parsed.runways ?? [],
	};
};

export const parseAirportUpdateInput = (value: unknown): AirportUpdateInput => {
	const body = requireObject(value);
	validateKnownFields(body, false);
	const parsed: AirportUpdateInput = {};
	parseOptionalFields(body, parsed);
	if (Object.keys(parsed).length === 0) throw new HttpError(400, 'At least one editable airport field is required');
	return parsed;
};

export class AirportService {
	constructor(
		private db: D1Database,
		private apiToken: string,
		private posthog?: PostHogService,
	) {}

	// D1 sessions should be scoped to one logical request/operation.
	// Reusing them across Worker requests can carry old bookmarks forward and
	// cause later reads to wait for replica catch-up.
	private async withDbSession<T>(operation: (dbSession: DatabaseSessionService) => Promise<T>): Promise<T> {
		const dbSession = new DatabaseSessionService(this.db);
		try {
			return await operation(dbSession);
		} finally {
			dbSession.closeSession();
		}
	}

	private runwayInsertStatement(icao: string, runway: RunwayRecord) {
		return {
			query: `INSERT INTO runways (
					airport_icao, length_ft, width_ft, le_ident, le_latitude_deg, le_longitude_deg,
					he_ident, he_latitude_deg, he_longitude_deg
				)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				WHERE EXISTS (SELECT 1 FROM airports WHERE icao = ?)`,
			params: [
				icao,
				runway.length_ft,
				runway.width_ft,
				runway.le_ident,
				runway.le_latitude_deg,
				runway.le_longitude_deg,
				runway.he_ident,
				runway.he_latitude_deg,
				runway.he_longitude_deg,
				icao,
			],
		};
	}

	async createAirport(input: AirportCreateInput): Promise<AirportRecord & { runways: RunwayRecord[] }> {
		return this.withDbSession(async (dbSession) => {
			const statements = [
				{
					query: `INSERT INTO airports (
							icao, latitude, longitude, name, continent, country_code, country_name, region_name,
							elevation_ft, elevation_m, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						RETURNING *`,
					params: [
						input.icao,
						input.latitude,
						input.longitude,
						input.name,
						input.continent,
						input.country_code,
						input.country_name,
						input.region_name,
						input.elevation_ft,
						input.elevation_m,
						input.bbox_min_lat,
						input.bbox_min_lon,
						input.bbox_max_lat,
						input.bbox_max_lon,
					],
				},
				...input.runways.map((runway) => this.runwayInsertStatement(input.icao, runway)),
			];
			try {
				const results = await dbSession.executeBatch(statements);
				const airport = (results[0]?.results as AirportRecord[] | undefined)?.[0];
				if (!airport) throw new Error('Airport insert returned no record');
				try {
					this.posthog?.track('Airport Manually Created', { icao: input.icao, runwayCount: input.runways.length });
				} catch {
					/* ignore analytics errors */
				}
				return { ...airport, runways: input.runways };
			} catch (error) {
				if (error instanceof HttpError) throw error;
				if (error instanceof Error && /UNIQUE constraint failed: airports\.icao/i.test(error.message)) {
					throw new HttpError(409, `Airport ${input.icao} already exists`);
				}
				throw error;
			}
		});
	}

	async updateAirport(icao: string, input: AirportUpdateInput): Promise<AirportRecord & { runways: RunwayRecord[] }> {
		const normalizedIcao = icao.toUpperCase();
		return this.withDbSession(async (dbSession) => {
			const assignments: string[] = [];
			const params: Array<string | number | null> = [];
			for (const [field, value] of Object.entries(input)) {
				if (field === 'runways') continue;
				assignments.push(`${field} = ?`);
				params.push(value as string | number | null);
			}

			const updateQuery =
				assignments.length > 0
					? `UPDATE airports SET ${assignments.join(', ')} WHERE icao = ? RETURNING *`
					: 'UPDATE airports SET icao = icao WHERE icao = ? RETURNING *';
			const statements = [{ query: updateQuery, params: [...params, normalizedIcao] }];
			if (input.runways) {
				statements.push({ query: 'DELETE FROM runways WHERE airport_icao = ?', params: [normalizedIcao] });
				statements.push(...input.runways.map((runway) => this.runwayInsertStatement(normalizedIcao, runway)));
			}
			statements.push({
				query: `SELECT length_ft, width_ft, le_ident, le_latitude_deg, le_longitude_deg,
						he_ident, he_latitude_deg, he_longitude_deg
					FROM runways WHERE airport_icao = ? ORDER BY id`,
				params: [normalizedIcao],
			});

			const results = await dbSession.executeBatch(statements);
			const airport = (results[0]?.results as AirportRecord[] | undefined)?.[0];
			if (!airport) throw new HttpError(404, `Airport ${normalizedIcao} not found`);
			const runways = (results[results.length - 1]?.results as RunwayRecord[] | undefined) ?? [];
			try {
				this.posthog?.track('Airport Manually Updated', {
					icao: normalizedIcao,
					fields: Object.keys(input).filter((field) => field !== 'runways'),
					runwaysReplaced: input.runways !== undefined,
				});
			} catch {
				/* ignore analytics errors */
			}
			return { ...airport, runways };
		});
	}

	async getAirport(icao: string) {
		const uppercaseIcao = icao.toUpperCase().replace(/[^A-Z0-9]/g, '');
		if (!/^[A-Z0-9]{4}$/.test(uppercaseIcao)) {
			return null;
		}

		return this.withDbSession(async (dbSession) => {
			const [airportResult, runwayResult, divisionAirportResult] = await dbSession.executeReadBatch([
				{
					query: `SELECT icao, latitude, longitude, name, continent, country_code, country_name,
						region_name, elevation_ft, elevation_m, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon
						FROM airports WHERE icao = ? LIMIT 1`,
					params: [uppercaseIcao],
				},
				{
					query: `SELECT length_ft, width_ft, le_ident, le_latitude_deg, le_longitude_deg,
							he_ident, he_latitude_deg, he_longitude_deg
						FROM runways WHERE airport_icao = ?`,
					params: [uppercaseIcao],
				},
				{
					query: `SELECT id
						FROM division_airports
						WHERE icao = ? AND status = 'approved'
						ORDER BY id DESC
						LIMIT 1`,
					params: [uppercaseIcao],
				},
			]);
			const airportFromDb = (airportResult.results as AirportRecord[])[0];
			const cachedRunways = runwayResult.results as RunwayRecord[];
			const divisionAirportId = (divisionAirportResult.results as Array<{ id: number }>)[0]?.id ?? null;

			if (airportFromDb) {
				const fetchPromises: Array<Promise<Partial<AirportRecord> | null>> = [];
				const needsElevation = airportFromDb.elevation_ft == null;
				const needsLocation =
					airportFromDb.country_code == null || airportFromDb.country_name == null || airportFromDb.region_name == null;
				if (needsElevation || needsLocation) {
					fetchPromises.push(
						this.fetchAndStoreMetadata(uppercaseIcao, dbSession, needsElevation, needsLocation).catch(() => null),
					);
				}
				if (
					airportFromDb.bbox_min_lat == null ||
					airportFromDb.bbox_min_lon == null ||
					airportFromDb.bbox_max_lat == null ||
					airportFromDb.bbox_max_lon == null
				) {
					fetchPromises.push(
						this.fetchAndStoreBoundingBox(uppercaseIcao, dbSession).catch((err) => {
							try {
								this.posthog?.track('Airport Bounding Box Unavailable', {
									source: 'db-cache-miss',
									icao: uppercaseIcao,
									error: err instanceof Error ? err.message : String(err),
								});
							} catch {
								/* ignore analytics errors */
							}
							return null;
						}),
					);
				}

				const enrichments = await Promise.all(fetchPromises);
				for (const enrichment of enrichments) {
					if (enrichment) Object.assign(airportFromDb, enrichment);
				}
				return { ...airportFromDb, id: divisionAirportId, runways: cachedRunways };
			}

			try {
				const response = await fetch(`https://airportdb.io/api/v1/airport/${uppercaseIcao}?apiToken=${this.apiToken}`, {
					method: 'GET',
				});
				if (!response.ok) {
					await cancelResponseBody(response);
					if (response.status === 404) return null;
					throw new HttpError(503, 'Bounding box unavailable');
				}
				const airportData = (await response.json()) as AirportData;

				const hasCoords = Number.isFinite(airportData.latitude_deg) && Number.isFinite(airportData.longitude_deg);
				if (!hasCoords) {
					try {
						this.posthog?.track('Airport External Fetch MissingCoords', { icao: uppercaseIcao });
					} catch {
						/* ignore */
					}
					return null;
				}

				const elevation_ft = airportData.elevation_ft ? parseInt(airportData.elevation_ft, 10) : null;
				const elevation_m =
					elevation_ft != null && !Number.isNaN(elevation_ft) ? Math.round(elevation_ft * 0.3048 * 100) / 100 : null;
				const country_code =
					airportData.iso_country?.trim().toUpperCase() || airportData.country?.code?.trim().toUpperCase() || null;
				const country_name = airportData.country?.name?.trim() || null;
				const region_name = airportData.region?.name?.trim() || null;

				const airport = {
					icao: uppercaseIcao,
					latitude: airportData.latitude_deg!,
					longitude: airportData.longitude_deg!,
					name: airportData.name || '',
					continent: airportData.continent || 'UNKNOWN',
					country_code,
					country_name,
					region_name,
					elevation_ft: !Number.isNaN(elevation_ft) ? elevation_ft : null,
					elevation_m,
				};

				await dbSession.executeWrite(
					'INSERT INTO airports (icao, latitude, longitude, name, continent, country_code, country_name, region_name, elevation_ft, elevation_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
					[
						airport.icao,
						airport.latitude,
						airport.longitude,
						airport.name,
						airport.continent,
						airport.country_code,
						airport.country_name,
						airport.region_name,
						airport.elevation_ft,
						airport.elevation_m,
					],
				);

				let storedBoundingBox: Partial<AirportRecord> | null = null;
				try {
					storedBoundingBox = await this.fetchAndStoreBoundingBox(uppercaseIcao, dbSession);
				} catch (err) {
					try {
						this.posthog?.track('Airport Bounding Box Unavailable', {
							source: 'external-api',
							icao: uppercaseIcao,
							error: err instanceof Error ? err.message : String(err),
						});
					} catch {
						/* ignore analytics errors */
					}
				}

				const mergedAirport = { ...airport, ...storedBoundingBox };

				if (airportData.runways && airportData.runways.length > 0) {
					const openRunways = airportData.runways.filter((runway) => runway.closed !== '1');
					const runwayStatements = openRunways.map((runway) => ({
						query: `
							INSERT INTO runways (
								airport_icao, length_ft, width_ft,
								le_ident, le_latitude_deg, le_longitude_deg,
								he_ident, he_latitude_deg, he_longitude_deg
							) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
						`,
						params: [
							uppercaseIcao,
							runway.length_ft,
							runway.width_ft,
							runway.le_ident,
							runway.le_latitude_deg,
							runway.le_longitude_deg,
							runway.he_ident,
							runway.he_latitude_deg,
							runway.he_longitude_deg,
						],
					}));

					await dbSession.executeBatch(runwayStatements);

					try {
						this.posthog?.track('Airport Fetched From External API', {
							icao: uppercaseIcao,
							hasRunways: !!openRunways.length,
							runwaysFilteredClosed: airportData.runways.length - openRunways.length || 0,
						});
					} catch (e) {
						console.warn('Posthog track failed (Airport Fetched From External API)', e);
					}
					return {
						...mergedAirport,
						id: divisionAirportId,
						runways: openRunways.map(
							({
								length_ft,
								width_ft,
								le_ident,
								le_latitude_deg,
								le_longitude_deg,
								he_ident,
								he_latitude_deg,
								he_longitude_deg,
							}) => ({
								length_ft,
								width_ft,
								le_ident,
								le_latitude_deg,
								le_longitude_deg,
								he_ident,
								he_latitude_deg,
								he_longitude_deg,
							}),
						),
					};
				}

				try {
					this.posthog?.track('Airport Fetched From External API', {
						icao: uppercaseIcao,
						hasRunways: !!airportData.runways?.length,
					});
				} catch (e) {
					console.warn('Posthog track failed (Airport Fetched From External API)', e);
				}
				return { ...mergedAirport, id: divisionAirportId };
			} catch (e) {
				try {
					this.posthog?.track('Airport External Fetch Failed', { icao: uppercaseIcao, error: (e as Error).message });
				} catch {
					/* ignore */
				}
				if (e instanceof HttpError) throw e;
				throw new HttpError(503, 'Bounding box unavailable');
			}
		});
	}

	async getAirports(icaos: string[]) {
		const normalized = icaos.map((icao) => icao.toUpperCase().replace(/[^A-Z0-9]/g, ''));
		const unique = [...new Set(normalized.filter((icao) => /^[A-Z0-9]{4}$/.test(icao)))];
		if (unique.length === 0) return {};

		const cachedAirports = new Map<string, AirportReadRecord>();
		const cachedRunways = new Map<string, RunwayRecord[]>();
		await this.withDbSession(async (dbSession) => {
			const statements: Array<{ query: string; params: string[] }> = [];
			const chunkSize = 64;
			for (let offset = 0; offset < unique.length; offset += chunkSize) {
				const chunk = unique.slice(offset, offset + chunkSize);
				const placeholders = chunk.map(() => '?').join(', ');
				statements.push(
					{
						query: `SELECT (
								SELECT da.id
								FROM division_airports da
								WHERE da.icao = a.icao AND da.status = 'approved'
								ORDER BY da.id DESC
								LIMIT 1
							) AS id, a.icao, a.latitude, a.longitude, a.name, a.continent,
								a.country_code, a.country_name, a.region_name, a.elevation_ft, a.elevation_m,
								a.bbox_min_lat, a.bbox_min_lon, a.bbox_max_lat, a.bbox_max_lon
							FROM airports a
							WHERE a.icao IN (${placeholders})`,
						params: chunk,
					},
					{
						query: `SELECT airport_icao, length_ft, width_ft, le_ident, le_latitude_deg, le_longitude_deg,
								he_ident, he_latitude_deg, he_longitude_deg
							FROM runways WHERE airport_icao IN (${placeholders})`,
						params: chunk,
					},
				);
			}

			const batchResults = await dbSession.executeReadBatch(statements);
			for (let index = 0; index < batchResults.length; index += 2) {
				for (const airport of batchResults[index].results as AirportReadRecord[]) cachedAirports.set(airport.icao, airport);
				for (const runway of batchResults[index + 1].results as Array<RunwayRecord & { airport_icao: string }>) {
					const list = cachedRunways.get(runway.airport_icao) ?? [];
					list.push({
						length_ft: runway.length_ft,
						width_ft: runway.width_ft,
						le_ident: runway.le_ident,
						le_latitude_deg: runway.le_latitude_deg,
						le_longitude_deg: runway.le_longitude_deg,
						he_ident: runway.he_ident,
						he_latitude_deg: runway.he_latitude_deg,
						he_longitude_deg: runway.he_longitude_deg,
					});
					cachedRunways.set(runway.airport_icao, list);
				}
			}
		});

		const results = new Map<string, object>();
		const needsLookup: string[] = [];
		for (const icao of unique) {
			const airport = cachedAirports.get(icao);
			const complete =
				airport &&
				airport.elevation_ft != null &&
				airport.country_code != null &&
				airport.country_name != null &&
				airport.region_name != null &&
				airport.bbox_min_lat != null &&
				airport.bbox_min_lon != null &&
				airport.bbox_max_lat != null &&
				airport.bbox_max_lon != null;
			if (complete) results.set(icao, { ...airport, runways: cachedRunways.get(icao) ?? [] });
			else needsLookup.push(icao);
		}

		const externalBatchSize = 5;
		for (let offset = 0; offset < needsLookup.length; offset += externalBatchSize) {
			await Promise.all(
				needsLookup.slice(offset, offset + externalBatchSize).map(async (icao) => {
					const airport = await this.getAirport(icao);
					if (airport) results.set(icao, airport);
				}),
			);
		}

		const orderedResults = new Map<string, object>();
		for (const [index, icao] of normalized.entries()) {
			const airport = results.get(icao);
			if (airport) orderedResults.set(icaos[index].toUpperCase(), airport);
		}
		return Object.fromEntries(orderedResults);
	}

	async getAirportsByContinent(continent: string) {
		return this.withDbSession(async (dbSession) => {
			const result = await dbSession.executeRead<{
				icao: string;
				latitude: number | null;
				longitude: number | null;
				name: string;
				continent: string;
				country_code: string | null;
				country_name: string | null;
				region_name: string | null;
				elevation_ft: number | null;
				elevation_m: number | null;
			}>('SELECT * FROM airports WHERE continent = ? ORDER BY icao', [continent.toUpperCase()]);
			return { results: result.results };
		});
	}

	/**
	 * Find the nearest airport to a latitude/longitude using a very fast approximate search
	 * followed by an exact distance refinement. Designed for high QPS usage.
	 */
	async getNearestAirport(lat: number, lon: number) {
		if (Number.isNaN(lat) || Number.isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			return null;
		}

		const LAT_BOX = 1; // degrees
		const LON_BOX = 1; // degrees
		const minLat = lat - LAT_BOX;
		const maxLat = lat + LAT_BOX;
		const minLon = lon - LON_BOX;
		const maxLon = lon + LON_BOX;

		return this.withDbSession(async (dbSession) => {
			const cosLat = Math.cos((lat * Math.PI) / 180);
			const cosLatSq = cosLat * cosLat;
			const approx = await dbSession.executeRead<{
				icao: string;
				latitude: number;
				longitude: number;
				name: string;
				continent: string;
				country_code: string | null;
				country_name: string | null;
				region_name: string | null;
				elevation_ft: number | null;
				elevation_m: number | null;
				distance_score: number;
			}>(
				`SELECT icao, latitude, longitude, name, continent, country_code, country_name, region_name, elevation_ft, elevation_m,
					((latitude - ?) * (latitude - ?) + ((longitude - ?) * (longitude - ?) * ?)) AS distance_score
				 FROM airports
				 WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
				 ORDER BY distance_score
				 LIMIT 1`,
				[lat, lat, lon, lon, cosLatSq, minLat, maxLat, minLon, maxLon],
			);

			const row = approx.results?.[0];
			if (!row) return null;

			const distance_m = calculateDistance({ lat, lon }, { lat: row.latitude, lon: row.longitude });
			const distance_nm = distance_m / 1852;

			try {
				this.posthog?.track('Nearest Airport Lookup', { icao: row.icao });
			} catch (e) {
				console.warn('Posthog track failed (Nearest Airport Lookup)', e);
			}

			return {
				icao: row.icao,
				latitude: row.latitude,
				longitude: row.longitude,
				name: row.name,
				continent: row.continent,
				country_code: row.country_code,
				country_name: row.country_name,
				region_name: row.region_name,
				elevation_ft: row.elevation_ft,
				elevation_m: row.elevation_m,
				distance_m: Math.round(distance_m),
				distance_nm: Number(distance_nm.toFixed(2)),
			};
		});
	}

	/**
	 * Fetch and persist bounding box for an airport. Throws HttpError(503) if unavailable so caller can surface
	 * a retriable error (not cached). Never returns null.
	 */
	private async fetchAndStoreBoundingBox(
		icao: string,
		dbSession: DatabaseSessionService,
	): Promise<{ bbox_min_lat: number; bbox_min_lon: number; bbox_max_lat: number; bbox_max_lon: number }> {
		const escaped = icao.replace(/"/g, '');
		const overpassQuery = `data=[out:json][timeout:25];(\n      nwr["aeroway"="aerodrome"]["icao"="${escaped}"];\n      nwr["aeroway"="aerodrome"]["ref"="${escaped}"];\n      nwr["aeroway"="aerodrome"]["ref:icao"="${escaped}"];\n    );out body geom;`;
		const url = `https://overpass-api.de/api/interpreter?${overpassQuery}`;

		interface OverpassElement {
			type: 'node' | 'way' | 'relation';
			id: number;
			bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
			nodes?: number[];
			geometry?: Array<{ lat: number; lon: number }>;
			lat?: number;
			lon?: number;
			tags?: Record<string, string>;
		}
		interface OverpassResponse {
			elements?: OverpassElement[];
		}

		const maxAttempts = 3;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'BARS-Core/1.0 (bbox lookup)' } });
				if (!res.ok) {
					await cancelResponseBody(res);
					if (res.status === 429 || res.status >= 500) {
						if (attempt < maxAttempts - 1) {
							await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
							continue;
						}
					}
					try {
						this.posthog?.track('Airport Bounding Box Fetch NonOK', { icao, status: res.status });
					} catch {
						/* ignore */
					}
					throw new HttpError(503, 'Bounding box unavailable');
				}
				const json = (await res.json()) as OverpassResponse;
				if (!json.elements || json.elements.length === 0) throw new HttpError(503, 'Bounding box unavailable');

				const sorted = [...json.elements].sort((a, b) => {
					const rank = (e: OverpassElement) => (e.type === 'relation' ? 0 : e.type === 'way' ? 1 : 2);
					return rank(a) - rank(b);
				});

				for (const el of sorted) {
					let bounds = el.bounds;
					if (!bounds) {
						if (el.geometry && el.geometry.length) {
							let minLat = Infinity,
								minLon = Infinity,
								maxLat = -Infinity,
								maxLon = -Infinity;
							for (const g of el.geometry) {
								if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
								if (g.lat < minLat) minLat = g.lat;
								if (g.lat > maxLat) maxLat = g.lat;
								if (g.lon < minLon) minLon = g.lon;
								if (g.lon > maxLon) maxLon = g.lon;
							}
							if (minLat !== Infinity) {
								bounds = { minlat: minLat, minlon: minLon, maxlat: maxLat, maxlon: maxLon };
							}
						} else if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
							const pad = 0.002;
							bounds = { minlat: el.lat! - pad, minlon: el.lon! - pad, maxlat: el.lat! + pad, maxlon: el.lon! + pad };
						}
					}
					if (bounds) {
						const bbox = {
							bbox_min_lat: bounds.minlat,
							bbox_min_lon: bounds.minlon,
							bbox_max_lat: bounds.maxlat,
							bbox_max_lon: bounds.maxlon,
						};
						await dbSession.executeWrite(
							'UPDATE airports SET bbox_min_lat = ?, bbox_min_lon = ?, bbox_max_lat = ?, bbox_max_lon = ? WHERE icao = ?',
							[bbox.bbox_min_lat, bbox.bbox_min_lon, bbox.bbox_max_lat, bbox.bbox_max_lon, icao],
						);
						try {
							this.posthog?.track('Airport Bounding Box Stored', { icao, source: 'overpass', elementType: el.type });
						} catch {
							/* ignore analytics errors */
						}
						return bbox;
					}
				}
				throw new HttpError(503, 'Bounding box unavailable');
			} catch (e) {
				if (attempt < maxAttempts - 1) {
					await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
					continue;
				}
				try {
					this.posthog?.track('Airport Bounding Box Fetch Failed', { icao, error: (e as Error).message });
				} catch {
					/* ignore analytics errors */
				}
				if (e instanceof HttpError) throw e;
				throw new HttpError(503, 'Bounding box unavailable');
			}
		}
		throw new HttpError(503, 'Bounding box unavailable');
	}

	/** Fetch missing AirportDB metadata once and persist it with one update. */
	private async fetchAndStoreMetadata(
		icao: string,
		dbSession: DatabaseSessionService,
		needsElevation: boolean,
		needsLocation: boolean,
	): Promise<Partial<AirportRecord> | null> {
		try {
			const response = await fetch(`https://airportdb.io/api/v1/airport/${icao}?apiToken=${this.apiToken}`, { method: 'GET' });
			if (!response.ok) {
				await cancelResponseBody(response);
				return null;
			}
			const data = (await response.json()) as AirportData;
			const updates: Partial<AirportRecord> = {};
			const setFragments: string[] = [];
			const params: Array<string | number | null> = [];

			if (needsLocation) {
				const country_code = data.iso_country?.trim().toUpperCase() || data.country?.code?.trim().toUpperCase() || null;
				const country_name = data.country?.name?.trim() || null;
				const region_name = data.region?.name?.trim() || null;
				if (country_code || country_name || region_name) {
					Object.assign(updates, { country_code, country_name, region_name });
					setFragments.push('country_code = ?', 'country_name = ?', 'region_name = ?');
					params.push(country_code, country_name, region_name);
				}
			}

			if (needsElevation && data.elevation_ft) {
				const elevation_ft = parseInt(data.elevation_ft, 10);
				if (!Number.isNaN(elevation_ft)) {
					const elevation_m = Math.round(elevation_ft * 0.3048 * 100) / 100;
					Object.assign(updates, { elevation_ft, elevation_m });
					setFragments.push('elevation_ft = ?', 'elevation_m = ?');
					params.push(elevation_ft, elevation_m);
				}
			}

			if (setFragments.length === 0) return null;
			params.push(icao);
			await dbSession.executeWrite(`UPDATE airports SET ${setFragments.join(', ')} WHERE icao = ?`, params);
			return updates;
		} catch {
			return null;
		}
	}
}
