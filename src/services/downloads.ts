import { DatabaseSessionService } from './database-session';
import { InstallerProduct } from './releases';

interface DownloadRow {
	id: number;
	product: string;
	version: string;
	total_count: number;
	created_at: string;
	updated_at: string;
}

interface DownloadBatchRow {
	id?: number;
	should_increment?: number;
	version?: string;
	total_count?: number;
}

export interface VersionDownloadStats {
	version: string;
	count: number;
}

export interface ProductDownloadStats<TProduct extends string = InstallerProduct> {
	product: TProduct;
	total: number;
	versions: VersionDownloadStats[];
}

export class DownloadsService {
	private dbSession: DatabaseSessionService;
	private static IP_UNIQUENESS_WINDOW_HOURS = 24;

	constructor(private db: D1Database) {
		this.dbSession = new DatabaseSessionService(db);
	}

	private async hashIp(ip: string): Promise<string> {
		try {
			const data = new TextEncoder().encode(ip);
			const digest = await crypto.subtle.digest('SHA-256', data);
			let hex = '';
			for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
			return hex;
		} catch {
			return ip.slice(0, 128);
		}
	}

	/**
	 * Records a download if this IP hasn't been counted for the product/version in the last 24h.
	 * Uses separate download_ip_hits table for per-IP tracking with automatic cleanup.
	 */
	async recordDownload(
		product: InstallerProduct,
		version: string,
		ip: string,
	): Promise<{ versionCount: number; productTotal: number; versions: VersionDownloadStats[] }> {
		const ipHash = await this.hashIp(ip || '0.0.0.0');
		const initial = await this.dbSession.executeBatch<DownloadBatchRow>([
			{
				query: `INSERT INTO downloads (product, version, total_count)
					VALUES (?, ?, 0)
					ON CONFLICT(product, version) DO UPDATE SET product = excluded.product
					RETURNING id`,
				params: [product, version],
			},
			{
				query: `INSERT INTO download_ip_hits (product, version, ip_hash, last_seen)
					VALUES (?, ?, ?, CURRENT_TIMESTAMP)
					ON CONFLICT(product, version, ip_hash) DO UPDATE SET last_seen = CURRENT_TIMESTAMP
					WHERE download_ip_hits.last_seen <= datetime('now', '-${DownloadsService.IP_UNIQUENESS_WINDOW_HOURS} hour')
					RETURNING 1 AS should_increment`,
				params: [product, version, ipHash],
			},
			{
				query: `SELECT version, total_count
					FROM downloads
					WHERE product = ?
					ORDER BY created_at DESC`,
				params: [product],
			},
		]);
		const shouldIncrement = Boolean(initial[1]?.results?.[0]?.should_increment);
		const mapVersions = (rows: DownloadBatchRow[]): VersionDownloadStats[] =>
			rows.map((row) => {
				if (row.version === undefined || row.total_count === undefined) {
					throw new Error('Database returned an invalid download statistics row');
				}
				return { version: row.version, count: row.total_count };
			});
		const initialVersions = mapVersions(initial[2]?.results ?? []);
		if (!shouldIncrement) {
			const versions = initialVersions;
			return {
				versionCount: versions.find((item) => item.version === version)?.count ?? 0,
				productTotal: versions.reduce((sum, item) => sum + item.count, 0),
				versions,
			};
		}

		const [, , updatedVersionRows] = await this.dbSession.executeBatch<DownloadBatchRow>([
			{
				query: `UPDATE downloads
					SET total_count = total_count + 1, updated_at = CURRENT_TIMESTAMP
					WHERE product = ? AND version = ?
					RETURNING total_count AS version_count`,
				params: [product, version],
			},
			{
				query: `DELETE FROM download_ip_hits
					WHERE last_seen <= datetime('now', '-${DownloadsService.IP_UNIQUENESS_WINDOW_HOURS} hour')`,
			},
			{
				query: `SELECT version, total_count
					FROM downloads
					WHERE product = ?
					ORDER BY created_at DESC`,
				params: [product],
			},
		]);
		const versions = updatedVersionRows.results ? mapVersions(updatedVersionRows.results) : initialVersions;
		return {
			versionCount: versions.find((item) => item.version === version)?.count ?? 0,
			productTotal: versions.reduce((sum, item) => sum + item.count, 0),
			versions,
		};
	}

	async getStats(product: InstallerProduct): Promise<ProductDownloadStats> {
		const rowsRes = await this.dbSession.executeRead<DownloadRow>(
			'SELECT version, total_count FROM downloads WHERE product = ? ORDER BY created_at DESC',
			[product],
		);
		const versions: VersionDownloadStats[] = rowsRes.results.map((r) => ({ version: r.version, count: r.total_count }));
		const total = versions.reduce((a, b) => a + b.count, 0);
		return { product, total, versions };
	}

	/**
	 * Returns download stats for all products.
	 */
	async getAllStats(): Promise<ProductDownloadStats<string>[]> {
		const rowsRes = await this.dbSession.executeRead<DownloadRow>(
			'SELECT product, version, total_count FROM downloads ORDER BY product, created_at DESC',
		);
		const byProduct = new Map<string, VersionDownloadStats[]>();
		for (const r of rowsRes.results) {
			const prod = r.product;
			const list = byProduct.get(prod) || [];
			list.push({ version: r.version, count: r.total_count });
			byProduct.set(prod, list);
		}
		const all: ProductDownloadStats<string>[] = [];
		for (const [product, versions] of byProduct.entries()) {
			const total = versions.reduce((a, b) => a + b.count, 0);
			all.push({ product, total, versions });
		}
		// Keep deterministic ordering by product name
		all.sort((a, b) => (a.product < b.product ? -1 : a.product > b.product ? 1 : 0));
		return all;
	}
}
