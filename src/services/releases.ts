import { DatabaseSessionService } from './database-session';
import { StorageService } from './storage';

export type InstallerProduct = 'Pilot-Client' | 'vatSys-Plugin' | 'EuroScope-Plugin' | 'Installer' | 'SimConnect.NET';
export interface ReleaseRecord {
	id: number;
	product: InstallerProduct;
	version: string;
	file_key: string;
	file_size: number;
	file_hash: string;
	changelog?: string;
	image_url?: string;
	created_at: string;
}

export interface CreateReleaseInput {
	product: InstallerProduct;
	version: string;
	fileKey: string;
	fileSize: number;
	fileHash: string; // sha256 hex
	changelog?: string;
	imageUrl?: string;
}

export class ReleaseService {
	private dbSession: DatabaseSessionService;
	constructor(
		private db: D1Database,
		private storage: StorageService,
	) {
		this.dbSession = new DatabaseSessionService(db);
	}

	async createRelease(input: CreateReleaseInput): Promise<ReleaseRecord> {
		const { product, version, fileKey, fileSize, fileHash, changelog, imageUrl } = input;
		const result = await this.dbSession.executeWrite(
			`INSERT INTO installer_releases (product, version, file_key, file_size, file_hash, changelog, image_url) VALUES (?,?,?,?,?,?,?) RETURNING *`,
			[product, version, fileKey, fileSize, fileHash, changelog || null, imageUrl || null],
		);
		const rows = result.results as unknown as ReleaseRecord[] | null;
		const release = rows && rows[0];
		if (!release) throw new Error('Failed to create release');
		return release;
	}

	async listReleases(product?: InstallerProduct): Promise<ReleaseRecord[]> {
		if (product) {
			const res = await this.dbSession.executeRead<ReleaseRecord>(
				'SELECT * FROM installer_releases WHERE product = ? ORDER BY created_at DESC',
				[product],
			);
			return res.results;
		}
		const res = await this.dbSession.executeRead<ReleaseRecord>('SELECT * FROM installer_releases ORDER BY created_at DESC');
		return res.results;
	}

	async getLatest(product: InstallerProduct): Promise<ReleaseRecord | null> {
		const res = await this.dbSession.executeRead<ReleaseRecord>(
			`SELECT * FROM installer_releases WHERE product = ? ORDER BY created_at DESC LIMIT 1`,
			[product],
		);
		return res.results[0] || null;
	}

	async updateChangelog(id: number, changelog: string): Promise<ReleaseRecord | null> {
		const res = await this.dbSession.executeWrite(`UPDATE installer_releases SET changelog = ? WHERE id = ? RETURNING *`, [
			changelog,
			id,
		]);
		const rows = res.results as unknown as ReleaseRecord[] | null;
		return (rows && rows[0]) || null;
	}
}
