/**
 * Service for managing NOTAMs ( Website Notices )
 */
import { DatabaseSessionService } from './database-session';

export class NotamService {
	constructor(private db: D1Database) {}
	/**
	 * Get the current global NOTAM
	 */ async getGlobalNotam(): Promise<{ content: string; type: string } | null> {
		try {
			const result = await DatabaseSessionService.simpleRead<{ content: string; type: string }>(
				this.db,
				'SELECT content, type FROM notams WHERE id = ?',
				['global'],
			);
			const record = result.results[0];
			if (!record) {
				return null;
			}
			return {
				content: record.content,
				type: record.type || 'warning',
			};
		} catch {
			return null;
		}
	}

	/**
	 * Update the global NOTAM
	 */
	async updateGlobalNotam(content: string, type: string = 'warning', userId: string): Promise<boolean> {
		try {
			// Validate type
			const validTypes = ['warning', 'info', 'discord', 'success', 'error'];
			if (!validTypes.includes(type)) {
				type = 'warning'; // Default to warning if invalid type
			}
			await DatabaseSessionService.simpleWrite(
				this.db,
				'INSERT OR REPLACE INTO notams (id, content, type, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime("now"))',
				['global', content, type, userId],
			);
			return true;
		} catch {
			return false;
		}
	}
}
