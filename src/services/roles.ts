export enum StaffRole {
	LEAD_DEVELOPER = 'LEAD_DEVELOPER',
	PRODUCT_MANAGER = 'PRODUCT_MANAGER',
}

export const roleHierarchy: Record<StaffRole, number> = {
	LEAD_DEVELOPER: 999,
	PRODUCT_MANAGER: 500,
};

export type Role = 'lead_developer' | 'product_manager' | 'nav_head' | 'nav_member';

export interface StaffRoles {
	lead_developer?: 1 | 0;
	product_manager?: 1 | 0;
}

export interface DivisionRoles {
	nav_head?: 1 | 0;
	nav_member?: 1 | 0;
}

import { StaffRecord } from '../types';

import { DatabaseSessionService } from './database-session';

export class RoleService {
	private dbSession: DatabaseSessionService;
	constructor(private db: D1Database) {
		this.dbSession = new DatabaseSessionService(db);
	}

	private async fetchStaffRecord(userId: number): Promise<StaffRecord | null> {
		const staffResult = await this.dbSession.executeRead<StaffRecord>(
			'SELECT id, user_id, role, created_at FROM staff WHERE user_id = ? LIMIT 1',
			[userId],
		);
		return staffResult.results[0] ?? null;
	}

	private normalizeStaffRole(role?: StaffRecord['role'] | null): StaffRole | null {
		if (!role) return null;
		return role in roleHierarchy ? (role as StaffRole) : null;
	}

	async getStaffStatus(userId: number): Promise<{ isStaff: boolean; role: StaffRole | null }> {
		const staff = await this.fetchStaffRecord(userId);
		const role = this.normalizeStaffRole(staff?.role);
		return { isStaff: !!role, role };
	}

	async getStaffStatusByVatsimId(vatsimId: string): Promise<{ userId: number; role: StaffRole | null } | null> {
		const result = await this.dbSession.executeRead<{ user_id: number; role: string | null }>(
			`SELECT u.id AS user_id, s.role
			 FROM users u
			 LEFT JOIN staff s ON s.user_id = u.id
			 WHERE u.vatsim_id = ?
			 LIMIT 1`,
			[vatsimId],
		);
		const row = result.results[0];
		if (!row) return null;
		return { userId: row.user_id, role: this.normalizeStaffRole(row.role as StaffRecord['role'] | null) };
	}

	async isStaff(userId: number): Promise<boolean> {
		const { isStaff } = await this.getStaffStatus(userId);
		return isStaff;
	}

	async getUserRole(userId: number): Promise<StaffRole | null> {
		const { role } = await this.getStaffStatus(userId);
		return role;
	}

	async hasPermission(userId: number, requiredRole: StaffRole): Promise<boolean> {
		const userRole = await this.getUserRole(userId);
		if (!userRole) return false;
		return roleHierarchy[userRole] >= roleHierarchy[requiredRole];
	}

	async hasRole(userId: number, role: StaffRole | Role): Promise<boolean> {
		if (role in StaffRole) {
			return this.hasPermission(userId, role as StaffRole);
		}
		const divisionRoles = await this.getDivisionRoles(userId);
		return !!divisionRoles[role as keyof DivisionRoles];
	}

	async getDivisionRoles(userId: number): Promise<DivisionRoles> {
		const rolesResult = await this.dbSession.executeRead<{ role: string }>(
			`
			SELECT dm.role
			FROM division_members dm
			JOIN users u ON u.vatsim_id = dm.vatsim_id
			WHERE u.id = ?
		`,
			[userId],
		);
		const roles: DivisionRoles = {};
		for (const { role } of rolesResult.results) {
			if (role === 'nav_head' || role === 'nav_member') roles[role] = 1;
		}
		return roles;
	}

	// --- Staff management helpers (write) ---
	private async getRoleChangeState(userId: number): Promise<(StaffRecord & { lead_count: number }) | null> {
		const result = await this.dbSession.executeLatest<StaffRecord & { lead_count: number }>(
			`SELECT id, user_id, role, created_at,
				(SELECT COUNT(*) FROM staff WHERE role = ?) AS lead_count
			 FROM staff
			 WHERE user_id = ?
			 LIMIT 1`,
			[StaffRole.LEAD_DEVELOPER, userId],
		);
		return result.results[0] ?? null;
	}

	private ensureNotLastLeadDeveloper(current: (StaffRecord & { lead_count: number }) | null, changingToRole?: StaffRole | null) {
		if (!current) return;
		if (
			(current.role as StaffRole) === StaffRole.LEAD_DEVELOPER &&
			(changingToRole == null || changingToRole !== StaffRole.LEAD_DEVELOPER)
		) {
			if (current.lead_count <= 1) throw new Error('Cannot modify or remove the last remaining lead developer');
		}
	}

	async addStaff(userId: number, role: StaffRole): Promise<{ user_id: number; role: StaffRole; created_at: string }> {
		const existing = await this.getRoleChangeState(userId);
		this.ensureNotLastLeadDeveloper(existing, role);
		const createdAt = new Date().toISOString();
		const result = await this.dbSession.executeWrite(
			`INSERT INTO staff (user_id, role, created_at) VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET role = excluded.role
			 RETURNING user_id, role, created_at`,
			[userId, role, createdAt],
		);
		const row = (result.results as unknown as StaffRecord[] | null)?.[0];
		if (!row) throw new Error('Failed to add staff member');
		return { user_id: row.user_id, role: row.role as StaffRole, created_at: row.created_at };
	}

	async updateStaffRole(userId: number, role: StaffRole): Promise<boolean> {
		this.ensureNotLastLeadDeveloper(await this.getRoleChangeState(userId), role);
		const result = await this.dbSession.executeWrite('UPDATE staff SET role = ? WHERE user_id = ?', [role, userId]);
		return !!result.success;
	}

	async removeStaff(userId: number): Promise<boolean> {
		this.ensureNotLastLeadDeveloper(await this.getRoleChangeState(userId), null);
		const result = await this.dbSession.executeWrite('DELETE FROM staff WHERE user_id = ?', [userId]);
		return !!result.success;
	}

	async listStaff(): Promise<
		Array<{ user_id: number; role: StaffRole; created_at: string; vatsim_id: string; full_name: string | null }>
	> {
		const res = await this.dbSession.executeRead<{
			user_id: number;
			role: string;
			created_at: string;
			vatsim_id: string;
			full_name: string | null;
		}>(
			`SELECT s.user_id, s.role, s.created_at, u.vatsim_id, u.full_name
			 FROM staff s
			 JOIN users u ON u.id = s.user_id
			 ORDER BY s.created_at DESC`,
			[],
		);
		return res.results.map((r) => ({
			user_id: r.user_id,
			role: r.role as StaffRole,
			created_at: r.created_at,
			vatsim_id: r.vatsim_id,
			full_name: r.full_name,
		}));
	}
}
