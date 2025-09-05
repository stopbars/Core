import { VatsimUser, UserRecord } from '../types';
import { VatsimService } from './vatsim';
import { DatabaseSessionService } from './database-session';
import { PostHogService } from './posthog';

export class AuthService {
	private dbSession: DatabaseSessionService;

	constructor(
		private db: D1Database,
		private vatsim: VatsimService,
		private posthog?: PostHogService,
	) {
		this.dbSession = new DatabaseSessionService(db);
	}

	async handleCallback(code: string): Promise<{ vatsimToken: string }> {
		const auth = await this.vatsim.getToken(code);
		const vatsimUser = await this.vatsim.getUser(auth.access_token);
		if (!vatsimUser.id || !vatsimUser.email) {
			throw new Error('Invalid VATSIM user data');
		}
		// If banned, don't create user but still return token so UI can fetch /auth/account and get banned message
		const banned = await this.isVatsimIdBanned(vatsimUser.id);
		if (!banned) {
			const { user, created } = await this.getOrCreateUser(vatsimUser);
			try {
				this.posthog?.track(created ? 'User Signed Up' : 'User Logged In', {
					vatsimId: vatsimUser.id,
					isNewUser: created,
					userId: user.id,
				});
			} catch {
				/* ignore analytics errors */
			}
		} else {
			try {
				this.posthog?.track('Banned Login Attempt', { vatsimId: vatsimUser.id });
			} catch {
				/* ignore */
			}
		}
		return { vatsimToken: auth.access_token };
	}

	private async getOrCreateUser(vatsimUser: VatsimUser): Promise<{ user: UserRecord; created: boolean }> {
		// Use primary mode for authentication checks to ensure latest data
		this.dbSession.startSession({ mode: 'first-primary' });

		const existingUserResult = await this.dbSession.executeRead<UserRecord>('SELECT * FROM users WHERE vatsim_id = ?', [vatsimUser.id]);
		const existingUser = existingUserResult.results[0];

		if (existingUser) {
			await this.updateUserLastLogin(existingUser.id);
			await this.syncUserLocationFields(existingUser.id, vatsimUser);
			const refreshed = await this.getUserByVatsimId(vatsimUser.id);
			return { user: refreshed || existingUser, created: false };
		}

		const newUser = await this.createNewUser(vatsimUser);
		return { user: newUser, created: true };
	}

