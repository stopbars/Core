import { DatabaseSessionService } from './database-session';
import { PostHogService } from './posthog';
import { calculateDistance } from './bars/geoUtils';
import { HttpError } from './errors';

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

export class AirportService {
	private dbSession: DatabaseSessionService;

	constructor(
		private db: D1Database,
		private apiToken: string,
		private posthog?: PostHogService,
	) {
		this.dbSession = new DatabaseSessionService(db);
	}

	async getAirport(icao: string) {
		const uppercaseIcao = icao.toUpperCase().replace(/[^A-Z0-9]/g, '');
		if (!/^[A-Z0-9]{4}$/.test(uppercaseIcao)) {
			return null;
		}

		const airportResult = await this.dbSession.executeRead<{
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
		}>('SELECT * FROM airports WHERE icao = ?', [uppercaseIcao]);
		const airportFromDb = airportResult.results[0];

		if (airportFromDb) {
			const fetchPromises: Promise<void>[] = [];
			let needsReread = false;

			if (airportFromDb.elevation_ft == null) {
				needsReread = true;
				fetchPromises.push(
					this.fetchAndStoreElevation(uppercaseIcao)
						.then(() => { })
						.catch(() => { }),
				);
			}
			if (airportFromDb.country_code == null || airportFromDb.country_name == null || airportFromDb.region_name == null) {
				needsReread = true;
				fetchPromises.push(
					this.fetchAndStoreLocationMeta(uppercaseIcao)
						.then(() => { })
						.catch(() => { }),
				);
			}
			if (
				airportFromDb.bbox_min_lat == null ||
				airportFromDb.bbox_min_lon == null ||
				airportFromDb.bbox_max_lat == null ||
				airportFromDb.bbox_max_lon == null
			) {
				needsReread = true;
				fetchPromises.push(
					this.fetchAndStoreBoundingBox(uppercaseIcao)
						.then(() => { })
						.catch((err) => {
							try {
								this.posthog?.track('Airport Bounding Box Unavailable', {
									source: 'db-cache-miss',
									icao: uppercaseIcao,
									error: err instanceof Error ? err.message : String(err),
								});
							} catch {
								/* ignore analytics errors */
							}
						}),
				);
			}

			if (fetchPromises.length > 0) {
				await Promise.all(fetchPromises);
			}

			if (needsReread) {
				const reread = await this.dbSession.executeRead<{
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
				}>('SELECT * FROM airports WHERE icao = ?', [uppercaseIcao]);
				if (reread.results[0]) Object.assign(airportFromDb, reread.results[0]);
			}
			const runwaysResult = await this.dbSession.executeRead<{
				length_ft: string;
				width_ft: string;
				le_ident: string;
				le_latitude_deg: string;
				le_longitude_deg: string;
				he_ident: string;
				he_latitude_deg: string;
				he_longitude_deg: string;
			}>(
				`SELECT 
					length_ft,
					width_ft,
					le_ident,
					le_latitude_deg,
					le_longitude_deg,
					he_ident,
					he_latitude_deg,
					he_longitude_deg
				FROM runways WHERE airport_icao = ?`,
				[uppercaseIcao],
			);
			return { ...airportFromDb, runways: runwaysResult.results };
		}

		try {
			const response = await fetch(`https://airportdb.io/api/v1/airport/${uppercaseIcao}?apiToken=${this.apiToken}`, {
				method: 'GET',
			});
			const airportData = (await response.json()) as AirportData;

			const elevation_ft = airportData.elevation_ft ? parseInt(airportData.elevation_ft, 10) : null;
			const elevation_m = elevation_ft != null && !Number.isNaN(elevation_ft) ? Math.round(elevation_ft * 0.3048 * 100) / 100 : null;
			const country_code =
				airportData.iso_country?.trim().toUpperCase() ||
				airportData.country?.code?.trim().toUpperCase() ||
				null;
			const country_name = airportData.country?.name?.trim() || null;
			const region_name = airportData.region?.name?.trim() || null;

			const airport = {
				icao: uppercaseIcao,
				latitude: airportData.latitude_deg,
				longitude: airportData.longitude_deg,
				name: airportData.name || '',
				continent: airportData.continent || 'UNKNOWN',
				country_code,
				country_name,
				region_name,
				elevation_ft: !Number.isNaN(elevation_ft) ? elevation_ft : null,
				elevation_m,
			};

			await this.dbSession.executeWrite(
				'INSERT INTO airports (icao, latitude, longitude, name, continent, country_code, country_name, region_name, elevation_ft, elevation_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
				[
					airport.icao,
					airport.latitude ?? null,
					airport.longitude ?? null,
					airport.name,
					airport.continent,
					airport.country_code,
					airport.country_name,
					airport.region_name,
					airport.elevation_ft,
					airport.elevation_m,
				],
			);

			try {
				await this.fetchAndStoreBoundingBox(uppercaseIcao);
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

			const reread = await this.dbSession.executeRead<{
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
			}>('SELECT * FROM airports WHERE icao = ?', [uppercaseIcao]);
			const mergedAirport = { ...airport, ...reread.results[0] };

			if (airportData.runways && airportData.runways.length > 0) {
				const openRunways = airportData.runways.filter((r) => r.closed !== '1');
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

				await this.dbSession.executeBatch(runwayStatements);

				const runwaysResult = await this.dbSession.executeRead<{
					length_ft: string;
					width_ft: string;
					le_ident: string;
					le_latitude_deg: string;
					le_longitude_deg: string;
					he_ident: string;
					he_latitude_deg: string;
					he_longitude_deg: string;
				}>(
					`SELECT 
						length_ft,
						width_ft,
						le_ident,
						le_latitude_deg,
						le_longitude_deg,
						he_ident,
						he_latitude_deg,
						he_longitude_deg
					FROM runways WHERE airport_icao = ?`,
					[uppercaseIcao],
				);

				try {
					this.posthog?.track('Airport Fetched From External API', {
						icao: uppercaseIcao,
						hasRunways: !!openRunways.length,
						runwaysFilteredClosed: airportData.runways.length - openRunways.length || 0,
					});
				} catch (e) {
					console.warn('Posthog track failed (Airport Fetched From External API)', e);
				}
				return { ...mergedAirport, runways: runwaysResult.results };
			}

			try {
				this.posthog?.track('Airport Fetched From External API', {
					icao: uppercaseIcao,
					hasRunways: !!airportData.runways?.length,
				});
			} catch (e) {
				console.warn('Posthog track failed (Airport Fetched From External API)', e);
			}
			return mergedAirport;
		} catch (e) {
			try {
				this.posthog?.track('Airport External Fetch Failed', { icao: uppercaseIcao, error: (e as Error).message });
			} catch {
				/* ignore */
			}
			if (e instanceof HttpError) throw e;
			throw new HttpError(503, 'Bounding box unavailable');
		}
	}

	async getAirports(icaos: string[]) {
		const results = new Map();

		const batchSize = 5;
		for (let i = 0; i < icaos.length; i += batchSize) {
			const batch = icaos.slice(i, i + batchSize);
			const airportPromises = batch.map(async (icao) => {
				const airport = await this.getAirport(icao);
				if (airport) {
					results.set(icao.toUpperCase(), airport);
				}
			});

			await Promise.all(airportPromises);
		}

		return Object.fromEntries(results);
	}

	async getAirportsByContinent(continent: string) {
		const result = await this.dbSession.executeRead<{
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

		const cosLat = Math.cos((lat * Math.PI) / 180);
		const cosLatSq = cosLat * cosLat;
		const approx = await this.dbSession.executeRead<{
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
	}

	/**
	 * Fetch and persist bounding box for an airport. Throws HttpError(503) if unavailable so caller can surface
	 * a retriable error (not cached). Never returns null.
	 */
	private async fetchAndStoreBoundingBox(
		icao: string,
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
						await this.dbSession.executeWrite(
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

	/**
	 * Fetch country and region info from AirportDB and store in database.
	 * Returns the data if successful, null otherwise.
	 */
	private async fetchAndStoreLocationMeta(
		icao: string,
	): Promise<{ country_code: string | null; country_name: string | null; region_name: string | null } | null> {
		try {
			const response = await fetch(`https://airportdb.io/api/v1/airport/${icao}?apiToken=${this.apiToken}`, { method: 'GET' });
			if (!response.ok) return null;
			const data = (await response.json()) as AirportData;

			const country_code = data.iso_country?.trim().toUpperCase() || data.country?.code?.trim().toUpperCase() || null;
			const country_name = data.country?.name?.trim() || null;
			const region_name = data.region?.name?.trim() || null;

			if (!country_code && !country_name && !region_name) return null;

			await this.dbSession.executeWrite('UPDATE airports SET country_code = ?, country_name = ?, region_name = ? WHERE icao = ?', [
				country_code,
				country_name,
				region_name,
				icao,
			]);

			return { country_code, country_name, region_name };
		} catch {
			return null;
		}
	}

	/**
	 * Fetch elevation from AirportDB and store in database.
	 * Returns the elevation data if successful, null otherwise.
	 */
	private async fetchAndStoreElevation(icao: string): Promise<{ elevation_ft: number; elevation_m: number } | null> {
		try {
			const response = await fetch(`https://airportdb.io/api/v1/airport/${icao}?apiToken=${this.apiToken}`, { method: 'GET' });
			if (!response.ok) return null;
			const data = (await response.json()) as AirportData;
			if (!data.elevation_ft) return null;

			const elevation_ft = parseInt(data.elevation_ft, 10);
			if (Number.isNaN(elevation_ft)) return null;

			const elevation_m = Math.round(elevation_ft * 0.3048 * 100) / 100;

			await this.dbSession.executeWrite('UPDATE airports SET elevation_ft = ?, elevation_m = ? WHERE icao = ?', [
				elevation_ft,
				elevation_m,
				icao,
			]);

			return { elevation_ft, elevation_m };
		} catch {
			return null;
		}
	}
}
