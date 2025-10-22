import { customAlphabet } from 'nanoid';
export class IDService {
	private BARS_ID_PREFIX = 'BARS';
	private ID_LENGTH = 5;
	private ALLOWED_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	async generateBarsId(): Promise<string> {
		const nanoid = customAlphabet(this.ALLOWED_CHARS, this.ID_LENGTH);
		return `${this.BARS_ID_PREFIX}_${nanoid()}`;
	}
}
