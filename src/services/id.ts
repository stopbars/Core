import { customAlphabet } from 'nanoid';

export class IDService {
	private readonly BARS_ID_PREFIX = 'BARS';
	private readonly ID_LENGTH = 5;
	private readonly ALLOWED_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	private readonly nanoid = customAlphabet(this.ALLOWED_CHARS, this.ID_LENGTH);

	async generateBarsId(): Promise<string> {
		const [id] = await this.generateBarsIds(1);
		return id;
	}

	async generateBarsIds(count: number): Promise<string[]> {
		if (count <= 0) {
			return [];
		}
		const ids: string[] = [];
		for (let i = 0; i < count; i++) {
			ids.push(`${this.BARS_ID_PREFIX}_${this.nanoid()}`);
		}
		return ids;
	}
}
