import { DatabaseSessionService } from './database-session';
import { PostHogService } from './posthog';

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
}