	private generateApiKey(): string {
		const randomBytes = new Uint8Array(32);
		crypto.getRandomValues(randomBytes);
		const key = Array.from(randomBytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		return `BARS_${key}`;
	}

	private async createNewUser(vatsimUser: VatsimUser) {
		// Check for existing VATSIM user using session
		const existingVatsimUserResult = await this.dbSession.executeRead<UserRecord>('SELECT id FROM users WHERE vatsim_id = ?', [
			vatsimUser.id,
		]);

		if (existingVatsimUserResult.results[0]) {
			throw new Error('User with this VATSIM ID already exists');
		}

		let apiKey = this.generateApiKey();

		while (true) {
			const existingKeyResult = await this.dbSession.executeRead<UserRecord>('SELECT id FROM users WHERE api_key = ?', [apiKey]);

			if (!existingKeyResult.results[0]) break;
			apiKey = this.generateApiKey();
		}

		const fullName = [vatsimUser.first_name, vatsimUser.last_name].filter(Boolean).join(' ') || null;
		const displayMode = 0;
		const displayName = this.computeDisplayName(
			{
				id: 0,
				vatsim_id: vatsimUser.id,
				api_key: apiKey,
				email: vatsimUser.email,
				full_name: fullName,
				display_mode: displayMode,
				created_at: '',
				last_login: '',
				vatsimToken: '',
			},
			vatsimUser,
		);
		const norm = (s?: string) => (typeof s === 'string' && s.trim().length > 0 ? s.trim() : null);
		const result = await this.dbSession.executeWrite(
			'INSERT INTO users (vatsim_id, api_key, email, full_name, display_mode, display_name, region_id, region_name, division_id, division_name, subdivision_id, subdivision_name, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
			[
				vatsimUser.id,
				apiKey,
				vatsimUser.email,
				fullName,
				displayMode,
				displayName,
				norm(vatsimUser.region?.id),
				norm(vatsimUser.region?.name),
				norm(vatsimUser.division?.id),
				norm(vatsimUser.division?.name),
				norm(vatsimUser.subdivision?.id),
				norm(vatsimUser.subdivision?.name),
				new Date().toISOString(),
				new Date().toISOString(),
			],
		);

		const rows = result.results as unknown as UserRecord[] | null;
		const created = rows && rows[0];
		if (!created) throw new Error('Failed to create user');
		return created as UserRecord;
	}

	async syncUserLocationFields(userId: number, vatsimUser: VatsimUser) {
		// Normalize empty strings to null to avoid wiping existing values
		const norm = (s?: string) => (typeof s === 'string' && s.trim().length > 0 ? s.trim() : null);
		const regionId = norm(vatsimUser.region?.id);
		const regionName = norm(vatsimUser.region?.name);
		const divisionId = norm(vatsimUser.division?.id);
		const divisionName = norm(vatsimUser.division?.name);
		const subdivisionId = norm(vatsimUser.subdivision?.id);
		const subdivisionName = norm(vatsimUser.subdivision?.name);

		// Only update when new values are present; do not overwrite with nulls
		await this.dbSession.executeWrite(
			`UPDATE users
			 SET 
			   region_id = COALESCE(?, region_id),
			   region_name = COALESCE(?, region_name),
			   division_id = COALESCE(?, division_id),
			   division_name = COALESCE(?, division_name),
			   subdivision_id = COALESCE(?, subdivision_id),
			   subdivision_name = COALESCE(?, subdivision_name)
			 WHERE id = ?`,
			[regionId, regionName, divisionId, divisionName, subdivisionId, subdivisionName, userId],
		);
	}

	async deleteUserAccount(vatsimId: string): Promise<boolean> {
		// Use primary mode for write operations
		this.dbSession.startSession({ mode: 'first-primary' });

		await this.dbSession.executeBatch([
			{ query: 'DELETE FROM division_members WHERE vatsim_id = ?', params: [vatsimId] },
			{ query: 'DELETE FROM staff WHERE user_id IN (SELECT id FROM users WHERE vatsim_id = ?)', params: [vatsimId] },
			{ query: 'DELETE FROM users WHERE vatsim_id = ?', params: [vatsimId] },
		]);

		const userExists = await this.getUserByVatsimId(vatsimId);
		const deleted = !userExists;
		if (deleted) {
			try {
				this.posthog?.track('User Deleted', { vatsimId });
			} catch (e) {
				console.warn('Posthog track failed (User Deleted)', e);
			}
		}
		return deleted;
	}

	async getUserByApiKey(apiKey: string): Promise<UserRecord | null> {
		// Use unconstrained read for API key lookups (performance optimization)
		const result = await this.dbSession.executeRead<UserRecord>('SELECT * FROM users WHERE api_key = ?', [apiKey]);
		const user = result.results[0] || null;
		if (user) {
			const banned = await this.isVatsimIdBanned(user.vatsim_id);
			if (banned) return null;
		}
		return user;
	}

	async getUserByVatsimId(vatsimId: string): Promise<UserRecord | null> {
		// Use unconstrained read for VATSIM ID lookups
		const result = await this.dbSession.executeRead<UserRecord>('SELECT * FROM users WHERE vatsim_id = ?', [vatsimId]);
		const user = result.results[0] || null;
		if (user) {
			const banned = await this.isVatsimIdBanned(user.vatsim_id);
			if (banned) return null;
		}
		return user;
	}

	// Explicitly fetch user without applying ban filter (for account page visibility)
	async getUserByVatsimIdEvenIfBanned(vatsimId: string): Promise<UserRecord | null> {
		const result = await this.dbSession.executeRead<UserRecord>('SELECT * FROM users WHERE vatsim_id = ?', [vatsimId]);
		return result.results[0] || null;
	}

	computeDisplayName(user: UserRecord, vatsimUser?: VatsimUser): string {
		const mode = user.display_mode ?? 0;
		const fullName = user.full_name || [vatsimUser?.first_name, vatsimUser?.last_name].filter(Boolean).join(' ').trim();
		if (mode === 2) return user.vatsim_id;
		if (!fullName) return user.vatsim_id;
		const parts = fullName.split(/\s+/);
		if (mode === 0) return parts[0];
		if (mode === 1) {
			const first = parts[0];
			const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] : '';
			return lastInitial ? `${first} ${lastInitial}` : first;
		}
		return fullName; // fallback
	}

	async updateDisplayMode(userId: number, mode: number) {
		if (![0, 1, 2].includes(mode)) throw new Error('Invalid display mode');

		// Use primary for consistency on write
		this.dbSession.startSession({ mode: 'first-primary' });

		const current = await this.dbSession.executeRead<UserRecord>(
			'SELECT id, vatsim_id, email, full_name, display_mode, display_name FROM users WHERE id = ?',
			[userId],
		);
		const user = current.results[0];
		if (!user) return;

		if (user.display_mode === mode) return; // nothing to do

		const fullNameParts = (user.full_name || '').trim().split(/\s+/).filter(Boolean);
		const vatsimUser: VatsimUser = {
			id: user.vatsim_id,
			email: user.email,
			first_name: fullNameParts[0] || '',
			last_name: fullNameParts.slice(1).join(' '),
		};

		const displayName = this.computeDisplayName({ ...user, display_mode: mode } as UserRecord, vatsimUser);

		await this.dbSession.executeWrite('UPDATE users SET display_mode = ?, display_name = ? WHERE id = ?', [mode, displayName, userId]);
	}

