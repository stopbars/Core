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
	page?: number;
	limit?: number;
	status?: 'pending' | 'approved' | 'rejected' | 'outdated' | 'all';
	airportIcao?: string;
	userId?: string;
}

export interface ContributionListResult {
	contributions: Contribution[];
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

import { DatabaseSessionService } from './database-session';

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
	async createContribution(submission: ContributionSubmission): Promise<Contribution> {
		const airport = await this.airportService.getAirport(submission.airportIcao);
		if (!airport) {
			throw new Error(`Airport with ICAO ${submission.airportIcao} not found`);
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

		// Compute SHA-256 hash of normalized XML (hex)
		const encoder = new TextEncoder();
		const digest = await crypto.subtle.digest('SHA-256', encoder.encode(normalizedXml));
		const xmlHash = Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		// Prevent duplicate or stolen submissions:
		const existingForPackage = await this.dbSession.executeRead<{
			id: string;
			airport_icao: string;
			package_name: string;
			submitted_xml: string;
			status: 'pending' | 'approved' | 'rejected' | 'outdated';
		}>(
			`SELECT id, airport_icao, package_name, submitted_xml, status
			 FROM contributions
			 WHERE package_name = ? COLLATE NOCASE
			   AND status IN ('pending','approved')`,
			[submission.packageName],
		);
		for (const row of existingForPackage.results) {
			const otherHashDigest = await crypto.subtle.digest('SHA-256', encoder.encode(normalize(row.submitted_xml)));
			const otherHash = Array.from(new Uint8Array(otherHashDigest))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');
			if (otherHash === xmlHash) {
				throw new Error(
					'Duplicate submission detected: XML matches an existing contribution for the same package. Please submit original work.',
				);
			}
		}

		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		// Get authoritative display name from users table (ignore any client-provided value)
		const userDisplayResult = await this.dbSession.executeRead<{ display_name: string | null }>(
			'SELECT display_name FROM users WHERE vatsim_id = ?',
			[submission.userId],
		);
		const authoritativeDisplayName = userDisplayResult.results[0]?.display_name || null;
		await this.dbSession.executeWrite(
			`
	  INSERT INTO contributions (
		id, user_id, user_display_name, airport_icao, 
		package_name, submitted_xml, notes,
		submission_date, status
	  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
			[
				id,
				submission.userId,
				authoritativeDisplayName,
				submission.airportIcao,
				submission.packageName,
				trimmedXml,
				submission.notes || null,
				now,
				'pending',
			],
		);

		const contribution: Contribution = {
			id,
			userId: submission.userId,
			userDisplayName: authoritativeDisplayName,
			airportIcao: submission.airportIcao,
			packageName: submission.packageName,
			submittedXml: trimmedXml,
			notes: submission.notes || null,
			submissionDate: now,
			status: 'pending',
			rejectionReason: null,
			decisionDate: null,
		};
		try {
			this.posthog?.track('Contribution Submitted', {
				airport: submission.airportIcao,
				packageName: submission.packageName,
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
		id, user_id as userId, user_display_name as userDisplayName,
		airport_icao as airportIcao, package_name as packageName,
		submitted_xml as submittedXml, notes,
		submission_date as submissionDate, status,
		rejection_reason as rejectionReason, decision_date as decisionDate
	  FROM contributions
	  WHERE id = ?
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
				id, user_id as userId, user_display_name as userDisplayName,
				airport_icao as airportIcao, package_name as packageName,
				submitted_xml as submittedXml, notes,
				submission_date as submissionDate, status,
				rejection_reason as rejectionReason, decision_date as decisionDate
			FROM contributions
			WHERE airport_icao = ? AND lower(package_name) = lower(?) AND status = 'approved'
			ORDER BY datetime(decision_date) DESC
			LIMIT 1
			`,
			[airportIcao, packageName],
		);
		return result.results[0] || null;
	}

	/**
	 * List contributions with filtering and pagination
	 * @param options Filter and pagination options
	 * @returns Paginated list of contributions
	 */
	async listContributions(options: ContributionListOptions): Promise<ContributionListResult> {
		const { page = 1, limit = 10, status = 'all', airportIcao, userId } = options;
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
		const countQuery = `SELECT COUNT(*) as total FROM contributions ${whereClause}`;
		const countResult = await this.dbSession.executeRead<{ total: number }>(countQuery, params);
		const total = countResult.results[0]?.total || 0;

		const offset = (page - 1) * limit;
		const totalPages = Math.ceil(total / limit);

		const query = `
	  SELECT 
		id, user_id as userId, user_display_name as userDisplayName,
		airport_icao as airportIcao, package_name as packageName,
		submitted_xml as submittedXml, notes,
		submission_date as submissionDate, status,
		rejection_reason as rejectionReason, decision_date as decisionDate
	  FROM contributions
	  ${whereClause}
	  ORDER BY submission_date DESC
	  LIMIT ? OFFSET ?
	`;

		const contributionsResult = await this.dbSession.executeRead<Contribution>(query, [...params, limit, offset]);
		return {
			contributions: contributionsResult.results,
			total,
			page,
			limit,
			totalPages,
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
		const packageName = decision.newPackageName || contribution.packageName;

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

		// Get counts for different statuses
		const totalResult = await this.dbSession.executeRead<{ count: number }>('SELECT COUNT(*) as count FROM contributions', []);
		const pendingResult = await this.dbSession.executeRead<{ count: number }>(
			'SELECT COUNT(*) as count FROM contributions WHERE status = ?',
			['pending'],
		);
		const approvedResult = await this.dbSession.executeRead<{ count: number }>(
			'SELECT COUNT(*) as count FROM contributions WHERE status = ?',
			['approved'],
		);
		const rejectedResult = await this.dbSession.executeRead<{ count: number }>(
			'SELECT COUNT(*) as count FROM contributions WHERE status = ?',
			['rejected'],
		);
		const lastWeekResult = await this.dbSession.executeRead<{ count: number }>(
			'SELECT COUNT(*) as count FROM contributions WHERE submission_date > ?',
			[oneWeekAgoStr],
		);
		return {
			total: totalResult.results[0]?.count || 0,
			pending: pendingResult.results[0]?.count || 0,
			approved: approvedResult.results[0]?.count || 0,
			rejected: rejectedResult.results[0]?.count || 0,
			lastWeek: lastWeekResult.results[0]?.count || 0,
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
	/**
	 * Get user contributions with detailed list and summary statistics
	 * @param userId The user ID to get contributions for
	 * @param options Optional filtering and pagination options
	 * @returns User contributions data with detailed list and summary
	 */
	async getUserContributions(
		userId: string,
		options: {
			status?: 'pending' | 'approved' | 'rejected' | 'all';
			page?: number;
			limit?: number;
		} = {},
	): Promise<{
		contributions: Contribution[];
		summary: {
			total: number;
			approved: number;
			pending: number;
			rejected: number;
		};
		pagination: {
			page: number;
			limit: number;
			totalPages: number;
		};
	}> {
		const { status = 'all', page = 1, limit = 10 } = options;

		// Build WHERE and pagination first; we'll run summary and list queries in parallel
		const whereConditions = ['user_id = ?'];
		const params: (string | number)[] = [userId];
		if (status !== 'all') {
			whereConditions.push('status = ?');
			params.push(status);
		}
		const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
		const offset = (page - 1) * limit;

		// Get summary counts
		const summaryPromise = this.dbSession.executeRead<{
			total: number;
			approved: number;
			pending: number;
			rejected: number;
		}>(
			`
	  SELECT 
		COUNT(*) as total,
		SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
		SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
		SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
	  FROM contributions
	  WHERE user_id = ?
	`,
			[userId],
		);

		// Get the detailed contributions list
		const listQuery = `
	  SELECT 
		id, user_id as userId, user_display_name as userDisplayName,
		airport_icao as airportIcao, package_name as packageName,
		submitted_xml as submittedXml, notes,
		submission_date as submissionDate, status,
		rejection_reason as rejectionReason, decision_date as decisionDate
	  FROM contributions
	  ${whereClause}
	  ORDER BY submission_date DESC
	  LIMIT ? OFFSET ?
	`;
		const listPromise = this.dbSession.executeRead<Contribution>(listQuery, [...params, limit, offset]);

		const [summaryResult, contributionsResult] = await Promise.all([summaryPromise, listPromise]);
		const summaryRow = summaryResult.results[0] || { total: 0, approved: 0, pending: 0, rejected: 0 };
		const summary = {
			total: summaryRow.total || 0,
			approved: summaryRow.approved || 0,
			pending: summaryRow.pending || 0,
			rejected: summaryRow.rejected || 0,
		};

		// Calculate pagination (uses summary.total and limit)
		const totalPages = Math.ceil(summary.total / limit);
		return {
			contributions: contributionsResult.results,
			summary,
			pagination: {
				page,
				limit,
				totalPages,
			},
		};
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
		return results.results.map((r) => ({ name: r.display_name || r.user_id, count: r.contribution_count }));
	}
	// Removed legacy user display name update + lookup helpers; display names now sourced directly from users table
}
