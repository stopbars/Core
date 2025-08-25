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

	async isStaff(userId: number): Promise<boolean> {
		const staffResult = await this.dbSession.executeRead<StaffRecord>('SELECT * FROM staff WHERE user_id = ?', [userId]);
		const staff = staffResult.results[0];
		return !!staff && !!staff.role && staff.role in roleHierarchy;
	}

	async getUserRole(userId: number): Promise<StaffRole | null> {
		const staffResult = await this.dbSession.executeRead<StaffRecord>('SELECT * FROM staff WHERE user_id = ?', [userId]);
		const staff = staffResult.results[0];
		if (!staff?.role) return null;
		return staff.role as StaffRole;
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
		return rolesResult.results.reduce(
			(acc, { role }) => ({
				...acc,
				[role]: 1,
			}),
			{} as DivisionRoles,
		);
	}

	// --- Staff management helpers (write) ---
	private async getRoleCount(role: StaffRole): Promise<number> {
		const res = await this.dbSession.executeRead<{ cnt: number }>('SELECT COUNT(*) as cnt FROM staff WHERE role = ?', [role]);
		return res.results[0]?.cnt || 0;
	}

	private async ensureNotLastLeadDeveloper(userId: number, changingToRole?: StaffRole | null) {
		const existing = await this.dbSession.executeRead<StaffRecord>('SELECT * FROM staff WHERE user_id = ?', [userId]);
		const current = existing.results[0];
		if (!current) return; // not staff
		if (
			(current.role as StaffRole) === StaffRole.LEAD_DEVELOPER &&
			(changingToRole == null || changingToRole !== StaffRole.LEAD_DEVELOPER)
		) {
			const count = await this.getRoleCount(StaffRole.LEAD_DEVELOPER);
			if (count <= 1) throw new Error('Cannot modify or remove the last remaining lead developer');
		}
	}

	async addStaff(userId: number, role: StaffRole): Promise<{ user_id: number; role: StaffRole; created_at: string }> {
		const existing = await this.dbSession.executeRead<StaffRecord>('SELECT * FROM staff WHERE user_id = ?', [userId]);
		if (existing.results[0]) {
			await this.ensureNotLastLeadDeveloper(userId, role);
			await this.dbSession.executeWrite('UPDATE staff SET role = ? WHERE user_id = ?', [role, userId]);
			const updated = await this.dbSession.executeRead<StaffRecord>('SELECT * FROM staff WHERE user_id = ?', [userId]);
			const row = updated.results[0]!;
			return { user_id: row.user_id, role: row.role as StaffRole, created_at: row.created_at };
		}
		const createdAt = new Date().toISOString();
		await this.dbSession.executeWrite('INSERT INTO staff (user_id, role, created_at) VALUES (?, ?, ?)', [userId, role, createdAt]);
		return { user_id: userId, role, created_at: createdAt };
	}

	async updateStaffRole(userId: number, role: StaffRole): Promise<boolean> {
		await this.ensureNotLastLeadDeveloper(userId, role);
		const result = await this.dbSession.executeWrite('UPDATE staff SET role = ? WHERE user_id = ?', [role, userId]);
		return !!result.success;
	}

	async removeStaff(userId: number): Promise<boolean> {
		await this.ensureNotLastLeadDeveloper(userId, null);
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
