import { RoleService, StaffRole } from './roles';
import { AirportService } from './airport';
import { StorageService } from './storage';
import { SupportService } from './support';
import { PolygonService } from './polygons';
import { PostHogService } from './posthog';
import { sanitizeContributionXml } from './xml-sanitizer';

export interface Contribution {
	id: string;
	userId: string;
	userDisplayName: string | null;
	airportIcao: string;
	packageName: string;
	submittedXml: string;
	notes: string | null;
	submissionDate: string;
	status: 'pending' | 'approved' | 'rejected' | 'outdated';
	rejectionReason: string | null;
	decisionDate: string | null;
}

export interface ContributionSubmission {
	userId: string;
	airportIcao: string;
	packageName: string;
	submittedXml: string;
	notes?: string;
}

export interface ContributionDecision {
	approved: boolean;
	rejectionReason?: string;
	newPackageName?: string;
}

export interface ContributionListOptions {
	status?: 'pending' | 'approved' | 'rejected' | 'outdated' | 'all';
	airportIcao?: string;
	userId?: string;
}

export interface ContributionListResult {
	contributions: Contribution[];
	total: number;
}

import { DatabaseSessionService } from './database-session';

export const MAX_CONTRIBUTION_NOTES_CHARS = 1000;
export const MAX_CONTRIBUTION_PACKAGE_CHARS = 64;
const ICAO_REGEX = /^[A-Z0-9]{4}$/;

export class ContributionService {
	private airportService: AirportService;
	private supportService: SupportService;
	private polygonService: PolygonService;
	private storageService: StorageService;
	private dbSession: DatabaseSessionService;

	constructor(
		private db: D1Database,
		private roleService: RoleService,
		apiKey: string,
		storage: R2Bucket,
		private posthog?: PostHogService,
	) {
		this.airportService = new AirportService(db, apiKey);
		this.supportService = new SupportService(db);
		this.polygonService = new PolygonService(db);
		this.storageService = new StorageService(storage);
		this.dbSession = new DatabaseSessionService(db);
	}

	private normalizeAirportIcao(raw: string): string {
		if (typeof raw !== 'string') {
			throw new Error('airportIcao must be a string');
		}
		const normalized = raw.trim().toUpperCase();
		if (!ICAO_REGEX.test(normalized)) {
			throw new Error('airportIcao must be a valid 4-character ICAO code');
		}
		return normalized;
	}

