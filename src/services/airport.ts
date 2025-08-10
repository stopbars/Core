import { DatabaseSessionService } from './database-session';
import { PostHogService } from './posthog';
import { calculateDistance } from './bars/geoUtils';

interface AirportData {
	latitude_deg?: number;
	longitude_deg?: number;
	name?: string;
	continent?: string;
	runways?: Array<{
		length_ft: string;
		width_ft: string;
		le_ident: string;
		le_latitude_deg: string;
		le_longitude_deg: string;
		he_ident: string;
		he_latitude_deg: string;
		he_longitude_deg: string;
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
		const uppercaseIcao = icao.toUpperCase();

		// First try to get from database using read-optimized query
		const airportResult = await this.dbSession.executeRead<any>(
			'SELECT * FROM airports WHERE icao = ?',
			[uppercaseIcao]
		);
		const airportFromDb = airportResult.results[0];

		if (airportFromDb) {
			// Get runways for this airport
			const runwaysResult = await this.dbSession.executeRead<any>(
				'SELECT * FROM runways WHERE airport_icao = ?',
				[uppercaseIcao]
			);

			return { ...airportFromDb, runways: runwaysResult.results };
		}

		try {
			const response = await fetch(`https://airportdb.io/api/v1/airport/${uppercaseIcao}?apiToken=${this.apiToken}`, {
				method: 'GET',
			});
			const airportData = (await response.json()) as AirportData;

			// Map API response to our database schema
			const airport = {
				icao: uppercaseIcao,
				latitude: airportData.latitude_deg,
				longitude: airportData.longitude_deg,
				name: airportData.name || '',
				continent: airportData.continent || 'UNKNOWN',
			};

			// Save airport to database using write-optimized operation
			await this.dbSession.executeWrite(
				'INSERT INTO airports (icao, latitude, longitude, name, continent) VALUES (?, ?, ?, ?, ?)',
				[airport.icao, airport.latitude, airport.longitude, airport.name, airport.continent]
			);

			// Save runway data if available
			if (airportData.runways && airportData.runways.length > 0) {
				const runwayStatements = airportData.runways.map((runway) => ({
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
					]
				}));

				await this.dbSession.executeBatch(runwayStatements);

				// Fetch the saved runways to return with the airport
				const runwaysResult = await this.dbSession.executeRead<any>(
					'SELECT * FROM runways WHERE airport_icao = ?',
					[uppercaseIcao]
				);

				return { ...airport, runways: runwaysResult.results };
			}

			try { this.posthog?.track('Airport Fetched From External API', { icao: uppercaseIcao, hasRunways: !!airportData.runways?.length }); } catch { }
			return airport;
		} catch (error) {
			try { this.posthog?.track('Airport External Fetch Failed', { icao: uppercaseIcao }); } catch { }
			return null;
		}
	}

	async getAirports(icaos: string[]) {
		const results = new Map();

		// Process airports in parallel with a reasonable batch size
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
		const result = await this.dbSession.executeRead<any>(
			'SELECT * FROM airports WHERE continent = ? ORDER BY icao',
			[continent.toUpperCase()]
		);
		return { results: result.results };
	}

	/**
	 * Find the nearest airport to a latitude/longitude using a very fast approximate search
	 * followed by an exact distance refinement. Designed for high QPS usage.
	 */
	async getNearestAirport(lat: number, lon: number) {
		// Guard invalid input early
		if (Number.isNaN(lat) || Number.isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			return null;
		}

		// Use a small bounding box to reduce rows scanned (±1° ~ up to 60nm lat / 60nm * cos(lat) lon)
		const LAT_BOX = 1; // degrees
		const LON_BOX = 1; // degrees
		const minLat = lat - LAT_BOX;
		const maxLat = lat + LAT_BOX;
		const minLon = lon - LON_BOX;
		const maxLon = lon + LON_BOX;

		// Pre-compute cos^2(lat) to weight longitudinal delta for planar approx distance ordering
		const cosLat = Math.cos(lat * Math.PI / 180);
		const cosLatSq = cosLat * cosLat;
		const approx = await this.dbSession.executeRead<any>(
			`SELECT icao, latitude, longitude, name, continent,
				((latitude - ?) * (latitude - ?) + ((longitude - ?) * (longitude - ?) * ?)) AS distance_score
			 FROM airports
			 WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
			 ORDER BY distance_score
			 LIMIT 1`,
			[lat, lat, lon, lon, cosLatSq, minLat, maxLat, minLon, maxLon]
		);

		const row = approx.results?.[0];
		if (!row) return null;

		// Refine with precise geodesic distance (meters) and convert to NM
		const distance_m = calculateDistance({ lat, lon }, { lat: row.latitude, lon: row.longitude });
		const distance_nm = distance_m / 1852;

		try { this.posthog?.track('Nearest Airport Lookup', { icao: row.icao }); } catch { }

		return {
			icao: row.icao,
			latitude: row.latitude,
			longitude: row.longitude,
			name: row.name,
			continent: row.continent,
			distance_m: Math.round(distance_m),
			distance_nm: Number(distance_nm.toFixed(2)),
		};
	}
}
