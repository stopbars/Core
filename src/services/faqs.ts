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
            `SELECT id, question, answer, order_position, created_at, updated_at FROM faqs ORDER BY order_position ASC, datetime(created_at) ASC`,
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
        await this.dbSession.executeWrite(
            `INSERT INTO faqs (id, question, answer, order_position, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
            [id, data.question, data.answer, data.order_position],
        );
        const created = await this.get(id);
        if (!created) throw new Error('Failed to create FAQ');
        return created;
    }

    async update(id: string, data: Partial<{ question: string; answer: string; order_position: number }>): Promise<FAQRecord | null> {
        const existing = await this.get(id);
        if (!existing) return null;
        const question = data.question ?? existing.question;
        const answer = data.answer ?? existing.answer;
        const order_position = data.order_position ?? existing.order_position;
        await this.dbSession.executeWrite(
            `UPDATE faqs SET question = ?, answer = ?, order_position = ?, updated_at = datetime('now') WHERE id = ?`,
            [question, answer, order_position, id],
        );
        return this.get(id);
    }

    async delete(id: string): Promise<boolean> {
        const result = await this.dbSession.executeWrite(`DELETE FROM faqs WHERE id = ?`, [id]);
        return result.success; // DatabaseSessionService returns success boolean
    }

    async reorder(updates: { id: string; order_position: number }[]): Promise<void> {
        // Simple transactional reorder
        for (const u of updates) {
            await this.dbSession.executeWrite(`UPDATE faqs SET order_position = ?, updated_at = datetime('now') WHERE id = ?`, [
                u.order_position,
                u.id,
            ]);
        }
    }
}
