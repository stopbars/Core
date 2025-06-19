/**
 * Service for managing NOTAMs ( Website Notices )
 */
export class NotamService {
	constructor(private db: D1Database) { }
	/**
	 * Get the current global NOTAM
	 */ async getGlobalNotam(): Promise<{ content: string; type: string } | null> {
		try {
			const result = await this.db.prepare('SELECT id, content, type FROM notams WHERE id = ?').bind('global').first();

			if (!result) {
				return null;
			}

			return {
				content: result.content as string,
				type: (result.type as string) || 'warning',
			};
		} catch (error) {
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
			await this.db
				.prepare('INSERT OR REPLACE INTO notams (id, content, type, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime("now"))')
				.bind('global', content, type, userId)
				.run();
			return true;
		} catch (error) {
			return false;
		}
	}
}
