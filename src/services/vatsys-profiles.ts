import { StorageService } from './storage';

export interface VatSysProfileItem {
	icao: string;
	name: string;
	key: string;
}

/**
 * Service for managing vatSys profile XMLs in R2 storage.
 * Files are stored under a single folder: vatSysProfiles/{fileName}.xml
 * The file is saved with the exact uploaded filename (validated), since the name is significant for clients.
 */
export class VatSysProfilesService {
	private static readonly BASE_PREFIX = 'vatSysProfiles';
	private static readonly MAX_XML_BYTES = 1_000_000; // 1MB guard

	constructor(private storage: StorageService) {}

	private validateFileName(fileName: string): string {
		const name = (fileName || '').trim();
		if (!name) throw new Error('Invalid filename');
		// Disallow path traversal or separators
		if (name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('Invalid filename');
		// Require .xml extension (case-insensitive)
		if (!/\.xml$/i.test(name)) throw new Error('Filename must end with .xml');
		return name;
	}

	private buildKey(fileName: string): string {
		const validated = this.validateFileName(fileName);
		return `${VatSysProfilesService.BASE_PREFIX}/${validated}`;
	}

	/** Basic XML safety checks (rejects DOCTYPE/ENTITY and enforces declaration) */
	private static validateXml(xml: ArrayBuffer | string): void {
		let text: string;
		if (typeof xml === 'string') text = xml;
		else text = new TextDecoder().decode(xml);
		if (!text || text.length === 0) throw new Error('Empty XML');
		if (text.length > VatSysProfilesService.MAX_XML_BYTES) throw new Error('XML too large');
		const trimmed = text.trim();
		if (!trimmed.startsWith('<?xml')) throw new Error('XML must start with declaration');
		const forbidden = /(<!DOCTYPE|<!ENTITY|<!ELEMENT|SYSTEM\s+"[^"]*"|PUBLIC\s+"[^"]*")/i;
		if (forbidden.test(trimmed)) throw new Error('Invalid XML');
	}

	async upload(fileName: string, bytes: ArrayBuffer, uploaderVatsimId: string): Promise<{ key: string; etag: string }> {
		VatSysProfilesService.validateXml(bytes);
		const key = this.buildKey(fileName);
		return this.storage.uploadFile(key, bytes, 'application/xml', {
			uploadedBy: uploaderVatsimId,
			fileName: this.validateFileName(fileName),
			type: 'vatsys-profile',
		});
	}

	async delete(fileName: string): Promise<boolean> {
		const key = this.buildKey(fileName);
		return this.storage.deleteFile(key);
	}

	/**
	 * Lists all profiles.
	 */
	async list(): Promise<VatSysProfileItem[]> {
		const prefix = `${VatSysProfilesService.BASE_PREFIX}/`;
		const { objects } = await this.storage.listFiles(prefix, 1000);
		const all = objects
			.filter((o) => o.key.toLowerCase().endsWith('.xml'))
			.map((o) => {
				const file = o.key.split('/').pop() || '';
				const base = file.replace(/\.[^.]+$/i, '');
				// Derive ICAO as first 4 alphanumeric chars of the base name
				const icaoCandidate = (base.substring(0, 4) || '').toUpperCase();
				const derivedIcao = /^[A-Z0-9]{4}$/.test(icaoCandidate) ? icaoCandidate : '';
				return { icao: derivedIcao, name: file, key: o.key } as VatSysProfileItem;
			});
		return all;
	}
}
