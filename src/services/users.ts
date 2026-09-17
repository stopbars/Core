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
	is_staff: boolean;
	fast_track: { enabled: boolean; expires_at: string | null };
	contribution_stats: {
		approved: number;
		airports: number;
		rejected: number;
	};
};

type StaffUserRow = {
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
	fast_track_expires_at: string | null;
	approved_contributions: number;
	approved_airports: number;
	rejected_contributions: number;
};

type UserCountRow = { count: number };

const staffUserProjection = `
    u.id, u.vatsim_id, u.email, u.full_name, u.display_mode, u.display_name,
    u.region_id, u.region_name, u.division_id, u.division_name,
    u.subdivision_id, u.subdivision_name, u.created_at, u.last_login,
    CASE WHEN s.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_staff,
    (SELECT ft.expires_at FROM contributor_fast_track ft
        WHERE ft.user_id = u.id AND ft.enabled = 1
            AND ft.expires_at > CURRENT_TIMESTAMP LIMIT 1) AS fast_track_expires_at,
    (SELECT COUNT(*) FROM contributions c
        WHERE c.user_id = u.vatsim_id AND c.status = 'approved') AS approved_contributions,
    (SELECT COUNT(DISTINCT c.airport_icao) FROM contributions c
        WHERE c.user_id = u.vatsim_id AND c.status = 'approved') AS approved_airports,
    (SELECT COUNT(*) FROM contributions c
        WHERE c.user_id = u.vatsim_id AND c.status = 'rejected') AS rejected_contributions`;

const toStaffUserDto = (user: StaffUserRow): StaffUserDTO => {
	return {
		id: user.id,
		vatsim_id: user.vatsim_id,
		email: user.email,
		full_name: user.full_name,
		display_mode: user.display_mode ?? undefined,
		display_name: user.display_name,
		region: user.region_id || user.region_name ? { id: user.region_id, name: user.region_name } : null,
		division: user.division_id || user.division_name ? { id: user.division_id, name: user.division_name } : null,
		subdivision: user.subdivision_id || user.subdivision_name ? { id: user.subdivision_id, name: user.subdivision_name } : null,
		created_at: user.created_at,
		last_login: user.last_login,
		is_staff: user.is_staff === 1,
		fast_track: {
			enabled: user.fast_track_expires_at !== null,
			expires_at: user.fast_track_expires_at,
		},
		contribution_stats: {
			approved: Number(user.approved_contributions) || 0,
			airports: Number(user.approved_airports) || 0,
			rejected: Number(user.rejected_contributions) || 0,
		},
	};
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
		const hasPermission = await this.roles.hasPermission(userId, StaffRole.PRODUCT_MANAGER);
		if (!hasPermission) {
			throw new HttpError(403, 'Forbidden: Only product managers and lead developers can access user management');
		}

		const offset = (page - 1) * limit;

		try {
			const [usersResult, countResult] = await this.dbSession.executeReadBatch([
				{
					query: `
						SELECT ${staffUserProjection}
						FROM users u
						LEFT JOIN staff s ON s.user_id = u.id
						ORDER BY u.created_at DESC
						LIMIT ? OFFSET ?`,
					params: [limit, offset],
				},
				{ query: 'SELECT COUNT(*) AS count FROM users' },
			]);
			// SAFETY: The first SELECT explicitly projects every StaffUserRow column, and D1 preserves those column names in results.
			const users = usersResult.results as StaffUserRow[];
			// SAFETY: The second SELECT aliases its single aggregate column to `count`, matching UserCountRow.
			const count = countResult.results as UserCountRow[];
			return {
				users: users.map(toStaffUserDto),
				total: count[0]?.count || 0,
			};
		} catch {
			throw new HttpError(500, 'Failed to fetch users');
		}
	}

	// Search users by email or vatsim_id
	async searchUsers(query: string, userId: number): Promise<StaffUserDTO[]> {
		// Check if user has permission
		const hasPermission = await this.roles.hasPermission(userId, StaffRole.PRODUCT_MANAGER);
		if (!hasPermission) {
			throw new HttpError(403, 'Forbidden: Only product managers and lead developers can search users');
		}

		try {
			const result = await this.dbSession.executeRead<StaffUserRow>(
				`
		  SELECT ${staffUserProjection}
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
			return result.results.map(toStaffUserDto);
		} catch {
			throw new HttpError(500, 'Failed to search users');
		}
	}

	async setFastTrackAccess(
		targetUserId: number,
		enabled: boolean,
		requestingUserId: number,
	): Promise<{ enabled: boolean; expires_at: string | null }> {
		const hasPermission = await this.roles.hasPermission(requestingUserId, StaffRole.PRODUCT_MANAGER);
		if (!hasPermission) {
			throw new HttpError(403, 'Forbidden: Only product managers and lead developers can manage fast-track access');
		}

		const target = await this.dbSession.executeLatest<{ id: number; vatsim_id: string }>(
			'SELECT id, vatsim_id FROM users WHERE id = ? LIMIT 1',
			[targetUserId],
		);
		const targetUser = target.results[0];
		if (!targetUser) throw new HttpError(404, 'User not found');

		if (enabled) {
			await this.dbSession.executeWrite(
				`INSERT INTO contributor_fast_track (
						user_id, enabled, granted_by, granted_at, expires_at, updated_by, updated_at
					) VALUES (?, 1, ?, CURRENT_TIMESTAMP, datetime('now', '+1 year'), ?, CURRENT_TIMESTAMP)
					ON CONFLICT(user_id) DO UPDATE SET
						enabled = 1,
						granted_by = excluded.granted_by,
						granted_at = excluded.granted_at,
						expires_at = excluded.expires_at,
						updated_by = excluded.updated_by,
						updated_at = excluded.updated_at`,
				[targetUserId, requestingUserId, requestingUserId],
			);
		} else {
			await this.dbSession.executeWrite(
				`UPDATE contributor_fast_track
				 SET enabled = 0, updated_by = ?, updated_at = CURRENT_TIMESTAMP
				 WHERE user_id = ? AND enabled = 1`,
				[requestingUserId, targetUserId],
			);
		}

		const active = await this.dbSession.executeLatest<{ expires_at: string }>(
			`SELECT expires_at
			 FROM contributor_fast_track
			 WHERE user_id = ? AND enabled = 1 AND expires_at > CURRENT_TIMESTAMP
			 LIMIT 1`,
			[targetUserId],
		);
		const expiresAt = active.results[0]?.expires_at ?? null;

		try {
			this.posthog?.track('Contributor Fast Track Updated', {
				targetVatsimId: targetUser.vatsim_id,
				requestingUserId,
				enabled: expiresAt !== null,
			});
		} catch (error) {
			console.warn('Posthog tracking failed', error);
		}

		return { enabled: expiresAt !== null, expires_at: expiresAt };
	}

	// Delete user by id
	async deleteUser(userId: number, requestingUserId: number): Promise<boolean> {
		// Check if user has permission
		const hasPermission = await this.roles.hasPermission(requestingUserId, StaffRole.PRODUCT_MANAGER);
		if (!hasPermission) {
			throw new HttpError(403, 'Forbidden: Only product managers and lead developers can delete users');
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

	// Refresh user's API token by VATSIM ID (product managers and lead developers)
	async refreshUserApiToken(vatsimId: string, requestingUserId: number): Promise<string> {
		// Check if user has permission
		const hasPermission = await this.roles.hasPermission(requestingUserId, StaffRole.PRODUCT_MANAGER);
		if (!hasPermission) {
			throw new HttpError(403, 'Forbidden: Only product managers and lead developers can refresh user API tokens');
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
