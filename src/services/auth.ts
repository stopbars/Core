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

	async handleCallback(code: string) {
		const auth = await this.vatsim.getToken(code);
		const vatsimUser = await this.vatsim.getUser(auth.access_token);
		if (!vatsimUser.id || !vatsimUser.email) {
			throw new Error('Invalid VATSIM user data');
		}
		const { user, created } = await this.getOrCreateUser(vatsimUser);
		try {
			this.posthog?.track(created ? 'User Signed Up' : 'User Logged In', {
				vatsimId: vatsimUser.id,
				isNewUser: created,
				userId: user.id,
			});
		} catch { /* ignore analytics errors */ }
		return { user, vatsimToken: auth.access_token };
	}

	private async getOrCreateUser(vatsimUser: VatsimUser): Promise<{ user: UserRecord; created: boolean }> {
		// Use primary mode for authentication checks to ensure latest data
		this.dbSession.startSession({ mode: 'first-primary' });

		const existingUserResult = await this.dbSession.executeRead<UserRecord>(
			'SELECT * FROM users WHERE vatsim_id = ?',
			[vatsimUser.id]
		);
		const existingUser = existingUserResult.results[0];

		if (existingUser) {
			await this.updateUserLastLogin(existingUser.id);
			return { user: existingUser, created: false };
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
		const existingVatsimUserResult = await this.dbSession.executeRead<UserRecord>(
			'SELECT id FROM users WHERE vatsim_id = ?',
			[vatsimUser.id]
		);

		if (existingVatsimUserResult.results[0]) {
			throw new Error('User with this VATSIM ID already exists');
		}

		let apiKey = this.generateApiKey();

		while (true) {
			const existingKeyResult = await this.dbSession.executeRead<UserRecord>(
				'SELECT id FROM users WHERE api_key = ?',
				[apiKey]
			);

			if (!existingKeyResult.results[0]) break;
			apiKey = this.generateApiKey();
		}

		const result = await this.dbSession.executeWrite(
			'INSERT INTO users (vatsim_id, api_key, email, created_at, last_login) VALUES (?, ?, ?, ?, ?) RETURNING *',
			[vatsimUser.id, apiKey, vatsimUser.email, new Date().toISOString(), new Date().toISOString()]
		);

		if (!result.results[0]) throw new Error('Failed to create user');
		return result.results[0] as UserRecord;
	}

	async deleteUserAccount(vatsimId: string): Promise<boolean> {
		// Use primary mode for write operations
		this.dbSession.startSession({ mode: 'first-primary' });

		await this.dbSession.executeBatch([
			{ query: 'DELETE FROM division_members WHERE vatsim_id = ?', params: [vatsimId] },
			{ query: 'DELETE FROM staff WHERE user_id IN (SELECT id FROM users WHERE vatsim_id = ?)', params: [vatsimId] },
			{ query: 'DELETE FROM users WHERE vatsim_id = ?', params: [vatsimId] }
		]);

		const userExists = await this.getUserByVatsimId(vatsimId);
		const deleted = !userExists;
		if (deleted) {
			try { this.posthog?.track('User Deleted', { vatsimId }); } catch { }
		}
		return deleted;
	}

	async getUserByApiKey(apiKey: string): Promise<UserRecord | null> {
		// Use unconstrained read for API key lookups (performance optimization)
		const result = await this.dbSession.executeRead<UserRecord>(
			'SELECT * FROM users WHERE api_key = ?',
			[apiKey]
		);
		return result.results[0] || null;
	}

	async getUserByVatsimId(vatsimId: string): Promise<UserRecord | null> {
		// Use unconstrained read for VATSIM ID lookups
		const result = await this.dbSession.executeRead<UserRecord>(
			'SELECT * FROM users WHERE vatsim_id = ?',
			[vatsimId]
		);
		return result.results[0] || null;
	}

	private async updateUserLastLogin(userId: number) {
		await this.dbSession.executeWrite(
			'UPDATE users SET last_login = ? WHERE id = ?',
			[new Date().toISOString(), userId]
		);
	}

	async regenerateApiKey(userId: number): Promise<string> {
		// Use primary mode for API key regeneration
		this.dbSession.startSession({ mode: 'first-primary' });

		let newApiKey = this.generateApiKey();

		// Make sure the new API key is unique
		while (true) {
			const existingKeyResult = await this.dbSession.executeRead<UserRecord>(
				'SELECT id FROM users WHERE api_key = ?',
				[newApiKey]
			);

			if (!existingKeyResult.results[0]) break;
			newApiKey = this.generateApiKey();
		}

		// Update the user's API key in the database
		const result = await this.dbSession.executeWrite(
			'UPDATE users SET api_key = ? WHERE id = ? RETURNING api_key',
			[newApiKey, userId]
		);

		if (!result.results[0]) {
			throw new Error('Failed to update API key');
		}

		const apiKey = (result.results[0] as { api_key: string }).api_key;
		try { this.posthog?.track('User API Key Regenerated', { userId }); } catch { }
		return apiKey;
	}
}
