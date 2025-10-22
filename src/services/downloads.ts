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

export interface VersionDownloadStats {
	version: string;
	count: number;
}

export interface ProductDownloadStats {
	product: InstallerProduct;
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
			return Array.from(new Uint8Array(digest))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');
		} catch {
			return ip.slice(0, 128);
		}
	}

	private async ensureDownloadRow(product: InstallerProduct, version: string): Promise<DownloadRow> {
		const insertRes = await this.dbSession.executeWrite(
			`INSERT INTO downloads (product, version, total_count)
				VALUES (?, ?, 0)
			ON CONFLICT(product, version) DO UPDATE SET total_count = total_count
			RETURNING id, product, version, total_count, created_at, updated_at`,
			[product, version],
		);
		const rows = insertRes.results as unknown as DownloadRow[] | null;
		if (rows && rows[0]) return rows[0];
		const fallback = await this.dbSession.executeRead<DownloadRow>(
			'SELECT * FROM downloads WHERE product = ? AND version = ? LIMIT 1',
			[product, version],
		);
		return fallback.results[0];
	}

	/**
	 * Records a download if this IP hasn't been counted for the product/version in the last 24h.
	 * Uses separate download_ip_hits table for per-IP tracking with automatic cleanup.
	 */
	async recordDownload(product: InstallerProduct, version: string, ip: string): Promise<{ versionCount: number; productTotal: number }> {
		const row = await this.ensureDownloadRow(product, version);
		const ipHash = await this.hashIp(ip || '0.0.0.0');

		// Fetch existing hit
		const hitRes = await this.dbSession.executeRead<{ last_seen: string }>(
			'SELECT last_seen FROM download_ip_hits WHERE product = ? AND version = ? AND ip_hash = ? LIMIT 1',
			[product, version, ipHash],
		);
		const existingHit = hitRes.results[0];
		let shouldIncrement = false;
		if (!existingHit) {
			shouldIncrement = true;
			await this.dbSession.executeWrite(
				`INSERT INTO download_ip_hits (product, version, ip_hash, last_seen) VALUES (?,?,?,CURRENT_TIMESTAMP)`,
				[product, version, ipHash],
			);
		} else {
			// Check if older than window
			const lastSeen = Date.parse(existingHit.last_seen);
			if (Number.isFinite(lastSeen)) {
				const ageMs = Date.now() - lastSeen;
				if (ageMs > DownloadsService.IP_UNIQUENESS_WINDOW_HOURS * 3600 * 1000) {
					shouldIncrement = true;
				}
			}
			if (shouldIncrement) {
				await this.dbSession.executeWrite(
					`UPDATE download_ip_hits SET last_seen = CURRENT_TIMESTAMP WHERE product = ? AND version = ? AND ip_hash = ?`,
					[product, version, ipHash],
				);
			}
		}

		if (shouldIncrement) {
			const updated = await this.dbSession.executeWrite(
				`UPDATE downloads
				SET total_count = total_count + 1, updated_at = CURRENT_TIMESTAMP
				WHERE id = ?
				RETURNING total_count AS version_count,
					(SELECT SUM(total_count) FROM downloads WHERE product = ?) AS product_total`,
				[row.id, product],
			);
			const updatedRows = updated.results as unknown as Array<{ version_count: number; product_total: number | null }> | null;
			const newCounts = updatedRows && updatedRows[0];
			// Best-effort cleanup (remove outdated hits > 24h). Lightweight single statement.
			try {
				await this.dbSession.executeWrite(
					`DELETE FROM download_ip_hits WHERE last_seen <= datetime('now', '-${DownloadsService.IP_UNIQUENESS_WINDOW_HOURS} hour')`,
				);
			} catch {
				/* ignore cleanup errors */
			}
			if (newCounts) {
				return {
					versionCount: newCounts.version_count,
					productTotal: newCounts.product_total ?? newCounts.version_count,
				};
			}
			return this.fetchCounts(product, version);
		} else {
			// No increment; return existing counts
			return this.fetchCounts(product, version);
		}
	}

	private async fetchCounts(product: InstallerProduct, version: string): Promise<{ versionCount: number; productTotal: number }> {
		const statsRes = await this.dbSession.executeRead<{
			version_count: number;
			product_total: number | null;
		}>(
			`WITH product_totals AS (
				SELECT product, SUM(total_count) AS product_total
				FROM downloads
				WHERE product = ?
				GROUP BY product
			)
			SELECT d.total_count AS version_count, product_totals.product_total
			FROM downloads d
			LEFT JOIN product_totals ON product_totals.product = d.product
			WHERE d.product = ? AND d.version = ?
			LIMIT 1`,
			[product, product, version],
		);
		const row = statsRes.results[0];
		if (row) {
			const fallbackTotal = row.product_total ?? row.version_count;
			return {
				versionCount: row.version_count,
				productTotal: fallbackTotal,
			};
		}
		const ensured = await this.ensureDownloadRow(product, version);
		return { versionCount: ensured.total_count, productTotal: ensured.total_count };
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
	async getAllStats(): Promise<ProductDownloadStats[]> {
		const rowsRes = await this.dbSession.executeRead<DownloadRow>(
			'SELECT product, version, total_count FROM downloads ORDER BY product, created_at DESC',
		);
		const byProduct = new Map<InstallerProduct, VersionDownloadStats[]>();
		for (const r of rowsRes.results) {
			const prod = r.product as InstallerProduct;
			const list = byProduct.get(prod) || [];
			list.push({ version: r.version, count: r.total_count });
			byProduct.set(prod, list);
		}
		const all: ProductDownloadStats[] = [];
		for (const [product, versions] of byProduct.entries()) {
			const total = versions.reduce((a, b) => a + b.count, 0);
			all.push({ product, total, versions });
		}
		// Keep deterministic ordering by product name
		all.sort((a, b) => (a.product < b.product ? -1 : a.product > b.product ? 1 : 0));
		return all;
	}
}
