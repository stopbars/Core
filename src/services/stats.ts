import { StatsRecord } from '../types';
import { DatabaseSessionService } from './database-session';

export class StatsService {
	private dbSession: DatabaseSessionService;

	constructor(private db: D1Database) {
		this.dbSession = new DatabaseSessionService(db);
	}

	async incrementStat(key: string, value = 1) {
		// Use primary mode for stats writes to ensure consistency
		this.dbSession.startSession({ mode: 'first-primary' });

		const now = new Date();
		const dayKey = now.toISOString().split('T')[0];
		const timestamp = now.toISOString();

		const existingStatResult = await this.dbSession.execute<StatsRecord>(
			'SELECT * FROM stats WHERE stat_key = ? AND day_key = ?',
			[key, dayKey]
		);
		const existingStat = existingStatResult.results;

		if (existingStat) {
			await this.dbSession.executeWrite(
				'UPDATE stats SET value = value + ?, last_updated = ? WHERE id = ?',
				[value, timestamp, existingStat.id]
			);
		} else {
			await this.dbSession.executeWrite(
				'INSERT INTO stats (stat_key, value, day_key, last_updated) VALUES (?, ?, ?, ?)',
				[key, value, dayKey, timestamp]
			);
		}
	}

	async getTotalStat(key: string): Promise<number> {
		// Use read-optimized query for stats aggregation
		const result = await this.dbSession.executeRead<{ total: number }>(
			'SELECT SUM(value) as total FROM stats WHERE stat_key = ?',
			[key]
		);

		return result.results[0]?.total || 0;
	}

	async getDailyStats(key: string, days: number = 30): Promise<{ day: string; value: number }[]> {
		const result = await this.dbSession.executeRead<{ day: string; value: number }>(
			`
                SELECT day_key as day, value 
                FROM stats 
                WHERE stat_key = ? 
                AND day_key >= date('now', ?)
                ORDER BY day_key ASC
            `,
			[key, `-${days} days`]
		);

		return result.results || [];
	}

	async getPublicStats(): Promise<{ [key: string]: number }> {
		const sensitiveKeys = ['user_logins', 'user_signups', 'user_deletions', 'bars_xml_generations', 'remove_generations'];
		const placeholders = sensitiveKeys.map(() => '?').join(',');

		const result = await this.dbSession.executeRead<{ stat_key: string; total: number }>(
			`
                SELECT stat_key, SUM(value) as total 
                FROM stats 
                WHERE stat_key NOT IN (${placeholders})
                GROUP BY stat_key
            `,
			sensitiveKeys
		);

		return result.results.reduce(
			(acc, { stat_key, total }) => {
				acc[stat_key] = total;
				return acc;
			},
			{} as { [key: string]: number },
		);
	}
	async getSensitiveStats(): Promise<{ [key: string]: number }> {
		const sensitiveKeys = ['user_logins', 'user_signups', 'user_deletions', 'bars_xml_generations', 'remove_generations'];
		const placeholders = sensitiveKeys.map(() => '?').join(',');

		const result = await this.dbSession.executeRead<{ stat_key: string; total: number }>(
			`
                SELECT stat_key, SUM(value) as total 
                FROM stats 
                WHERE stat_key IN (${placeholders})
                GROUP BY stat_key
            `,
			sensitiveKeys
		);

		return result.results.reduce(
			(acc, { stat_key, total }) => {
				acc[stat_key] = total;
				return acc;
			},
			{} as { [key: string]: number },
		);
	}
}

// This service should be replaced with PostHog at some point.
