import { DatabaseSessionService } from './database-session';

export interface FAQRecord {
	id: string;
	question: string;
	answer: string;
	order_position: number;
	created_at: string;
	updated_at: string;
}

export class FAQService {
	private dbSession: DatabaseSessionService;
	constructor(private db: D1Database) {
		this.dbSession = new DatabaseSessionService(db);
	}

	async list(): Promise<{ faqs: FAQRecord[]; total: number }> {
		const result = await this.dbSession.executeRead<FAQRecord>(
			`SELECT id, question, answer, order_position, created_at, updated_at FROM faqs ORDER BY order_position ASC, created_at ASC`,
			[],
		);
		return { faqs: result.results, total: result.results.length };
	}

	async get(id: string): Promise<FAQRecord | null> {
		const result = await this.dbSession.executeRead<FAQRecord>(
			`SELECT id, question, answer, order_position, created_at, updated_at FROM faqs WHERE id = ?`,
			[id],
		);
		return result.results[0] || null;
	}

	async create(data: { question: string; answer: string; order_position: number }): Promise<FAQRecord> {
		const id = crypto.randomUUID();
		const result = await this.dbSession.executeWrite<FAQRecord>(
			`INSERT INTO faqs (id, question, answer, order_position, created_at, updated_at)
			 VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
			 RETURNING id, question, answer, order_position, created_at, updated_at`,
			[id, data.question, data.answer, data.order_position],
		);
		const created = result.results?.[0];
		if (!created) throw new Error('Failed to create FAQ');
		return created;
	}

	async update(id: string, data: Partial<{ question: string; answer: string; order_position: number }>): Promise<FAQRecord | null> {
		const result = await this.dbSession.executeWrite<FAQRecord>(
			`UPDATE faqs
			 SET question = CASE WHEN ? THEN ? ELSE question END,
				 answer = CASE WHEN ? THEN ? ELSE answer END,
				 order_position = CASE WHEN ? THEN ? ELSE order_position END,
				 updated_at = datetime('now')
			 WHERE id = ?
			 RETURNING id, question, answer, order_position, created_at, updated_at`,
			[
				data.question != null ? 1 : 0,
				data.question ?? null,
				data.answer != null ? 1 : 0,
				data.answer ?? null,
				data.order_position != null ? 1 : 0,
				data.order_position ?? null,
				id,
			],
		);
		return result.results?.[0] ?? null;
	}

	async delete(id: string): Promise<boolean> {
		const result = await this.dbSession.executeWrite(`DELETE FROM faqs WHERE id = ?`, [id]);
		return result.success; // DatabaseSessionService returns success boolean
	}

	async reorder(updates: { id: string; order_position: number }[]): Promise<void> {
		await this.dbSession.executeBatch(
			updates.map((update) => ({
				query: `UPDATE faqs SET order_position = ?, updated_at = datetime('now') WHERE id = ?`,
				params: [update.order_position, update.id],
			})),
		);
	}
}
