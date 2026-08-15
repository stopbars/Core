import { RoleService } from './roles';
import { AirportService } from './airport';
import { StorageService } from './storage';
import { SupportService } from './support';
import { PolygonService } from './polygons';
import { PostHogService } from './posthog';
import { sanitizeContributionXml } from './xml-sanitizer';
import { DivisionService } from './divisions';
import { DatabaseContextFactory } from './database-context';
import { generateXPlaneRemovalsJson } from './xplane-removals';

export type Simulator = 'msfs2020' | 'msfs2024' | 'xplane';

export const VALID_SIMULATORS: readonly Simulator[] = ['msfs2020', 'msfs2024', 'xplane'] as const;

export interface Contribution {
	id: string;
	userId: string;
	userDisplayName: string | null;
	airportIcao: string;
	packageName: string;
	submittedXml: string;
	notes: string | null;
	simulator: Simulator;
	submissionDate: string;
	status: 'pending' | 'approved' | 'rejected' | 'outdated';
	rejectionReason: string | null;
	decisionDate: string | null;
	generationToken: string | null;
	generationHash: string | null;
	artifactIdentity: string | null;
	artifactGenerationId: string | null;
	removalArtifactKey: string | null;
	barsArtifactKey: string | null;
}

export interface ContributionSubmission {
	userId: string;
	airportIcao: string;
	packageName: string;
	submittedXml: string;
	notes?: string;
	simulator: Simulator;
	generationToken: string;
	generationHash: string;
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

export interface LatestApprovedMapDescriptor {
	packageName: string;
	simulator: Simulator;
	artifactIdentity: string | null;
	artifactGenerationId: string | null;
	removalArtifactKey: string | null;
	barsArtifactKey: string | null;
}

export interface ContributionPublication {
	artifactIdentity: string;
	generationId: string;
	removal: { key: string; etag: string; contentType: string };
	bars: { key: string; etag: string; contentType: 'application/xml' };
}

export type ContributionDecisionResult = Contribution & { publication?: ContributionPublication };

import { DatabaseSessionService } from './database-session';

export const MAX_CONTRIBUTION_NOTES_CHARS = 1000;
export const MAX_CONTRIBUTION_PACKAGE_CHARS = 64;
const ICAO_REGEX = /^[A-Z0-9]{4}$/;
/** URL-safe base64 (no padding) of a SHA-256 digest. */
export const CONTRIBUTION_GENERATION_TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;
const CONTRIBUTION_GENERATION_CONTRACT_VERSION = 'bars-contribution-generation/v2';

function sha256ToBase64Url(hashBuf: ArrayBuffer): string {
	const bytes = new Uint8Array(hashBuf);
	let binary = '';
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64Url(value: string): Promise<string> {
	const enc = new TextEncoder();
	const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(value));
	return sha256ToBase64Url(hashBuf);
}

export function normalizeContributionXml(xml: string): string {
	return xml
		.trim()
		.replace(/\r/g, '')
		.replace(/[\t ]+/g, ' ')
		.replace(/>\s+</g, '><');
}

export async function deriveContributionGenerationHash(sanitizedXml: string): Promise<string> {
	return sha256Base64Url(normalizeContributionXml(sanitizedXml));
}

export async function deriveContributionGenerationToken(sanitizedXml: string, icaoUpper: string, simulator: Simulator): Promise<string> {
	const icao = icaoUpper.trim().toUpperCase();
	const normalizedXml = normalizeContributionXml(sanitizedXml);
	return sha256Base64Url(`${CONTRIBUTION_GENERATION_CONTRACT_VERSION}|${simulator}|${icao}|${normalizedXml}`);
}

/** @deprecated Use deriveContributionGenerationToken with an explicit simulator. */
export async function deriveContributionGenerationTokenFromMsfsXml(sanitizedXml: string, icaoUpper: string): Promise<string> {
	return deriveContributionGenerationToken(sanitizedXml, icaoUpper, 'msfs2024');
}

export async function deriveArtifactIdentity(packageName: string): Promise<string> {
	const canonical = packageName.trim().normalize('NFKC').toLocaleLowerCase('en-US');
	const slug =
		canonical
			.replace(/[^a-z0-9.-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'package';
	const digest = await sha256Base64Url(canonical);
	return `${slug}--${digest.slice(0, 16)}`;
}

interface StoredContributionGenerationRow {
	icao: string;
	simulator?: Simulator;
	generation_hash?: string;
	supports_key?: string;
	bars_key?: string;
	supports_xml?: string;
	bars_xml?: string;
	expires_at: string;
}

export type ContributionGenerationLookupResult =
	| {
			status: 'ok';
			token: string;
			icao: string;
			simulator?: Simulator;
			generationHash?: string;
			supportsXml: string;
			barsXml: string;
			expiresAt: string;
	  }
	| { status: 'invalid-token' }
	| { status: 'not-found' }
	| { status: 'payload-not-found' };

export class ContributionService {
	private airportService: AirportService;
	private supportService: SupportService;
	private polygonService: PolygonService;
	private storageService: StorageService;
	private divisionService: DivisionService;
	private dbSession: DatabaseSessionService;

	constructor(
		private db: D1Database,
		_roleService: RoleService,
		apiKey: string,
		private storage: R2Bucket,
		private posthog?: PostHogService,
	) {
		this.airportService = new AirportService(db, apiKey);
		this.supportService = new SupportService(db);
		this.polygonService = new PolygonService(db, undefined, posthog);
		this.storageService = new StorageService(this.storage);
		this.divisionService = new DivisionService(db, posthog);
		this.dbSession = new DatabaseSessionService(db);
	}

	private async getContributionActionContext(
		vatsimId: string,
		contributionId: string,
	): Promise<{ isProductManager: boolean; contribution: Contribution | null } | null> {
		const result = await this.dbSession.executeLatest<Contribution & { actorIsProductManager: number }>(
			`SELECT
				c.id, c.user_id AS userId, submitter.display_name AS userDisplayName,
				c.airport_icao AS airportIcao, c.package_name AS packageName,
				c.submitted_xml AS submittedXml, c.notes, c.simulator,
				c.submission_date AS submissionDate, c.status,
				c.rejection_reason AS rejectionReason, c.decision_date AS decisionDate,
				c.generation_token AS generationToken, c.generation_hash AS generationHash,
				c.artifact_identity AS artifactIdentity, c.artifact_generation_id AS artifactGenerationId,
				c.removal_artifact_key AS removalArtifactKey, c.bars_artifact_key AS barsArtifactKey,
				CASE WHEN staff.role IN ('LEAD_DEVELOPER', 'PRODUCT_MANAGER') THEN 1 ELSE 0 END AS actorIsProductManager
			 FROM users actor
			 LEFT JOIN staff ON staff.user_id = actor.id
			 LEFT JOIN contributions c ON c.id = ?
			 LEFT JOIN users submitter ON submitter.vatsim_id = c.user_id
			 WHERE actor.vatsim_id = ?
			 LIMIT 1`,
			[contributionId, vatsimId],
		);
		const row = result.results[0];
		if (!row) return null;
		const { actorIsProductManager, ...contribution } = row;
		return {
			isProductManager: actorIsProductManager === 1,
			contribution: contribution.id ? contribution : null,
		};
	}

	private async getContributionDeleteContext(
		vatsimId: string,
		contributionId: string,
	): Promise<{
		isProductManager: boolean;
		contribution: Pick<Contribution, 'id' | 'userId' | 'status' | 'simulator'> | null;
	} | null> {
		const result = await this.dbSession.executeLatest<
			Pick<Contribution, 'id' | 'userId' | 'status' | 'simulator'> & { actorIsProductManager: number }
		>(
			`SELECT
				c.id, c.user_id AS userId, c.status, c.simulator,
				CASE WHEN staff.role IN ('LEAD_DEVELOPER', 'PRODUCT_MANAGER') THEN 1 ELSE 0 END AS actorIsProductManager
			 FROM users actor
			 LEFT JOIN staff ON staff.user_id = actor.id
			 LEFT JOIN contributions c ON c.id = ?
			 WHERE actor.vatsim_id = ?
			 LIMIT 1`,
			[contributionId, vatsimId],
		);
		const row = result.results[0];
		if (!row) return null;
		const { actorIsProductManager, ...contribution } = row;
		return {
			isProductManager: actorIsProductManager === 1,
			contribution: contribution.id ? contribution : null,
		};
	}

	private async insertContributionGenerationRow(
		session: ReturnType<typeof DatabaseContextFactory.createSessionService>,
		token: string,
		icao: string,
		supportsKey: string,
		barsKey: string,
		simulator: Simulator,
		generationHash: string,
	): Promise<void> {
		try {
			await session.executeWrite(
				`
			INSERT INTO contribution_generations (token, icao, supports_key, bars_key, simulator, generation_hash, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+1 day'))
		`,
				[token, icao.toUpperCase(), supportsKey, barsKey, simulator, generationHash],
			);
		} catch (error) {
			const message = error instanceof Error ? error.message.toLowerCase() : '';
			if (!message.includes('no such column')) {
				throw error;
			}
			try {
				await session.executeWrite(
					`INSERT INTO contribution_generations (token, icao, supports_key, bars_key, expires_at)
					 VALUES (?, ?, ?, ?, datetime('now', '+1 day'))`,
					[token, icao.toUpperCase(), supportsKey, barsKey],
				);
			} catch (legacyError) {
				const legacyMessage = legacyError instanceof Error ? legacyError.message.toLowerCase() : '';
				if (!legacyMessage.includes('no such column')) throw legacyError;
				// Compatibility for the initial production table, which used XML column names.
				await session.executeWrite(
					`INSERT INTO contribution_generations (token, icao, supports_xml, bars_xml, expires_at)
					 VALUES (?, ?, ?, ?, datetime('now', '+1 day'))`,
					[token, icao.toUpperCase(), supportsKey, barsKey],
				);
			}
		}
	}

	private async readContributionGenerationXml(keyOrXml: string | undefined): Promise<string | null> {
		if (!keyOrXml) {
			return null;
		}
		if (!keyOrXml.startsWith('contribution-generations/')) {
			return keyOrXml;
		}

		const object = await this.storage.get(keyOrXml);
		return object ? object.text() : null;
	}

	async cleanupExpiredGenerations(): Promise<void> {
		const session = DatabaseContextFactory.createSessionService(this.db);
		try {
			let expiredKeys: string[] = [];
			try {
				const [expired] = await session.executeBatch<Pick<StoredContributionGenerationRow, 'supports_key' | 'bars_key'>>([
					{ query: "SELECT supports_key, bars_key FROM contribution_generations WHERE expires_at <= datetime('now')" },
					{ query: "DELETE FROM contribution_generations WHERE expires_at <= datetime('now')" },
				]);
				expiredKeys = (expired.results ?? []).flatMap(
					(row) => [row.supports_key, row.bars_key].filter((key): key is string => Boolean(key)),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message.toLowerCase() : '';
				if (!message.includes('no such column')) {
					throw error;
				}

				const [expired] = await session.executeBatch<Pick<StoredContributionGenerationRow, 'supports_xml' | 'bars_xml'>>([
					{ query: "SELECT supports_xml, bars_xml FROM contribution_generations WHERE expires_at <= datetime('now')" },
					{ query: "DELETE FROM contribution_generations WHERE expires_at <= datetime('now')" },
				]);
				expiredKeys = (expired.results ?? []).flatMap(
					(row) => [row.supports_xml, row.bars_xml].filter((key): key is string => Boolean(key)),
				);
			}
			await Promise.all(
				expiredKeys.filter((key) => key.startsWith('contribution-generations/')).map((key) => this.storage.delete(key)),
			);
		} catch (error) {
			try {
				console.warn('[Cron] Failed to clean up contribution_generations:', error instanceof Error ? error.message : error);
			} catch {
				/* ignore logging issues */
			}
		} finally {
			session.closeSession();
		}
	}

	async storeGeneration(
		icao: string,
		removalArtifact: string,
		barsXml: string,
		contentToken: string,
		simulator: Simulator,
		generationHash: string,
	): Promise<string> {
		const token = contentToken;
		const icaoUpper = icao.trim().toUpperCase();

		const session = DatabaseContextFactory.createSessionService(this.db);
		try {
			const [, existing] = await session.executeBatch<{ one: number }>([
				{
					query: "DELETE FROM contribution_generations WHERE token = ? AND expires_at <= datetime('now')",
					params: [token],
				},
				{
					query: `SELECT 1 AS one FROM contribution_generations
						WHERE token = ? AND expires_at > datetime('now')
						LIMIT 1`,
					params: [token],
				},
			]);
			if (existing.results?.[0]) {
				return token;
			}

			const isXPlane = simulator === 'xplane';
			const supportsKey = `contribution-generations/${token}/${isXPlane ? 'removals.json' : 'supports.xml'}`;
			const barsKey = `contribution-generations/${token}/bars.xml`;

			await Promise.all([
				this.storage.put(supportsKey, removalArtifact, {
					httpMetadata: { contentType: isXPlane ? 'application/json' : 'application/xml' },
				}),
				this.storage.put(barsKey, barsXml, {
					httpMetadata: { contentType: 'application/xml' },
				}),
			]);

			try {
				await this.insertContributionGenerationRow(session, token, icaoUpper, supportsKey, barsKey, simulator, generationHash);
			} catch (error) {
				const message = error instanceof Error ? error.message.toLowerCase() : '';
				if (!message.includes('unique') && !message.includes('constraint')) {
					await Promise.all([this.storage.delete(supportsKey), this.storage.delete(barsKey)]).catch(() => undefined);
					throw error;
				}
			}
			return token;
		} finally {
			session.closeSession();
		}
	}

	async getStoredGeneration(tokenParam: string | undefined): Promise<ContributionGenerationLookupResult> {
		const token = tokenParam?.trim() || '';
		if (!CONTRIBUTION_GENERATION_TOKEN_REGEX.test(token)) {
			return { status: 'invalid-token' };
		}

		const session = DatabaseContextFactory.createSessionService(this.db);
		try {
			let result;
			try {
				result = await session.executeLatest<StoredContributionGenerationRow>(
					`
				SELECT icao, supports_key, bars_key, simulator, generation_hash, expires_at
				FROM contribution_generations
				WHERE token = ? AND expires_at > datetime('now')
				LIMIT 1
			`,
					[token],
				);
			} catch (error) {
				const message = error instanceof Error ? error.message.toLowerCase() : '';
				if (!message.includes('no such column')) {
					throw error;
				}

				try {
					result = await session.executeLatest<StoredContributionGenerationRow>(
						`SELECT icao, supports_key, bars_key, expires_at
						 FROM contribution_generations
						 WHERE token = ? AND expires_at > datetime('now') LIMIT 1`,
						[token],
					);
				} catch (legacyError) {
					const legacyMessage = legacyError instanceof Error ? legacyError.message.toLowerCase() : '';
					if (!legacyMessage.includes('no such column')) throw legacyError;
					result = await session.executeLatest<StoredContributionGenerationRow>(
						`SELECT icao, supports_xml, bars_xml, expires_at
						 FROM contribution_generations
						 WHERE token = ? AND expires_at > datetime('now') LIMIT 1`,
						[token],
					);
				}
			}
			const generation = result.results[0];
			if (!generation) {
				return { status: 'not-found' };
			}

			const [supportsXml, barsXml] = await Promise.all([
				this.readContributionGenerationXml(generation.supports_key ?? generation.supports_xml),
				this.readContributionGenerationXml(generation.bars_key ?? generation.bars_xml),
			]);
			if (!supportsXml || !barsXml) {
				return { status: 'payload-not-found' };
			}

			return {
				status: 'ok',
				token,
				icao: generation.icao,
				simulator: generation.simulator,
				generationHash: generation.generation_hash,
				supportsXml,
				barsXml,
				expiresAt: generation.expires_at,
			};
		} finally {
			session.closeSession();
		}
	}

	private normalizeAirportIcao(raw: string): string {
		if (String(raw) !== raw) {
			throw new Error('airportIcao must be a string');
		}
		const normalized = raw.trim().toUpperCase();
		if (!ICAO_REGEX.test(normalized)) {
			throw new Error('airportIcao must be a valid 4-character ICAO code');
		}
		return normalized;
	}

	private sanitizePackageName(raw: string, fieldLabel = 'packageName'): string {
		if (String(raw) !== raw) {
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

		// Validate simulator
		if (!submission.simulator || !VALID_SIMULATORS.includes(submission.simulator)) {
			throw new Error(`simulator must be one of: ${VALID_SIMULATORS.join(', ')}`);
		}

		const airport = await this.airportService.getAirport(normalizedAirportIcao);
		if (!airport) {
			throw new Error(`Airport with ICAO ${normalizedAirportIcao} not found`);
		}
		const contributionPolicy = await this.divisionService.getContributionPolicyForAirport(normalizedAirportIcao);
		if (contributionPolicy && !contributionPolicy.contributions_enabled) {
			const divisionName = contributionPolicy.division_name || 'the owning division';
			throw new Error(`Contributions for ${normalizedAirportIcao} are currently disabled by ${divisionName}`);
		}

		let sanitizedNotes: string | null = null;
		if (submission.notes !== undefined && submission.notes !== null) {
			if (String(submission.notes) !== submission.notes) {
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
		const embeddedXPlane = /<FSData\b[^>]*\bsimulator\s*=\s*["']xplane["']/i.test(trimmedXml);
		if ((submission.simulator === 'xplane') !== embeddedXPlane) {
			throw new Error('Draft simulator metadata does not match the selected simulator');
		}
		if (submission.simulator === 'xplane') {
			generateXPlaneRemovalsJson(trimmedXml, normalizedAirportIcao);
		}

		const normalizedXml = normalizeContributionXml(trimmedXml);
		if (!CONTRIBUTION_GENERATION_TOKEN_REGEX.test(submission.generationToken || '')) {
			throw new Error('generationToken must be a valid tested-generation token');
		}
		if (!CONTRIBUTION_GENERATION_TOKEN_REGEX.test(submission.generationHash || '')) {
			throw new Error('generationHash must be a valid tested-draft hash');
		}
		const [expectedToken, expectedHash] = await Promise.all([
			deriveContributionGenerationToken(trimmedXml, normalizedAirportIcao, submission.simulator),
			deriveContributionGenerationHash(trimmedXml),
		]);
		if (submission.generationToken !== expectedToken || submission.generationHash !== expectedHash) {
			throw new Error('Submitted draft does not match the tested generation');
		}
		const storedGeneration = await this.getStoredGeneration(expectedToken);
		if (
			storedGeneration.status !== 'ok' ||
			storedGeneration.icao !== normalizedAirportIcao ||
			(storedGeneration.simulator !== undefined && storedGeneration.simulator !== submission.simulator) ||
			(storedGeneration.generationHash !== undefined && storedGeneration.generationHash !== expectedHash)
		) {
			throw new Error('Tested generation was not found or has expired; test this exact draft again');
		}

		// Prevent duplicate or stolen submissions (same package + simulator):
		const existingForPackage = await this.dbSession.executeRead<{
			submitted_xml: string;
		}>(
			`SELECT submitted_xml
			 FROM contributions
			 WHERE package_name = ? COLLATE NOCASE
			   AND simulator = ?
			   AND status IN ('pending','approved')`,
			[sanitizedPackageName, submission.simulator],
		);
		for (const row of existingForPackage.results) {
			if (normalizeContributionXml(row.submitted_xml) === normalizedXml) {
				throw new Error(
					'Duplicate submission detected: XML matches an existing contribution for the same package and simulator. Please submit original work.',
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
		simulator, submission_date, status, generation_token, generation_hash
	  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
			[
				id,
				submission.userId,
				normalizedAirportIcao,
				sanitizedPackageName,
				trimmedXml,
				sanitizedNotes,
				submission.simulator,
				now,
				'pending',
				expectedToken,
				expectedHash,
			],
		);

		const contribution: Contribution = {
			id,
			userId: submission.userId,
			userDisplayName: null, // resolved dynamically on retrieval
			airportIcao: normalizedAirportIcao,
			packageName: sanitizedPackageName,
			submittedXml: trimmedXml,
			notes: sanitizedNotes,
			simulator: submission.simulator,
			submissionDate: now,
			status: 'pending',
			rejectionReason: null,
			decisionDate: null,
			generationToken: expectedToken,
			generationHash: expectedHash,
			artifactIdentity: null,
			artifactGenerationId: null,
			removalArtifactKey: null,
			barsArtifactKey: null,
		};
		try {
			this.posthog?.track('Contribution Submitted', {
				airport: normalizedAirportIcao,
				packageName: sanitizedPackageName,
				simulator: submission.simulator,
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
		c.submitted_xml as submittedXml, c.notes, c.simulator,
		c.submission_date as submissionDate, c.status,
		c.rejection_reason as rejectionReason, c.decision_date as decisionDate,
		c.generation_token as generationToken, c.generation_hash as generationHash,
		c.artifact_identity as artifactIdentity, c.artifact_generation_id as artifactGenerationId,
		c.removal_artifact_key as removalArtifactKey, c.bars_artifact_key as barsArtifactKey
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
	 * @param simulator Optional simulator filter - if not provided, returns latest across all simulators
	 */
	async getLatestApprovedMapDescriptor(
		airportIcao: string,
		packageName: string,
		simulator?: Simulator,
	): Promise<LatestApprovedMapDescriptor | null> {
		const params: string[] = [airportIcao, packageName];
		let simulatorClause = '';
		if (simulator) {
			simulatorClause = ' AND c.simulator = ?';
			params.push(simulator);
		}
		const result = await this.dbSession.executeRead<LatestApprovedMapDescriptor>(
			`
			SELECT c.package_name AS packageName, c.simulator,
				c.artifact_identity AS artifactIdentity, c.artifact_generation_id AS artifactGenerationId,
				c.removal_artifact_key AS removalArtifactKey, c.bars_artifact_key AS barsArtifactKey
			FROM contributions c
			WHERE c.airport_icao = ? AND lower(c.package_name) = lower(?) AND c.status = 'approved'${simulatorClause}
			ORDER BY c.decision_date DESC
			LIMIT 1
			`,
			params,
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
		c.submitted_xml as submittedXml, c.notes, c.simulator,
		c.submission_date as submissionDate, c.status,
		c.rejection_reason as rejectionReason, c.decision_date as decisionDate,
		c.generation_token as generationToken, c.generation_hash as generationHash,
		c.artifact_identity as artifactIdentity, c.artifact_generation_id as artifactGenerationId,
		c.removal_artifact_key as removalArtifactKey, c.bars_artifact_key as barsArtifactKey
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

	async listContributionMetadata(options: ContributionListOptions): Promise<{
		contributions: Array<Omit<Contribution, 'submittedXml' | 'generationToken' | 'generationHash'>>;
		total: number;
	}> {
		const { status = 'all', airportIcao, userId } = options;
		const whereConditions: string[] = [];
		const params: string[] = [];
		if (status !== 'all') {
			whereConditions.push('c.status = ?');
			params.push(status);
		}
		if (airportIcao) {
			whereConditions.push('c.airport_icao = ?');
			params.push(airportIcao);
		}
		if (userId) {
			whereConditions.push('c.user_id = ?');
			params.push(userId);
		}
		const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
		const result = await this.dbSession.executeRead<Omit<Contribution, 'submittedXml' | 'generationToken' | 'generationHash'>>(
			`SELECT
				c.id, c.user_id AS userId, u.display_name AS userDisplayName,
				c.airport_icao AS airportIcao, c.package_name AS packageName, c.notes, c.simulator,
				c.submission_date AS submissionDate, c.status,
				c.rejection_reason AS rejectionReason, c.decision_date AS decisionDate,
				c.artifact_identity AS artifactIdentity, c.artifact_generation_id AS artifactGenerationId,
				c.removal_artifact_key AS removalArtifactKey, c.bars_artifact_key AS barsArtifactKey
			 FROM contributions c
			 LEFT JOIN users u ON u.vatsim_id = c.user_id
			 ${whereClause}
			 ORDER BY c.submission_date DESC`,
			params,
		);
		return { contributions: result.results, total: result.results.length };
	}

	async listContributionsSimple(options: ContributionListOptions): Promise<{
		contributions: Array<{
			id: string;
			airportIcao: string;
			packageName: string;
			simulator: Simulator;
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
			c.package_name as packageName,
			c.simulator
		FROM contributions c
		${whereClause}
		ORDER BY c.submission_date DESC
		`;

		const contributionsResult = await this.dbSession.executeRead<{
			id: string;
			airportIcao: string;
			packageName: string;
			simulator: Simulator;
		}>(query, params);

		return {
			contributions: contributionsResult.results,
			total: contributionsResult.results.length,
		};
	}

	private async generateAndPublishArtifacts(
		contribution: Contribution,
		packageName: string,
		operation: 'approval' | 'regeneration',
	): Promise<ContributionPublication> {
		const [removalArtifact, barsXml] = await Promise.all([
			contribution.simulator === 'xplane'
				? Promise.resolve(generateXPlaneRemovalsJson(contribution.submittedXml, contribution.airportIcao))
				: this.supportService.generateLightSupportsXML(contribution.submittedXml, contribution.airportIcao),
			this.polygonService.processBarsXML(contribution.submittedXml, contribution.airportIcao),
		]);

		const [artifactIdentity, removalHash, barsHash] = await Promise.all([
			deriveArtifactIdentity(packageName),
			sha256Base64Url(removalArtifact),
			sha256Base64Url(barsXml),
		]);
		const generationId = crypto.randomUUID();
		const prefix = `ContributionArtifacts/${contribution.airportIcao}/${artifactIdentity}/${contribution.simulator}/${generationId}`;
		const removalContentType = contribution.simulator === 'xplane' ? 'application/json' : 'application/xml';
		const removalKey = `${prefix}/${contribution.simulator === 'xplane' ? 'removals.json' : 'supports.xml'}`;
		const barsKey = `${prefix}/bars.xml`;
		const commonMetadata = {
			airportIcao: contribution.airportIcao,
			packageName,
			simulator: contribution.simulator,
			artifactIdentity,
			artifactGenerationId: generationId,
			contributionId: contribution.id,
			operation,
		};

		try {
			const [removal, bars] = await Promise.all([
				this.storageService.uploadFile(removalKey, removalArtifact, removalContentType, {
					...commonMetadata,
					type: 'removal',
					contentHash: removalHash,
				}),
				this.storageService.uploadFile(barsKey, barsXml, 'application/xml', {
					...commonMetadata,
					type: 'bars',
					contentHash: barsHash,
				}),
			]);
			return {
				artifactIdentity,
				generationId,
				removal: { ...removal, contentType: removalContentType },
				bars: { ...bars, contentType: 'application/xml' },
			};
		} catch (error) {
			await Promise.allSettled([this.storageService.deleteFile(removalKey), this.storageService.deleteFile(barsKey)]);
			throw error;
		}
	}

	private async discardPublication(publication: ContributionPublication): Promise<void> {
		await Promise.allSettled([
			this.storageService.deleteFile(publication.removal.key),
			this.storageService.deleteFile(publication.bars.key),
		]);
	}

	private async isPublicationCurrent(id: string, publication: ContributionPublication): Promise<boolean | null> {
		try {
			const current = await this.dbSession.executeLatest<{
				status: Contribution['status'];
				artifactGenerationId: string | null;
				removalArtifactKey: string | null;
				barsArtifactKey: string | null;
			}>(
				`SELECT status, artifact_generation_id AS artifactGenerationId,
					removal_artifact_key AS removalArtifactKey, bars_artifact_key AS barsArtifactKey
				 FROM contributions WHERE id = ? LIMIT 1`,
				[id],
			);
			const row = current.results[0];
			return Boolean(
				row?.status === 'approved' &&
				row.artifactGenerationId === publication.generationId &&
				row.removalArtifactKey === publication.removal.key &&
				row.barsArtifactKey === publication.bars.key,
			);
		} catch {
			// An indeterminate D1 result must never trigger deletion of artifacts
			// that may already be the committed pair.
			return null;
		}
	}

	async processDecision(id: string, userId: string, decision: ContributionDecision): Promise<ContributionDecisionResult> {
		const context = await this.getContributionActionContext(userId, id);

		if (!context) {
			throw new Error('User not found');
		}

		if (!context.isProductManager) {
			throw new Error('Not authorized to make decisions on contributions');
		}

		// Get the contribution to make sure it exists and is pending
		const contribution = context.contribution;

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
		const status = decision.approved ? 'approved' : 'rejected';
		const rejectionReason = decision.approved ? null : decision.rejectionReason || 'No reason provided';
		const updateCurrent = {
			query: `UPDATE contributions
				SET status = ?, rejection_reason = ?, decision_date = ?, package_name = ?
				WHERE id = ?`,
			params: [status, rejectionReason, now, packageName, id],
		};

		let publication: ContributionPublication | undefined;
		// Generate and publish a complete immutable pair before the D1 pointer moves.
		if (decision.approved) {
			publication = await this.generateAndPublishArtifacts(contribution, packageName, 'approval');
			try {
				const [, approvedWrite] = await this.dbSession.executeBatch([
					{
						query: `UPDATE contributions
							SET status = 'outdated', decision_date = ?
							WHERE airport_icao = ?
								AND package_name = ? COLLATE NOCASE
								AND simulator = ?
								AND status = 'approved'
								AND id != ?
								AND EXISTS (SELECT 1 FROM contributions target WHERE target.id = ? AND target.status = 'pending')`,
						params: [now, contribution.airportIcao, packageName, contribution.simulator, id, id],
					},
					{
						query: `UPDATE contributions
							SET status = 'approved', rejection_reason = NULL, decision_date = ?, package_name = ?,
								artifact_identity = ?, artifact_generation_id = ?, removal_artifact_key = ?, bars_artifact_key = ?
							WHERE id = ? AND status = 'pending'`,
						params: [
							now,
							packageName,
							publication.artifactIdentity,
							publication.generationId,
							publication.removal.key,
							publication.bars.key,
							id,
						],
					},
				]);
				if (approvedWrite?.meta?.changes === 0) {
					throw new Error('Contribution approval lost a concurrent decision race');
				}
			} catch (error) {
				const publicationIsCurrent = await this.isPublicationCurrent(id, publication);
				if (publicationIsCurrent !== true) {
					if (publicationIsCurrent === false) await this.discardPublication(publication);
					throw error;
				}
			}
		} else {
			await this.dbSession.executeWrite(updateCurrent.query, updateCurrent.params);
		}

		const updated: Contribution = {
			...contribution,
			packageName,
			status,
			rejectionReason,
			decisionDate: now,
			artifactIdentity: publication?.artifactIdentity ?? contribution.artifactIdentity,
			artifactGenerationId: publication?.generationId ?? contribution.artifactGenerationId,
			removalArtifactKey: publication?.removal.key ?? contribution.removalArtifactKey,
			barsArtifactKey: publication?.bars.key ?? contribution.barsArtifactKey,
		};
		try {
			this.posthog?.track(decision.approved ? 'Contribution Approved' : 'Contribution Rejected', {
				id,
				airport: contribution.airportIcao,
				packageName,
				simulator: contribution.simulator,
				decidedBy: userId,
				rejectionReason: decision.approved ? undefined : decision.rejectionReason || 'No reason provided',
			});
		} catch (e) {
			console.warn('Posthog track failed (Contribution Decision)', e);
		}
		return publication ? { ...updated, publication } : updated;
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
		const context = await this.getContributionDeleteContext(userId, id);
		if (!context) {
			throw new Error('User not found');
		}
		// Fetch contribution to validate existence/ownership
		const existing = context.contribution;
		if (!existing) {
			return false; // not found
		}
		const isStaff = context.isProductManager;
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
					simulator: existing.simulator,
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
		airportIcao: string;
		packageName: string;
		maps: { key: string; etag: string };
		supports: { key: string; etag: string };
	}> {
		// Resolve local user and permissions
		const context = await this.getContributionActionContext(requestedByVatsimId, id);
		if (!context) {
			throw new Error('User not found');
		}
		if (!context.isProductManager) {
			throw new Error('Not authorized to regenerate contributions');
		}

		// Load contribution
		const contribution = context.contribution;
		if (!contribution) {
			throw new Error('Contribution not found');
		}

		// Only approved entries can be regenerated to avoid conflicts
		if (contribution.status !== 'approved') {
			throw new Error('Only approved contributions can be regenerated');
		}

		try {
			const publication = await this.generateAndPublishArtifacts(contribution, contribution.packageName, 'regeneration');
			try {
				const switched = await this.dbSession.executeWrite(
					`UPDATE contributions
					 SET artifact_identity = ?, artifact_generation_id = ?, removal_artifact_key = ?, bars_artifact_key = ?
					 WHERE id = ? AND status = 'approved'`,
					[publication.artifactIdentity, publication.generationId, publication.removal.key, publication.bars.key, id],
				);
				if (switched.meta?.changes === 0) {
					throw new Error('Contribution is no longer approved');
				}
			} catch (error) {
				const publicationIsCurrent = await this.isPublicationCurrent(id, publication);
				if (publicationIsCurrent !== true) {
					if (publicationIsCurrent === false) await this.discardPublication(publication);
					throw error;
				}
			}

			try {
				this.posthog?.track('Contribution Regenerated', {
					id,
					airport: contribution.airportIcao,
					packageName: contribution.packageName,
					simulator: contribution.simulator,
					requestedBy: requestedByVatsimId,
				});
			} catch (e) {
				console.warn('Posthog track failed (Contribution Regenerated)', e);
			}

			return {
				airportIcao: contribution.airportIcao,
				packageName: contribution.packageName,
				maps: { key: publication.bars.key, etag: publication.bars.etag },
				supports: { key: publication.removal.key, etag: publication.removal.etag },
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