	private sanitizePackageName(raw: string, fieldLabel = 'packageName'): string {
		if (typeof raw !== 'string') {
			throw new Error(`${fieldLabel} must be a string`);
		}
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			throw new Error(`${fieldLabel} is required`);
		}
		if (trimmed.length > MAX_CONTRIBUTION_PACKAGE_CHARS) {
			throw new Error(`${fieldLabel} must be ${MAX_CONTRIBUTION_PACKAGE_CHARS} characters or fewer`);
		}
		return trimmed;
	}
	async createContribution(submission: ContributionSubmission): Promise<Contribution> {
		const normalizedAirportIcao = this.normalizeAirportIcao(submission.airportIcao);
		const sanitizedPackageName = this.sanitizePackageName(submission.packageName);

		const airport = await this.airportService.getAirport(normalizedAirportIcao);
		if (!airport) {
			throw new Error(`Airport with ICAO ${normalizedAirportIcao} not found`);
		}

		let sanitizedNotes: string | null = null;
		if (submission.notes !== undefined && submission.notes !== null) {
			if (typeof submission.notes !== 'string') {
				throw new Error('Notes must be a string');
			}
			const trimmed = submission.notes.trim();
			if (trimmed.length > MAX_CONTRIBUTION_NOTES_CHARS) {
				throw new Error(`Notes must be ${MAX_CONTRIBUTION_NOTES_CHARS} characters or fewer`);
			}
			sanitizedNotes = trimmed.length > 0 ? trimmed : null;
		}

		// Sanitize & validate submitted XML to mitigate injection / XXE attempts
		let trimmedXml: string;
		try {
			trimmedXml = sanitizeContributionXml(submission.submittedXml);
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Invalid XML';
			throw new Error(msg);
		}

		// Normalize XML content for stable hashing and comparison
		const normalize = (xml: string) =>
			xml
				.trim()
				.replace(/\r/g, '')
				.replace(/[\t ]+/g, ' ')
				.replace(/>\s+</g, '><');
		const normalizedXml = normalize(trimmedXml);

		// Prevent duplicate or stolen submissions:
		const existingForPackage = await this.dbSession.executeRead<{
			submitted_xml: string;
		}>(
			`SELECT submitted_xml
			 FROM contributions
			 WHERE package_name = ? COLLATE NOCASE
			   AND status IN ('pending','approved')`,
			[sanitizedPackageName],
		);
		for (const row of existingForPackage.results) {
			if (normalize(row.submitted_xml) === normalizedXml) {
				throw new Error(
					'Duplicate submission detected: XML matches an existing contribution for the same package. Please submit original work.',
				);
			}
		}

		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		// Insert without snapshot of display name; we'll always resolve via users table when reading
		await this.dbSession.executeWrite(
			`
	  INSERT INTO contributions (
		id, user_id, airport_icao, 
		package_name, submitted_xml, notes,
		submission_date, status
	  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`,
			[id, submission.userId, normalizedAirportIcao, sanitizedPackageName, trimmedXml, sanitizedNotes, now, 'pending'],
		);

		const contribution: Contribution = {
			id,
			userId: submission.userId,
			userDisplayName: null, // resolved dynamically on retrieval
			airportIcao: normalizedAirportIcao,
			packageName: sanitizedPackageName,
			submittedXml: trimmedXml,
			notes: sanitizedNotes,
			submissionDate: now,
			status: 'pending',
			rejectionReason: null,
			decisionDate: null,
		};
		try {
			this.posthog?.track('Contribution Submitted', {
				airport: normalizedAirportIcao,
				packageName: sanitizedPackageName,
				userId: submission.userId,
			});
		} catch (e) {
			console.warn('Posthog track failed (Contribution Submitted)', e);
		}
		return contribution;
	}
	async getContribution(id: string): Promise<Contribution | null> {
		const result = await this.dbSession.executeRead<Contribution>(
			`
	  SELECT 
		c.id, c.user_id as userId, u.display_name as userDisplayName,
		c.airport_icao as airportIcao, c.package_name as packageName,
		c.submitted_xml as submittedXml, c.notes,
		c.submission_date as submissionDate, c.status,
		c.rejection_reason as rejectionReason, c.decision_date as decisionDate
	  FROM contributions c
	  LEFT JOIN users u ON u.vatsim_id = c.user_id
	  WHERE c.id = ?
	`,
			[id],
		);
		return result.results[0] || null;
	}

	/**
	 * Get the most recently approved contribution for an airport & package (by decision_date)
	 * Case-insensitive package name match.
	 * @param airportIcao ICAO code
	 * @param packageName Package name (case-insensitive)
	 */
	async getLatestApprovedContributionForAirportPackage(airportIcao: string, packageName: string): Promise<Contribution | null> {
		const result = await this.dbSession.executeRead<Contribution>(
			`
			SELECT 
				c.id, c.user_id as userId, u.display_name as userDisplayName,
				c.airport_icao as airportIcao, c.package_name as packageName,
				c.submitted_xml as submittedXml, c.notes,
				c.submission_date as submissionDate, c.status,
				c.rejection_reason as rejectionReason, c.decision_date as decisionDate
			FROM contributions c
			LEFT JOIN users u ON u.vatsim_id = c.user_id
			WHERE c.airport_icao = ? AND lower(c.package_name) = lower(?) AND c.status = 'approved'
			ORDER BY datetime(c.decision_date) DESC
			LIMIT 1
			`,
			[airportIcao, packageName],
		);
		return result.results[0] || null;
	}

	async listContributions(options: ContributionListOptions): Promise<ContributionListResult> {
		const { status = 'all', airportIcao, userId } = options;
		const whereConditions = [];
		const params = [];

		if (status !== 'all') {
			whereConditions.push('status = ?');
			params.push(status);
		}

		if (airportIcao) {
			whereConditions.push('airport_icao = ?');
			params.push(airportIcao);
		}

		if (userId) {
			whereConditions.push('user_id = ?');
			params.push(userId);
		}

		const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
		const query = `
	  SELECT 
		c.id, c.user_id as userId, u.display_name as userDisplayName,
		c.airport_icao as airportIcao, c.package_name as packageName,
		c.submitted_xml as submittedXml, c.notes,
		c.submission_date as submissionDate, c.status,
		c.rejection_reason as rejectionReason, c.decision_date as decisionDate
	  FROM contributions c
	  LEFT JOIN users u ON u.vatsim_id = c.user_id
	  ${whereClause}
	  ORDER BY c.submission_date DESC
	`;

		const contributionsResult = await this.dbSession.executeRead<Contribution>(query, params);
		const total = contributionsResult.results.length;
		return {
			contributions: contributionsResult.results,
			total,
		};
	}

	async listContributionsSimple(options: ContributionListOptions): Promise<{
		contributions: Array<{
			id: string;
			airportIcao: string;
			packageName: string;
		}>;
		total: number;
	}> {
		const { status = 'all', airportIcao, userId } = options;
		const whereConditions = [];
		const params = [];

		if (status !== 'all') {
			whereConditions.push('status = ?');
			params.push(status);
		}

		if (airportIcao) {
			whereConditions.push('airport_icao = ?');
			params.push(airportIcao);
		}

		if (userId) {
			whereConditions.push('user_id = ?');
			params.push(userId);
		}

		const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
		const query = `
		SELECT 
			c.id,
			c.airport_icao as airportIcao,
			c.package_name as packageName
		FROM contributions c
		${whereClause}
		ORDER BY c.submission_date DESC
		`;

		const contributionsResult = await this.dbSession.executeRead<{
			id: string;
			airportIcao: string;
			packageName: string;
		}>(query, params);

		return {
			contributions: contributionsResult.results,
			total: contributionsResult.results.length,
		};
	}

	async processDecision(id: string, userId: string, decision: ContributionDecision): Promise<Contribution> {
		const userInfoResult = await this.dbSession.executeRead<{ id: number }>('SELECT id FROM users WHERE vatsim_id = ?', [userId]);
		const userInfo = userInfoResult.results[0];

		if (!userInfo) {
			throw new Error('User not found');
		}

		const hasPermission = await this.roleService.hasPermission(userInfo.id, StaffRole.PRODUCT_MANAGER);

		if (!hasPermission) {
			throw new Error('Not authorized to make decisions on contributions');
		}

		// Get the contribution to make sure it exists and is pending
		const contribution = await this.getContribution(id);

		if (!contribution) {
			throw new Error('Contribution not found');
		}

		if (contribution.status !== 'pending') {
			throw new Error('This contribution has already been processed');
		}

		// Handle package name correction if provided
		const packageName =
			decision.newPackageName !== undefined && decision.newPackageName !== null
				? this.sanitizePackageName(decision.newPackageName, 'newPackageName')
				: contribution.packageName;

		// Update contribution with decision
		const now = new Date().toISOString();
		const status = decision.approved ? 'approved' : 'rejected'; // If approving, mark any existing approved contributions for the same airport and package as outdated
		if (decision.approved) {
			await this.dbSession.executeWrite(
				`
		UPDATE contributions
		SET status = 'outdated', decision_date = ?
		WHERE airport_icao = ? 
		AND package_name = ? 
		AND status = 'approved' 
		AND id != ?
	  `,
				[now, contribution.airportIcao, packageName, id],
			);

			// Generate and upload the XML files to CDN
			try {
				// Generate both XML files from the submitted XML
				const [supportsXml, barsXml] = await Promise.all([
					this.supportService.generateLightSupportsXML(contribution.submittedXml, contribution.airportIcao),
					this.polygonService.processBarsXML(contribution.submittedXml),
				]);

				// Create safe filenames for the uploads
				const safePackageName = packageName.replace(/[^a-zA-Z0-9.-]/g, '-');

				// Filename format: ICAO_PackageName_type.xml
				const supportsFileName = `${contribution.airportIcao}_${safePackageName}_supports.xml`;
				const barsFileName = `${contribution.airportIcao}_${safePackageName}_bars.xml`;

				// Set folder paths for each file type
				const removalObjectsPath = 'RemovalObjects';
				const mapsPath = 'Maps';

				// Upload the files to CDN
				await Promise.all([
					// Upload light supports XML to RemovalObjects folder
					this.storageService.uploadFile(`${removalObjectsPath}/${supportsFileName}`, supportsXml, 'application/xml', {
						airportIcao: contribution.airportIcao,
						packageName: contribution.packageName,
						type: 'removal',
						generatedFrom: `contribution_${id}`,
					}),

					// Upload BARS XML to Maps folder
					this.storageService.uploadFile(`${mapsPath}/${barsFileName}`, barsXml, 'application/xml', {
						airportIcao: contribution.airportIcao,
						packageName: contribution.packageName,
						type: 'bars',
						generatedFrom: `contribution_${id}`,
					}),
				]);
			} catch {
				// Don't throw the error, as we still want to update the contribution status
			}
		}
		await this.dbSession.executeWrite(
			`
	  UPDATE contributions
	  SET status = ?, rejection_reason = ?, decision_date = ?, package_name = ?
	  WHERE id = ?
	`,
			[status, decision.approved ? null : decision.rejectionReason || 'No reason provided', now, packageName, id],
		);

		const updated: Contribution = {
			...contribution,
			packageName,
			status,
			rejectionReason: decision.approved ? null : decision.rejectionReason || 'No reason provided',
			decisionDate: now,
		};
		try {
			this.posthog?.track(decision.approved ? 'Contribution Approved' : 'Contribution Rejected', {
				id,
				airport: contribution.airportIcao,
				packageName,
				decidedBy: userId,
				rejectionReason: decision.approved ? undefined : decision.rejectionReason || 'No reason provided',
			});
		} catch (e) {
			console.warn('Posthog track failed (Contribution Decision)', e);
		}
		return updated;
	}
	async getContributionStats(): Promise<{
		total: number;
		pending: number;
		approved: number;
		rejected: number;
		lastWeek: number;
	}> {
		const oneWeekAgo = new Date();
		oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
		const oneWeekAgoStr = oneWeekAgo.toISOString();

		const statsResult = await this.dbSession.executeRead<{
			total: number | null;
			pending: number | null;
			approved: number | null;
			rejected: number | null;
			lastWeek: number | null;
		}>(
			`
			SELECT
				COUNT(*) as total,
				SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
				SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
				SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
				SUM(CASE WHEN submission_date > ? THEN 1 ELSE 0 END) as lastWeek
			FROM contributions
			`,
			[oneWeekAgoStr],
		);
		const row = statsResult.results[0] || {
			total: 0,
			pending: 0,
			approved: 0,
			rejected: 0,
			lastWeek: 0,
		};
		return {
			total: row.total || 0,
			pending: row.pending || 0,
			approved: row.approved || 0,
			rejected: row.rejected || 0,
			lastWeek: row.lastWeek || 0,
		};
	}
	async deleteContribution(id: string, userId: string): Promise<boolean> {
		const userInfoResult = await this.dbSession.executeRead<{ id: number }>('SELECT id FROM users WHERE vatsim_id = ?', [userId]);
		const userInfo = userInfoResult.results[0];
		if (!userInfo) {
			throw new Error('User not found');
		}
		// Fetch contribution to validate existence/ownership
		const existing = await this.getContribution(id);
		if (!existing) {
			return false; // not found
		}
		const isStaff = await this.roleService.hasPermission(userInfo.id, StaffRole.PRODUCT_MANAGER);
		const isOwner = existing.userId === userId;
		const isDeletableStatus = existing.status === 'pending' || existing.status === 'rejected';
		const canDelete = isDeletableStatus && (isStaff || isOwner);
		if (!canDelete) {
			throw new Error('Not authorized to delete contributions');
		}
		const result = await this.dbSession.executeWrite('DELETE FROM contributions WHERE id = ?', [id]);
		if (result.success) {
			try {
				this.posthog?.track('Contribution Deleted', {
					id,
					deletedBy: userId,
					role: isStaff ? 'staff' : 'owner',
					status: existing.status,
				});
			} catch (e) {
				console.warn('Posthog track failed (Contribution Deleted)', e);
			}
		}
		return result.success;
	}

	async regenerateContribution(
		id: string,
		requestedByVatsimId: string,
	): Promise<{
		maps: { key: string; etag: string };
		supports: { key: string; etag: string };
	}> {
		// Resolve local user and permissions
		const userInfoResult = await this.dbSession.executeRead<{ id: number }>('SELECT id FROM users WHERE vatsim_id = ?', [
			requestedByVatsimId,
		]);
		const userInfo = userInfoResult.results[0];
		if (!userInfo) {
			throw new Error('User not found');
		}
		const allowed = await this.roleService.hasPermission(userInfo.id, StaffRole.PRODUCT_MANAGER);
		if (!allowed) {
			throw new Error('Not authorized to regenerate contributions');
		}

		// Load contribution
		const contribution = await this.getContribution(id);
		if (!contribution) {
			throw new Error('Contribution not found');
		}

		// Only approved entries can be regenerated to avoid conflicts
		if (contribution.status !== 'approved') {
			throw new Error('Only approved contributions can be regenerated');
		}

		try {
			// Generate both XMLs
			const [supportsXml, barsXml] = await Promise.all([
				this.supportService.generateLightSupportsXML(contribution.submittedXml, contribution.airportIcao),
				this.polygonService.processBarsXML(contribution.submittedXml),
			]);

			// Safe filename components
			const safePackageName = contribution.packageName.replace(/[^a-zA-Z0-9.-]/g, '-');
			const supportsFileName = `${contribution.airportIcao}_${safePackageName}_supports.xml`;
			const barsFileName = `${contribution.airportIcao}_${safePackageName}_bars.xml`;

			// Upload to the same paths (overwrite)
			const [supportsRes, barsRes] = await Promise.all([
				this.storageService.uploadFile(`RemovalObjects/${supportsFileName}`, supportsXml, 'application/xml', {
					airportIcao: contribution.airportIcao,
					packageName: contribution.packageName,
					type: 'removal',
					regeneratedFrom: `contribution_${id}`,
				}),
				this.storageService.uploadFile(`Maps/${barsFileName}`, barsXml, 'application/xml', {
					airportIcao: contribution.airportIcao,
					packageName: contribution.packageName,
					type: 'bars',
					regeneratedFrom: `contribution_${id}`,
				}),
			]);

			try {
				this.posthog?.track('Contribution Regenerated', {
					id,
					airport: contribution.airportIcao,
					packageName: contribution.packageName,
					requestedBy: requestedByVatsimId,
				});
			} catch (e) {
				console.warn('Posthog track failed (Contribution Regenerated)', e);
			}

			return {
				maps: { key: barsRes.key, etag: barsRes.etag },
				supports: { key: supportsRes.key, etag: supportsRes.etag },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			throw new Error(`Failed to regenerate: ${msg}`);
		}
	}

	async getTopPackages(): Promise<
		Array<{
			packageName: string;
			count: number;
		}>
	> {
		const query = `
	  SELECT 
		package_name as packageName,
		COUNT(*) as count
	  FROM contributions
	  WHERE status = 'approved'
	  GROUP BY package_name
	  ORDER BY count DESC
	`;

		const results = await this.dbSession.executeRead<{
			packageName: string;
			count: number;
		}>(query);
		return results.results;
	}
	async getContributionLeaderboard(): Promise<
		Array<{
			vatsimId: string;
			name: string;
			count: number;
		}>
	> {
		const query = `
	  SELECT c.user_id, u.display_name, COUNT(*) as contribution_count
	  FROM contributions c
	  LEFT JOIN users u ON u.vatsim_id = c.user_id
	  WHERE c.status = 'approved'
	  GROUP BY c.user_id
	  ORDER BY contribution_count DESC
	  LIMIT 5
	`;
		const results = await this.dbSession.executeRead<{
			user_id: string;
			display_name: string | null;
			contribution_count: number;
		}>(query);
		return results.results.map((r) => ({
			vatsimId: r.user_id,
			name: r.display_name || r.user_id,
			count: r.contribution_count,
		}));
	}
	// Removed legacy user display name update + lookup helpers; display names now sourced directly from users table
}
