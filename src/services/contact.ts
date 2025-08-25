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

	async createMessage(email: string, topic: string, message: string, ip: string): Promise<ContactMessageRecord> {
		const id = crypto.randomUUID();
		await this.dbSession.executeWrite(
			`INSERT INTO contact_messages (id, email, topic, message, ip_address, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
			[id, email, topic, message, ip],
		);
		const created = await this.getMessage(id);
		if (!created) throw new Error('Failed to create contact message');
		return created;
	}

	async getMessage(id: string): Promise<ContactMessageRecord | null> {
		const res = await this.dbSession.executeRead<ContactMessageRecord>(
			`SELECT id, email, topic, message, ip_address, status, handled_by, handled_at, created_at FROM contact_messages WHERE id = ?`,
			[id],
		);
		return res.results[0] || null;
	}

	async listMessages(): Promise<ContactMessageRecord[]> {
		const res = await this.dbSession.executeRead<ContactMessageRecord>(
			`SELECT id, email, topic, message, ip_address, status, handled_by, handled_at, created_at FROM contact_messages ORDER BY datetime(created_at) DESC`,
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
		if (status === 'handled') {
			await this.dbSession.executeWrite(
				`UPDATE contact_messages SET status = ?, handled_by = ?, handled_at = datetime('now') WHERE id = ?`,
				[status, handlerVatsimId, id],
			);
		} else {
			await this.dbSession.executeWrite(`UPDATE contact_messages SET status = ?, handled_at = NULL WHERE id = ?`, [status, id]);
		}
		return this.getMessage(id);
	}

	async deleteMessage(id: string): Promise<boolean> {
		const res = await this.dbSession.executeWrite(`DELETE FROM contact_messages WHERE id = ?`, [id]);
		return !!res.success;
	}

	async hasRecentSubmissionFromIp(ip: string, withinHours = 24): Promise<boolean> {
		const res = await this.dbSession.executeRead<{ cnt: number }>(
			`SELECT COUNT(*) as cnt FROM contact_messages WHERE ip_address = ? AND datetime(created_at) >= datetime('now', ?)`,
			[ip, `-${withinHours} hours`],
		);
		return (res.results[0]?.cnt || 0) > 0;
	}
}
