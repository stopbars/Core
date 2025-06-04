import { StatsRecord } from '../types';

export class StatsService {
	constructor(private db: D1Database) {}

	async incrementStat(key: string, value = 1) {
		const now = new Date();
		const dayKey = now.toISOString().split('T')[0];
		const timestamp = now.toISOString();

		const existingStat = await this.db
			.prepare('SELECT * FROM stats WHERE stat_key = ? AND day_key = ?')
			.bind(key, dayKey)
			.first<StatsRecord>();

		if (existingStat) {
			await this.db
				.prepare('UPDATE stats SET value = value + ?, last_updated = ? WHERE id = ?')
				.bind(value, timestamp, existingStat.id)
				.run();
		} else {
			await this.db
				.prepare('INSERT INTO stats (stat_key, value, day_key, last_updated) VALUES (?, ?, ?, ?)')
				.bind(key, value, dayKey, timestamp)
				.run();
		}
	}

	async getTotalStat(key: string): Promise<number> {
		const result = await this.db
			.prepare('SELECT SUM(value) as total FROM stats WHERE stat_key = ?')
			.bind(key)
			.first<{ total: number }>();

		return result?.total || 0;
	}

	async getDailyStats(key: string, days: number = 30): Promise<{ day: string; value: number }[]> {
		const result = await this.db
			.prepare(
				`
                SELECT day_key as day, value 
                FROM stats 
                WHERE stat_key = ? 
                AND day_key >= date('now', ?)
                ORDER BY day_key ASC
            `,
			)
			.bind(key, `-${days} days`)
			.all<{ day: string; value: number }>();

		return result.results || [];
	}

	async getPublicStats(): Promise<{ [key: string]: number }> {
		const sensitiveKeys = ['user_logins', 'user_signups', 'user_deletions', 'bars_xml_generations', 'remove_generations'];
		const result = await this.db
			.prepare(
				`
                SELECT stat_key, SUM(value) as total 
                FROM stats 
                WHERE stat_key NOT IN (${sensitiveKeys.map(() => '?').join(',')})
                GROUP BY stat_key
            `,
			)
			.bind(...sensitiveKeys)
			.all<{ stat_key: string; total: number }>();

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
		const result = await this.db
			.prepare(
				`
                SELECT stat_key, SUM(value) as total 
                FROM stats 
                WHERE stat_key IN (${sensitiveKeys.map(() => '?').join(',')})
                GROUP BY stat_key
            `,
			)
			.bind(...sensitiveKeys)
			.all<{ stat_key: string; total: number }>();

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
