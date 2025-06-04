import { customAlphabet } from 'nanoid';

export class IDService {
	private BARS_ID_PREFIX = 'BARS';
	private ID_LENGTH = 5;
	private ALLOWED_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

	constructor(private db: D1Database) {}

	async generateBarsId(): Promise<string> {
		const nanoid = customAlphabet(this.ALLOWED_CHARS, this.ID_LENGTH);

		while (true) {
			const uniqueId = nanoid();
			const barsId = `${this.BARS_ID_PREFIX}_${uniqueId}`;
			const existingPoint = await this.db.prepare('SELECT id FROM points WHERE id = ?').bind(barsId).first();

			if (!existingPoint) {
				return barsId;
			}
		}
	}

	validateBarsId(id: string): boolean {
		// Validate BARS ID format BARS_XXXXX
		const pattern = new RegExp(`^${this.BARS_ID_PREFIX}_[0-9A-Z]{${this.ID_LENGTH}}$`);
		return pattern.test(id);
	}
}
