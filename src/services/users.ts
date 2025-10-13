// import { UserRecord } from '../types';
import { RoleService, StaffRole } from './roles';
import { AuthService } from './auth';
import { PostHogService } from './posthog';
import { HttpError } from './errors';

import { DatabaseSessionService } from './database-session';

// Lightweight DTO for staff views
type StaffUserDTO = {
	id: number;
	vatsim_id: string;
	email: string;
	full_name: string | null;
	display_mode?: number;
	display_name: string | null;
	region: { id: string | null; name: string | null } | null;
	division: { id: string | null; name: string | null } | null;
	subdivision: { id: string | null; name: string | null } | null;
	created_at: string;
	last_login: string;
};

export class UserService {
	private dbSession: DatabaseSessionService;
	constructor(
		private db: D1Database,
		private roles: RoleService,
		private auth: AuthService,
		private posthog?: PostHogService,
	) {
		this.dbSession = new DatabaseSessionService(db);
	}

	// Get all users with pagination
	async getAllUsers(page: number = 1, limit: number = 10, userId: number): Promise<{ users: StaffUserDTO[]; total: number }> {
		// Check if user has permission
		const hasPermission = await this.roles.hasPermission(userId, StaffRole.LEAD_DEVELOPER);
		if (!hasPermission) {
			throw new HttpError(403, 'Forbidden: Only lead developers can access user management');
		}

		const offset = (page - 1) * limit;

		try {
			const [usersResult, countResult] = await Promise.all([
				this.dbSession.executeRead<{
					id: number;
					vatsim_id: string;
					email: string;
					full_name: string | null;
					display_mode: number | null;
					display_name: string | null;
					region_id: string | null;
					region_name: string | null;
					division_id: string | null;
					division_name: string | null;
					subdivision_id: string | null;
					subdivision_name: string | null;
					created_at: string;
					last_login: string;
					is_staff: number;
					role: number | null;
				}>(
					`
				SELECT u.id, u.vatsim_id, u.email, u.full_name, u.display_mode, u.display_name, u.region_id, u.region_name, u.division_id, u.division_name, u.subdivision_id, u.subdivision_name, u.created_at, u.last_login,
				CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_staff,
				s.role
				FROM users u
				LEFT JOIN staff s ON u.id = s.user_id
				ORDER BY u.created_at DESC
				LIMIT ? OFFSET ?
			  `,
					[limit, offset],
				),
				this.dbSession.executeRead<{ count: number }>('SELECT COUNT(*) as count FROM users'),
			]);
			if (!usersResult || !countResult) {
				throw new Error('Failed to fetch users');
			}
			return {
				users: usersResult.results.map((u) => ({
					id: u.id,
					vatsim_id: u.vatsim_id,
					email: u.email,
					full_name: u.full_name,
					display_mode: u.display_mode ?? undefined,
					display_name: u.display_name,
					region: u.region_id || u.region_name ? { id: u.region_id, name: u.region_name } : null,
					division: u.division_id || u.division_name ? { id: u.division_id, name: u.division_name } : null,
					subdivision: u.subdivision_id || u.subdivision_name ? { id: u.subdivision_id, name: u.subdivision_name } : null,
					created_at: u.created_at,
					last_login: u.last_login,
				})),
				total: countResult.results[0]?.count || 0,
			};
		} catch {
			throw new HttpError(500, 'Failed to fetch users');
		}
	}