	async updateFullName(userId: number, fullName: string) {
		await this.dbSession.executeWrite('UPDATE users SET full_name = ? WHERE id = ?', [fullName, userId]);
		// Recompute display_name after updating full_name using existing display_mode
		const current = await this.dbSession.executeRead<UserRecord>('SELECT * FROM users WHERE id = ?', [userId]);
		const user = current.results[0];
		if (user) {
			const vatsimUser: VatsimUser = {
				id: user.vatsim_id,
				email: user.email,
				first_name: fullName.split(' ')[0],
				last_name: fullName.split(' ').slice(1).join(' '),
			};
			const displayName = this.computeDisplayName(user, vatsimUser);
			await this.dbSession.executeWrite('UPDATE users SET display_name = ? WHERE id = ?', [displayName, userId]);
		}
	}

	private async updateUserLastLogin(userId: number) {
		await this.dbSession.executeWrite('UPDATE users SET last_login = ? WHERE id = ?', [new Date().toISOString(), userId]);
	}

	async regenerateApiKey(userId: number): Promise<string> {
		// Use primary mode for API key regeneration
		this.dbSession.startSession({ mode: 'first-primary' });

		let newApiKey = this.generateApiKey();

		// Make sure the new API key is unique
		while (true) {
			const existingKeyResult = await this.dbSession.executeRead<UserRecord>('SELECT id FROM users WHERE api_key = ?', [newApiKey]);

			if (!existingKeyResult.results[0]) break;
			newApiKey = this.generateApiKey();
		}

		// Update the user's API key in the database
		const result = await this.dbSession.executeWrite('UPDATE users SET api_key = ? WHERE id = ? RETURNING api_key', [
			newApiKey,
			userId,
		]);

		const rows = result.results as unknown as Array<{ api_key: string }> | null;
		if (!rows || !rows[0]) {
			throw new Error('Failed to update API key');
		}

		const apiKey = rows[0].api_key;
		try {
			this.posthog?.track('User API Key Regenerated', { userId });
		} catch (e) {
			console.warn('Posthog track failed (API Key Regenerated)', e);
		}
		return apiKey;
	}
	async isVatsimIdBanned(vatsimId: string): Promise<boolean> {
		const res = await this.dbSession.executeRead<{ vatsim_id: string; expires_at: string | null }>(
			'SELECT vatsim_id, expires_at FROM bans WHERE vatsim_id = ?',
			[vatsimId],
		);
		const row = res.results[0];
		if (!row) return false;
		if (!row.expires_at) return true; // permanent
		const now = Date.now();
		const exp = new Date(row.expires_at).getTime();
		return now <= exp;
	}

	/** Create or update a ban for a vatsim id. Account is kept so UI can surface ban. */
	async banUser(vatsimId: string, reason: string | null, issuedBy: string, expiresAt?: string | null): Promise<void> {
		this.dbSession.startSession({ mode: 'first-primary' });
		// Upsert ban
		await this.dbSession.executeWrite(
			`INSERT INTO bans (vatsim_id, reason, issued_by, created_at, expires_at)
			 VALUES (?, ?, ?, datetime('now'), ?)
			 ON CONFLICT(vatsim_id) DO UPDATE SET reason=excluded.reason, issued_by=excluded.issued_by, created_at=datetime('now'), expires_at=excluded.expires_at`,
			[vatsimId, reason ?? null, issuedBy, expiresAt ?? null],
		);
	}

	/** Remove a ban for a vatsim id */
	async unbanUser(vatsimId: string): Promise<void> {
		this.dbSession.startSession({ mode: 'first-primary' });
		await this.dbSession.executeWrite('DELETE FROM bans WHERE vatsim_id = ?', [vatsimId]);
	}

	/** List bans */
	async listBans(): Promise<
		Array<{ vatsim_id: string; reason: string | null; issued_by: string; created_at: string; expires_at: string | null }>
	> {
		const res = await this.dbSession.executeRead<{
			vatsim_id: string;
			reason: string | null;
			issued_by: string;
			created_at: string;
			expires_at: string | null;
		}>('SELECT vatsim_id, reason, issued_by, created_at, expires_at FROM bans ORDER BY created_at DESC');
		return res.results;
	}

	/** Return ban details if banned, otherwise null */
	async getBanInfo(
		vatsimId: string,
	): Promise<{ vatsim_id: string; reason: string | null; created_at: string; expires_at: string | null } | null> {
		const res = await this.dbSession.executeRead<{
			vatsim_id: string;
			reason: string | null;
			created_at: string;
			expires_at: string | null;
		}>('SELECT vatsim_id, reason, created_at, expires_at FROM bans WHERE vatsim_id = ?', [vatsimId]);
		const row = res.results[0];
		if (!row) return null;
		if (!row.expires_at) return row; // permanent
		const now = Date.now();
		const exp = new Date(row.expires_at).getTime();
		return now <= exp ? row : null;
	}
}
