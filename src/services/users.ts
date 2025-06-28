import { UserRecord } from '../types';
import { RoleService, StaffRole } from './roles';
import { AuthService } from './auth';

export class UserService {
	constructor(
		private db: D1Database,
		private roles: RoleService,
		private auth: AuthService,
	) { }

	// Get all users with pagination
	async getAllUsers(page: number = 1, limit: number = 10, userId: number): Promise<{ users: UserRecord[]; total: number }> {
		// Check if user has permission
		const hasPermission = await this.roles.hasPermission(userId, StaffRole.LEAD_DEVELOPER);
		if (!hasPermission) {
			throw new Error('Unauthorized: Only lead developers can access user management');
		}

		const offset = (page - 1) * limit;

		try {
			const [usersResult, countResult] = await Promise.all([
				this.db
					.prepare(
						`
            SELECT u.id, u.vatsim_id, u.email, u.created_at, u.last_login,
            CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_staff,
            s.role
            FROM users u
            LEFT JOIN staff s ON u.id = s.user_id
            ORDER BY u.created_at DESC
            LIMIT ? OFFSET ?
          `,
					)
					.bind(limit, offset)
					.all<any>(),

				this.db.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>(),
			]);

			if (!usersResult || !countResult) {
				throw new Error('Failed to fetch users');
			}
			return {
				users: usersResult.results,
				total: countResult.count,
			};
		} catch (error) {
			throw new Error('Failed to fetch users');
		}
	}

	// Search users by email or vatsim_id
	async searchUsers(query: string, userId: number): Promise<UserRecord[]> {
		// Check if user has permission
		const hasPermission = await this.roles.hasPermission(userId, StaffRole.LEAD_DEVELOPER);
		if (!hasPermission) {
			throw new Error('Unauthorized: Only lead developers can search users');
		}

		try {
			const result = await this.db
				.prepare(
					`
          SELECT u.id, u.vatsim_id, u.email, u.created_at, u.last_login,
          CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_staff,
          s.role
          FROM users u
          LEFT JOIN staff s ON u.id = s.user_id
          WHERE u.email LIKE ? OR u.vatsim_id LIKE ?
          ORDER BY u.created_at DESC
          LIMIT 50
        `,
				)
				.bind(`%${query}%`, `%${query}%`)
				.all<any>();

			if (!result) {
				throw new Error('Failed to search users');
			}
			return result.results;
		} catch (error) {
			throw new Error('Failed to search users');
		}
	}

	// Delete user by id
	async deleteUser(userId: number, requestingUserId: number): Promise<boolean> {
		// Check if user has permission
		const hasPermission = await this.roles.hasPermission(requestingUserId, StaffRole.LEAD_DEVELOPER);
		if (!hasPermission) {
			throw new Error('Unauthorized: Only lead developers can delete users');
		}

		try {
			// Get the user to delete
			const userToDelete = await this.db
				.prepare('SELECT vatsim_id FROM users WHERE id = ?')
				.bind(userId)
				.first<{ vatsim_id: string }>();

			if (!userToDelete) {
				throw new Error('User not found');
			}

			// Use the existing delete method in AuthService
			const deleted = await this.auth.deleteUserAccount(userToDelete.vatsim_id);

			if (!deleted) {
				throw new Error('Failed to delete user');
			}
			return true;
		} catch (error) {
			throw new Error('Failed to delete user');
		}
	}

	// Refresh user's API token by VATSIM ID (lead developers only)
	async refreshUserApiToken(vatsimId: string, requestingUserId: number): Promise<string> {
		// Check if user has permission
		const hasPermission = await this.roles.hasPermission(requestingUserId, StaffRole.LEAD_DEVELOPER);
		if (!hasPermission) {
			throw new Error('Unauthorized: Only lead developers can refresh user API tokens');
		}

		try {
			// Get the user by VATSIM ID
			const user = await this.db
				.prepare('SELECT id FROM users WHERE vatsim_id = ?')
				.bind(vatsimId)
				.first<{ id: number }>();

			if (!user) {
				throw new Error('User not found');
			}

			// Use the auth service to regenerate the API key
			const newApiKey = await this.auth.regenerateApiKey(user.id);

			return newApiKey;
		} catch (error) {
			console.error('Error refreshing user API token:', error);
			if (error instanceof Error && error.message === 'User not found') {
				throw error;
			}
			throw new Error(`Failed to refresh user API token: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}
}
