/**
 * Service for managing NOTAMs ( Website Notices )
 */
import { DatabaseSessionService } from './database-session';

export class NotamService {
	private dbSession: DatabaseSessionService;
	constructor(private db: D1Database) {
		this.dbSession = new DatabaseSessionService(db);
	}
	/**
	 * Get the current global NOTAM
	 */ async getGlobalNotam(): Promise<{ content: string; type: string } | null> {
		try {
			const result = await this.dbSession.executeRead<{ content: string; type: string }>(
				'SELECT id, content, type FROM notams WHERE id = ?',
				['global'],
			);
			if (!result.results[0]) {
				return null;
			}
			return {
				content: result.results[0].content as string,
				type: (result.results[0].type as string) || 'warning',
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
			await this.dbSession.executeWrite(
				'INSERT OR REPLACE INTO notams (id, content, type, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime("now"))',
				['global', content, type, userId],
			);
			return true;
		} catch {
			return false;
		}
	}
}
