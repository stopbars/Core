export enum StaffRole {
	LEAD_DEVELOPER = 'LEAD_DEVELOPER',
	PRODUCT_MANAGER = 'PRODUCT_MANAGER',
	MAP_APPROVER = 'MAP_APPROVER', // For approving contributions.
}

export const roleHierarchy: Record<StaffRole, number> = {
	LEAD_DEVELOPER: 999,
	PRODUCT_MANAGER: 500,
	MAP_APPROVER: 100,
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
}
