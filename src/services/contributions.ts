import { RoleService, StaffRole } from './roles';
import { AirportService } from './airport';
import { StatsService } from './stats';
import { StorageService } from './storage';
import { SupportService } from './support';
import { PolygonService } from './polygons';

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
	userDisplayName?: string;
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

export class ContributionService {
	private statsService: StatsService;
	private airportService: AirportService;
	private supportService: SupportService;
	private polygonService: PolygonService;
	private storageService: StorageService;

	constructor(
		private db: D1Database,
		private roleService: RoleService,
		apiKey: string,
		storage: R2Bucket,
	) {
		this.statsService = new StatsService(db);
		this.airportService = new AirportService(db, apiKey);
		this.supportService = new SupportService(db);
		this.polygonService = new PolygonService(db);
		this.storageService = new StorageService(storage);
	}
	async createContribution(submission: ContributionSubmission): Promise<Contribution> {
		const airport = await this.airportService.getAirport(submission.airportIcao);
		if (!airport) {
			throw new Error(`Airport with ICAO ${submission.airportIcao} not found`);
		}

		const trimmedXml = submission.submittedXml.trim();
		if (!trimmedXml || !trimmedXml.startsWith('<?xml')) {
			throw new Error('Invalid XML format');
		}

		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		await this.updateUserDisplayNameForAllContributions(submission.userId, submission.userDisplayName || null);
		await this.db
			.prepare(
				`
      INSERT INTO contributions (
        id, user_id, user_display_name, airport_icao, 
        package_name, submitted_xml, notes,
        submission_date, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
			)
			.bind(
				id,
				submission.userId,
				submission.userDisplayName || null,
				submission.airportIcao,
				submission.packageName,
				trimmedXml,
				submission.notes || null,
				now,
				'pending',
			)
			.run();

		await this.statsService.incrementStat('contributions_submitted');

		return {
			id,
			userId: submission.userId,
			userDisplayName: submission.userDisplayName || null,
			airportIcao: submission.airportIcao,
			packageName: submission.packageName,
			submittedXml: trimmedXml,
			notes: submission.notes || null,
			submissionDate: now,
			status: 'pending',
			rejectionReason: null,
			decisionDate: null,
		};
	}
	async getContribution(id: string): Promise<Contribution | null> {
		const contribution = await this.db
			.prepare(
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
			)
			.bind(id)
			.first<Contribution>();

		return contribution || null;
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
		const countResult = await this.db
			.prepare(countQuery)
			.bind(...params)
			.first<{ total: number }>();
		const total = countResult?.total || 0;

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

		const contributions = await this.db
			.prepare(query)
			.bind(...params, limit, offset)
			.all<Contribution>();

		return {
			contributions: contributions.results,
			total,
			page,
			limit,
			totalPages,
		};
	}

	async processDecision(id: string, userId: string, decision: ContributionDecision): Promise<Contribution> {
		const userInfo = await this.db.prepare('SELECT id FROM users WHERE vatsim_id = ?').bind(userId).first<{ id: number }>();

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
			await this.db
				.prepare(
					`
        UPDATE contributions
        SET status = 'outdated', decision_date = ?
        WHERE airport_icao = ? 
        AND package_name = ? 
        AND status = 'approved' 
        AND id != ?
      `,
				)
				.bind(
					now,
					contribution.airportIcao,
					packageName, // Use potentially updated package name
					id,
				)
				.run();

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
			} catch (error) {
				// Don't throw the error, as we still want to update the contribution status
			}
		}
		await this.db
			.prepare(
				`
      UPDATE contributions
      SET status = ?, rejection_reason = ?, decision_date = ?, package_name = ?
      WHERE id = ?
    `,
			)
			.bind(status, decision.approved ? null : decision.rejectionReason || 'No reason provided', now, packageName, id)
			.run();

		await this.statsService.incrementStat(decision.approved ? 'contributions_approved' : 'contributions_rejected');

		return {
			...contribution,
			packageName,
			status,
			rejectionReason: decision.approved ? null : decision.rejectionReason || 'No reason provided',
			decisionDate: now,
		};
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
		const totalResult = await this.db.prepare('SELECT COUNT(*) as count FROM contributions').first<{ count: number }>();

		const pendingResult = await this.db
			.prepare('SELECT COUNT(*) as count FROM contributions WHERE status = ?')
			.bind('pending')
			.first<{ count: number }>();

		const approvedResult = await this.db
			.prepare('SELECT COUNT(*) as count FROM contributions WHERE status = ?')
			.bind('approved')
			.first<{ count: number }>();

		const rejectedResult = await this.db
			.prepare('SELECT COUNT(*) as count FROM contributions WHERE status = ?')
			.bind('rejected')
			.first<{ count: number }>();

		const lastWeekResult = await this.db
			.prepare('SELECT COUNT(*) as count FROM contributions WHERE submission_date > ?')
			.bind(oneWeekAgoStr)
			.first<{ count: number }>();

		return {
			total: totalResult?.count || 0,
			pending: pendingResult?.count || 0,
			approved: approvedResult?.count || 0,
			rejected: rejectedResult?.count || 0,
			lastWeek: lastWeekResult?.count || 0,
		};
	}
	async deleteContribution(id: string, userId: string): Promise<boolean> {
		const userInfo = await this.db.prepare('SELECT id FROM users WHERE vatsim_id = ?').bind(userId).first<{ id: number }>();

		if (!userInfo) {
			throw new Error('User not found');
		}

		const hasPermission = await this.roleService.hasPermission(userInfo.id, StaffRole.LEAD_DEVELOPER);

		if (!hasPermission) {
			throw new Error('Not authorized to delete contributions');
		}
		const result = await this.db.prepare('DELETE FROM contributions WHERE id = ?').bind(id).run();

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

		// Get summary counts
		const summaryResult = await this.db
			.prepare(
				`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
      FROM contributions
      WHERE user_id = ?
    `,
			)
			.bind(userId)
			.first<{
				total: number;
				approved: number;
				pending: number;
				rejected: number;
			}>();

		const summary = {
			total: summaryResult?.total || 0,
			approved: summaryResult?.approved || 0,
			pending: summaryResult?.pending || 0,
			rejected: summaryResult?.rejected || 0,
		};

		// Calculate pagination
		const totalPages = Math.ceil(summary.total / limit);
		const offset = (page - 1) * limit;

		// Build the query based on status filter
		const whereConditions = ['user_id = ?'];
		const params = [userId];

		if (status !== 'all') {
			whereConditions.push('status = ?');
			params.push(status);
		}

		const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

		// Get the detailed contributions list
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

		const contributions = await this.db
			.prepare(query)
			.bind(...params, limit, offset)
			.all<Contribution>();

		return {
			contributions: contributions.results,
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

		const results = await this.db.prepare(query).all<{
			packageName: string;
			count: number;
		}>();

		return results.results;
	}
	async getContributionLeaderboard(): Promise<
		Array<{
			name: string;
			count: number;
		}>
	> {
		const query = `
      SELECT 
        user_id, 
        user_display_name,
        COUNT(*) as contribution_count
      FROM contributions
      WHERE status = 'approved'
      GROUP BY user_id
      ORDER BY contribution_count DESC
      LIMIT 5
    `;

		const results = await this.db.prepare(query).all<{
			user_id: string;
			user_display_name: string | null;
			contribution_count: number;
		}>();
		return results.results.map((item) => ({
			name: item.user_display_name || item.user_id,
			count: item.contribution_count,
		}));
	}

	private async updateUserDisplayNameForAllContributions(userId: string, displayName: string | null): Promise<void> {
		await this.db
			.prepare(
				`
      UPDATE contributions
      SET user_display_name = ?
      WHERE user_id = ?
    `,
			)
			.bind(displayName, userId)
			.run();
	}
	async getUserDisplayName(userId: string): Promise<string | null> {
		const result = await this.db
			.prepare(
				`
      SELECT user_display_name as userDisplayName
      FROM contributions
      WHERE user_id = ?
      ORDER BY submission_date DESC
      LIMIT 1
    `,
			)
			.bind(userId)
			.first<{ userDisplayName: string | null }>();

		return result?.userDisplayName || null;
	}
}
