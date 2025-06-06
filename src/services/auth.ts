import { VatsimUser, UserRecord } from '../types';
import { VatsimService } from './vatsim';
import { StatsService } from './stats';

export class AuthService {
	constructor(
		private db: D1Database,
		private vatsim: VatsimService,
		private stats: StatsService,
	) {}

	async handleCallback(code: string) {
		const auth = await this.vatsim.getToken(code);
		const vatsimUser = await this.vatsim.getUser(auth.access_token);
		if (!vatsimUser.id || !vatsimUser.email) {
			throw new Error('Invalid VATSIM user data');
		}
		const user = await this.getOrCreateUser(vatsimUser);
		return { user, vatsimToken: auth.access_token };
	}

	private async getOrCreateUser(vatsimUser: VatsimUser) {
		const existingUser = await this.db.prepare('SELECT * FROM users WHERE vatsim_id = ?').bind(vatsimUser.id).first<UserRecord>();

		if (existingUser) {
			await this.updateUserLastLogin(existingUser.id);
			await this.stats.incrementStat('user_logins');
			return existingUser;
		}

		const newUser = await this.createNewUser(vatsimUser);
		await this.stats.incrementStat('user_signups');
		return newUser;
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
		const existingVatsimUser = await this.db
			.prepare('SELECT id FROM users WHERE vatsim_id = ?')
			.bind(vatsimUser.id)
			.first<UserRecord>();

		if (existingVatsimUser) {
			throw new Error('User with this VATSIM ID already exists');
		}

		let apiKey = this.generateApiKey();

		while (true) {
			const existingKey = await this.db.prepare('SELECT id FROM users WHERE api_key = ?').bind(apiKey).first<UserRecord>();

			if (!existingKey) break;
			apiKey = this.generateApiKey();
		}

		const result = await this.db
			.prepare('INSERT INTO users (vatsim_id, api_key, email, created_at, last_login) VALUES (?, ?, ?, ?, ?) RETURNING *')
			.bind(vatsimUser.id, apiKey, vatsimUser.email, new Date().toISOString(), new Date().toISOString())
			.first<UserRecord>();

		if (!result) throw new Error('Failed to create user');
		return result;
	}
	async deleteUserAccount(vatsimId: string): Promise<boolean> {
		await this.db.batch([
			this.db.prepare('DELETE FROM division_members WHERE vatsim_id = ?').bind(vatsimId),
			this.db.prepare('DELETE FROM staff WHERE user_id IN (SELECT id FROM users WHERE vatsim_id = ?)').bind(vatsimId),
			this.db.prepare('DELETE FROM users WHERE vatsim_id = ?').bind(vatsimId),
		]);

		await this.stats.incrementStat('user_deletions');

		const userExists = await this.getUserByVatsimId(vatsimId);
		return !userExists;
	}

	async getUserByApiKey(apiKey: string): Promise<UserRecord | null> {
		return await this.db.prepare('SELECT * FROM users WHERE api_key = ?').bind(apiKey).first<UserRecord>();
	}

	async getUserByVatsimId(vatsimId: string): Promise<UserRecord | null> {
		return await this.db.prepare('SELECT * FROM users WHERE vatsim_id = ?').bind(vatsimId).first<UserRecord>();
	}

	private async updateUserLastLogin(userId: number) {
		await this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(new Date().toISOString(), userId).run();
	}

	async regenerateApiKey(userId: number): Promise<string> {
		let newApiKey = this.generateApiKey();

		// Make sure the new API key is unique
		while (true) {
			const existingKey = await this.db.prepare('SELECT id FROM users WHERE api_key = ?').bind(newApiKey).first<UserRecord>();

			if (!existingKey) break;
			newApiKey = this.generateApiKey();
		}

		// Update the user's API key in the database
		const result = await this.db
			.prepare('UPDATE users SET api_key = ? WHERE id = ? RETURNING api_key')
			.bind(newApiKey, userId)
			.first<{ api_key: string }>();

		if (!result) {
			throw new Error('Failed to update API key');
		}

		await this.stats.incrementStat('api_key_regenerations');
		return result.api_key;
	}
}
