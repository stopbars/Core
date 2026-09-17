import { DatabaseSessionService } from './database-session';

export interface ContactMessageRecord {
	id: string;
	email: string;
	topic: string;
	message: string;
	ip_address: string;
	status: 'pending' | 'handling' | 'handled';
	handled_by: string | null;
	handled_at: string | null;
	created_at: string;
}

export class ContactService {
	private dbSession: DatabaseSessionService;
	constructor(private db: D1Database) {
		this.dbSession = new DatabaseSessionService(db);
	}

	private async hashIp(ip: string): Promise<string> {
		try {
			const data = new TextEncoder().encode(ip || '0.0.0.0');
			const digest = await crypto.subtle.digest('SHA-256', data);
			let hex = '';
			for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
			return hex;
		} catch {
			return (ip || '0.0.0.0').slice(0, 128);
		}
	}

	async createMessage(email: string, topic: string, message: string, ip: string): Promise<ContactMessageRecord> {
		const id = crypto.randomUUID();
		const ipHash = await this.hashIp(ip);
		const result = await this.dbSession.executeWrite(
			`INSERT INTO contact_messages (id, email, topic, message, ip_address, status, created_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
			 RETURNING id, email, topic, message, ip_address, status, handled_by, handled_at, created_at`,
			[id, email, topic, message, ipHash],
		);
		// SAFETY: The INSERT RETURNING list exactly matches ContactMessageRecord and supplies one row on success.
		const rows = result.results as ContactMessageRecord[] | null;
		const created = rows?.[0];
		if (!created) throw new Error('Failed to create contact message');
		return created;
	}

	async listMessages(): Promise<ContactMessageRecord[]> {
		const res = await this.dbSession.executeRead<ContactMessageRecord>(
			`SELECT id, email, topic, message, ip_address, status, handled_by, handled_at, created_at FROM contact_messages ORDER BY created_at DESC`,
			[],
		);
		return res.results;
	}

	async updateStatus(
		id: string,
		status: 'pending' | 'handling' | 'handled',
		handlerVatsimId: string,
	): Promise<ContactMessageRecord | null> {
		// handled_by/handled_at only set when moving to handled, if returning to pending/handling clear handled_at but keep who last handled
		const result = await this.dbSession.executeWrite(
			`UPDATE contact_messages
			 SET status = ?,
				 handled_by = CASE WHEN ? = 'handled' THEN ? ELSE handled_by END,
				 handled_at = CASE WHEN ? = 'handled' THEN datetime('now') ELSE NULL END
			 WHERE id = ?
			 RETURNING id, email, topic, message, ip_address, status, handled_by, handled_at, created_at`,
			[status, status, handlerVatsimId, status, id],
		);
		// SAFETY: The UPDATE RETURNING list exactly matches ContactMessageRecord.
		const rows = result.results as ContactMessageRecord[] | null;
		return rows?.[0] ?? null;
	}

	async deleteMessage(id: string): Promise<boolean> {
		const result = await this.dbSession.executeWrite(`DELETE FROM contact_messages WHERE id = ? RETURNING id`, [id]);
		// SAFETY: The DELETE statement explicitly returns the string contact_messages.id column.
		const rows = result.results as Array<{ id: string }> | null;
		return Boolean(rows?.[0]);
	}

	async hasRecentSubmissionFromIp(ip: string, withinHours = 24): Promise<boolean> {
		const ipHash = await this.hashIp(ip);
		const res = await this.dbSession.executeRead<{ cnt: number }>(
			`SELECT EXISTS(
				SELECT 1 FROM contact_messages
				WHERE ip_address IN (?, ?) AND created_at >= datetime('now', ?)
				LIMIT 1
			) AS cnt`,
			[ip, ipHash, `-${withinHours} hours`],
		);
		return (res.results[0]?.cnt || 0) > 0;
	}
}
