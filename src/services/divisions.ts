import { Role } from './roles';

interface DivisionMember {
	id: number;
	division_id: number;
	vatsim_id: string;
	role: 'nav_head' | 'nav_member';
	created_at: string;
}

interface Division {
	id: number;
	name: string;
	created_at: string;
}

interface DivisionAirport {
	id: number;
	division_id: number;
	icao: string;
	status: 'pending' | 'approved' | 'rejected';
	requested_by: string;
	approved_by?: string;
	created_at: string;
	updated_at: string;
}

export class DivisionService {
	constructor(private db: D1Database) {}

	async createDivision(name: string, headVatsimId: string): Promise<Division> {
		const stmt = await this.db.prepare('INSERT INTO divisions (name) VALUES (?) RETURNING *').bind(name);
		const division = await stmt.first<Division>();
		if (!division) throw new Error('Failed to create division');

		await this.addMember(division.id, headVatsimId, 'nav_head');

		return division;
	}

	async getDivision(id: number): Promise<Division | null> {
		return await this.db.prepare('SELECT * FROM divisions WHERE id = ?').bind(id).first<Division>();
	}

	async addMember(divisionId: number, vatsimId: string, role: 'nav_head' | 'nav_member'): Promise<DivisionMember> {
		const stmt = await this.db
			.prepare('INSERT INTO division_members (division_id, vatsim_id, role) VALUES (?, ?, ?) RETURNING *')
			.bind(divisionId, vatsimId, role);

		const member = await stmt.first<DivisionMember>();
		if (!member) throw new Error('Failed to add member to division');
		return member;
	}

	async removeMember(divisionId: number, vatsimId: string): Promise<void> {
		await this.db.prepare('DELETE FROM division_members WHERE division_id = ? AND vatsim_id = ?').bind(divisionId, vatsimId).run();
	}

	async getMemberRole(divisionId: number, vatsimId: string): Promise<'nav_head' | 'nav_member' | null> {
		const member = await this.db
			.prepare('SELECT role FROM division_members WHERE division_id = ? AND vatsim_id = ?')
			.bind(divisionId, vatsimId)
			.first<{ role: 'nav_head' | 'nav_member' }>();

		return member?.role || null;
	}
	async requestAirport(divisionId: number, icao: string, requestedBy: string): Promise<DivisionAirport> {
		const role = await this.getMemberRole(divisionId, requestedBy);
		if (!role) throw new Error('User is not a member of this division');

		const stmt = await this.db
			.prepare('INSERT INTO division_airports (division_id, icao, requested_by) VALUES (?, ?, ?) RETURNING *')
			.bind(divisionId, icao, requestedBy);

		const request = await stmt.first<DivisionAirport>();
		if (!request) throw new Error('Failed to create airport request');
		return request;
	}
	async approveAirport(airportId: number, approvedBy: string, approved: boolean): Promise<DivisionAirport> {
		const stmt = await this.db
			.prepare(
				`
            UPDATE division_airports 
            SET status = ?, approved_by = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ? 
            RETURNING *
        `,
			)
			.bind(approved ? 'approved' : 'rejected', approvedBy, airportId);

		const airport = await stmt.first<DivisionAirport>();
		if (!airport) throw new Error('Airport request not found');
		return airport;
	}

	async getDivisionAirports(divisionId: number): Promise<DivisionAirport[]> {
		return await this.db
			.prepare('SELECT * FROM division_airports WHERE division_id = ?')
			.bind(divisionId)
			.all<DivisionAirport>()
			.then((result) => result.results);
	}

	async getDivisionMembers(divisionId: number): Promise<DivisionMember[]> {
		return await this.db
			.prepare('SELECT * FROM division_members WHERE division_id = ?')
			.bind(divisionId)
			.all<DivisionMember>()
			.then((result) => result.results);
	}

	async getAllDivisions(): Promise<Division[]> {
		return await this.db
			.prepare('SELECT * FROM divisions')
			.all<Division>()
			.then((result) => result.results);
	}

	async getUserDivisions(vatsimId: string): Promise<{ division: Division; role: string }[]> {
		return await this.db
			.prepare(
				`
            SELECT d.*, dm.role 
            FROM divisions d 
            JOIN division_members dm ON d.id = dm.division_id 
            WHERE dm.vatsim_id = ?
        `,
			)
			.bind(vatsimId)
			.all<{ division: Division; role: string }>()
			.then((result) => result.results);
	}
	async userHasAirportAccess(userId: string, airportIcao: string): Promise<boolean> {
		const stmt = await this.db
			.prepare(
				`
          SELECT da.id 
          FROM division_airports da
          JOIN division_members dm ON da.division_id = dm.division_id
          WHERE dm.vatsim_id = ? AND da.icao = ? AND da.status = 'approved'
        `,
			)
			.bind(userId, airportIcao);

		const result = await stmt.first();
		return result !== null;
	}

	async getUserRoleForAirport(userId: string, airportIcao: string): Promise<'nav_head' | 'nav_member' | null> {
		const stmt = await this.db
			.prepare(
				`
            SELECT dm.role 
            FROM division_members dm
            JOIN division_airports da ON da.division_id = dm.division_id
            WHERE dm.vatsim_id = ? 
            AND da.icao = ? 
            AND da.status = 'approved'
            LIMIT 1
        `,
			)
			.bind(userId, airportIcao);

		const result = await stmt.first<{ role: 'nav_head' | 'nav_member' }>();
		return result?.role || null;
	}
}