	// Search users by email or vatsim_id
	async searchUsers(query: string, userId: number): Promise<StaffUserDTO[]> {
		// Check if user has permission
		const hasPermission = await this.roles.hasPermission(userId, StaffRole.LEAD_DEVELOPER);
		if (!hasPermission) {
			throw new HttpError(403, 'Forbidden: Only lead developers can search users');
		}

		try {
			const result = await this.dbSession.executeRead<{
				id: number;
				vatsim_id: string;
				email: string;
				full_name: string | null;
				display_mode: number | null;
				display_name: string | null;
				region_id: string | null;
				region_name: string | null;
				division_id: string | null;
				division_name: string | null;
				subdivision_id: string | null;
				subdivision_name: string | null;
				created_at: string;
				last_login: string;
				is_staff: number;
				role: number | null;
			}>(
				`
		  SELECT u.id, u.vatsim_id, u.email, u.full_name, u.display_mode, u.display_name, u.region_id, u.region_name, u.division_id, u.division_name, u.subdivision_id, u.subdivision_name, u.created_at, u.last_login,
		  CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_staff,
		  s.role
		  FROM users u
		  LEFT JOIN staff s ON u.id = s.user_id
		  WHERE u.email LIKE ? OR u.vatsim_id LIKE ?
		  ORDER BY u.created_at DESC
		  LIMIT 50
		`,
				[`%${query}%`, `%${query}%`],
			);
			if (!result) {
				throw new Error('Failed to search users');
			}
			return result.results.map((u) => ({
				id: u.id,
				vatsim_id: u.vatsim_id,
				email: u.email,
				full_name: u.full_name,
				display_mode: u.display_mode ?? undefined,
				display_name: u.display_name,
				region: u.region_id || u.region_name ? { id: u.region_id, name: u.region_name } : null,
				division: u.division_id || u.division_name ? { id: u.division_id, name: u.division_name } : null,
				subdivision: u.subdivision_id || u.subdivision_name ? { id: u.subdivision_id, name: u.subdivision_name } : null,
				created_at: u.created_at,
				last_login: u.last_login,
			}));
		} catch {
			throw new HttpError(500, 'Failed to search users');
		}
	}

	// Delete user by id
	async deleteUser(userId: number, requestingUserId: number): Promise<boolean> {
		// Check if user has permission
		const hasPermission = await this.roles.hasPermission(requestingUserId, StaffRole.LEAD_DEVELOPER);
		if (!hasPermission) {
			throw new HttpError(403, 'Forbidden: Only lead developers can delete users');
		}

		try {
			// Get the user to delete
			const userToDeleteResult = await this.dbSession.executeRead<{ vatsim_id: string }>('SELECT vatsim_id FROM users WHERE id = ?', [
				userId,
			]);
			const userToDelete = userToDeleteResult.results[0];
			if (!userToDelete) {
				throw new HttpError(404, 'User not found');
			}
			// Use the existing delete method in AuthService
			const deleted = await this.auth.deleteUserAccount(userToDelete.vatsim_id);
			if (!deleted) {
				throw new HttpError(500, 'Failed to delete user');
			}
			try {
				this.posthog?.track('Admin Deleted User', { userId, requestingUserId });
			} catch (e) {
				console.warn('Posthog tracking failed', e);
			}
			return true;
		} catch (e) {
			console.error('Failed to delete user', e);
			throw new HttpError(500, 'Failed to delete user');
		}
	}

	// Refresh user's API token by VATSIM ID (lead developers only)
	async refreshUserApiToken(vatsimId: string, requestingUserId: number): Promise<string> {
		// Check if user has permission
		const hasPermission = await this.roles.hasPermission(requestingUserId, StaffRole.LEAD_DEVELOPER);
		if (!hasPermission) {
			throw new HttpError(403, 'Forbidden: Only lead developers can refresh user API tokens');
		}

		try {
			// Get the user by VATSIM ID
			const userResult = await this.dbSession.executeRead<{ id: number }>('SELECT id FROM users WHERE vatsim_id = ?', [vatsimId]);
			const user = userResult.results[0];
			if (!user) {
				throw new HttpError(404, 'User not found');
			}
			// Use the auth service to regenerate the API key
			const newApiKey = await this.auth.regenerateApiKey(user.id);
			try {
				this.posthog?.track('Admin Regenerated User API Key', { vatsimId, requestingUserId });
			} catch (e) {
				console.warn('Posthog tracking failed', e);
			}
			return newApiKey;
		} catch (error) {
			console.error('Error refreshing user API token:', error);
			if (error instanceof HttpError) throw error;
			throw new HttpError(500, `Failed to refresh user API token: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}
}
