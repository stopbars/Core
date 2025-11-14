import { customAlphabet } from 'nanoid';
// @ts-expect-error -- importing a text file
import badWordsRaw from '../../data/bad-words.txt';

const ALLOWED_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ID_LENGTH = 5;
const MAX_TRIES_PER_ID = 100;
const BARS_ID_PREFIX = 'BARS';

const nanoid = customAlphabet(ALLOWED_CHARS, ID_LENGTH);

const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeForCheck = (s: string): string =>
	s.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B').replace(/2/g, 'Z');

const BAD_WORDS: string[] = badWordsRaw
	.split(/\r?\n/)
	.map((line: string) => line.trim())
	.filter(Boolean)
	.filter((line: string) => !line.startsWith('#') && !line.startsWith('//'))
	.map((line: string) => line.toUpperCase());

const BAD_REGEX: RegExp | null = BAD_WORDS.length > 0 ? new RegExp(BAD_WORDS.map(escapeForRegex).join('|'), 'i') : null;

const isClean = (suffix: string): boolean => {
	if (!BAD_REGEX) return true;

	if (BAD_REGEX.test(suffix)) return false;

	const normalized = normalizeForCheck(suffix);
	if (normalized !== suffix && BAD_REGEX.test(normalized)) return false;

	return true;
};

const generateCleanSuffix = (): string => {
	for (let tries = 0; tries < MAX_TRIES_PER_ID; tries += 1) {
		const suffix = nanoid();
		if (isClean(suffix)) {
			return suffix;
		}
	}

	throw new Error(`Failed to generate clean ID after ${MAX_TRIES_PER_ID} attempts`);
};

export class IDService {
	async generateBarsIds(count: number): Promise<string[]> {
		if (count <= 0) return [];

		const ids: string[] = [];
		for (let i = 0; i < count; i++) {
			const suffix = generateCleanSuffix();
			ids.push(`${BARS_ID_PREFIX}_${suffix}`);
		}
		return ids;
	}

	async generateBarsId(): Promise<string> {
		const [id] = await this.generateBarsIds(1);
		return id;
	}
}
