import { DatabaseSessionService } from './database-session';
import { PostHogService } from './posthog';

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
	private dbSession: DatabaseSessionService;

	constructor(private db: D1Database, private posthog?: PostHogService) {
		this.dbSession = new DatabaseSessionService(db);
	}

	async createDivision(name: string, headVatsimId: string): Promise<Division> {
		const result = await this.dbSession.executeWrite(
			'INSERT INTO divisions (name) VALUES (?) RETURNING *',
			[name]
		);
		const division = result.results[0] as Division;
		if (!division) throw new Error('Failed to create division');

		await this.addMember(division.id, headVatsimId, 'nav_head');
		try { this.posthog?.track('Division Created', { divisionId: division.id, name }); } catch { }

		return division;
	}

	async getDivision(id: number): Promise<Division | null> {
		const result = await this.dbSession.executeRead<Division>(
			'SELECT * FROM divisions WHERE id = ?',
			[id]
		);
		return result.results[0] || null;
	}

	async addMember(divisionId: number, vatsimId: string, role: 'nav_head' | 'nav_member'): Promise<DivisionMember> {
		const result = await this.dbSession.executeWrite(
			'INSERT INTO division_members (division_id, vatsim_id, role) VALUES (?, ?, ?) RETURNING *',
			[divisionId, vatsimId, role]
		);

		const member = result.results[0] as DivisionMember;
		if (!member) throw new Error('Failed to add member to division');
		try { this.posthog?.track('Division Member Added', { divisionId, vatsimId, role }); } catch { }
		return member;
	}

	async removeMember(divisionId: number, vatsimId: string): Promise<void> {
		await this.dbSession.executeWrite(
			'DELETE FROM division_members WHERE division_id = ? AND vatsim_id = ?',
			[divisionId, vatsimId]
		);
		try { this.posthog?.track('Division Member Removed', { divisionId, vatsimId }); } catch { }
	}

	async getMemberRole(divisionId: number, vatsimId: string): Promise<'nav_head' | 'nav_member' | null> {
		const result = await this.dbSession.executeRead<{ role: 'nav_head' | 'nav_member' }>(
			'SELECT role FROM division_members WHERE division_id = ? AND vatsim_id = ?',
			[divisionId, vatsimId]
		);

		return result.results[0]?.role || null;
	}
	async requestAirport(divisionId: number, icao: string, requestedBy: string): Promise<DivisionAirport> {
		const role = await this.getMemberRole(divisionId, requestedBy);
		if (!role) throw new Error('User is not a member of this division');

		const result = await this.dbSession.executeWrite(
			'INSERT INTO division_airports (division_id, icao, requested_by) VALUES (?, ?, ?) RETURNING *',
			[divisionId, icao, requestedBy]
		);

		const request = result.results[0] as DivisionAirport;
		if (!request) throw new Error('Failed to create airport request');
		try { this.posthog?.track('Division Airport Access Requested', { divisionId, icao, requestedBy }); } catch { }
		return request;
	}
	async approveAirport(airportId: number, approvedBy: string, approved: boolean): Promise<DivisionAirport> {
		const result = await this.dbSession.executeWrite(
			`
            UPDATE division_airports 
            SET status = ?, approved_by = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ? 
            RETURNING *
        `,
			[approved ? 'approved' : 'rejected', approvedBy, airportId]
		);

		const airport = result.results[0] as DivisionAirport;
		if (!airport) throw new Error('Airport request not found');
		try { this.posthog?.track(approved ? 'Division Airport Request Approved' : 'Division Airport Request Rejected', { airportId, approvedBy, approved }); } catch { }
		return airport;
	}

	async getDivisionAirports(divisionId: number): Promise<DivisionAirport[]> {
		const result = await this.dbSession.executeRead<DivisionAirport>(
			'SELECT * FROM division_airports WHERE division_id = ?',
			[divisionId]
		);
		return result.results;
	}

	async getDivisionMembers(divisionId: number): Promise<DivisionMember[]> {
		const result = await this.dbSession.executeRead<DivisionMember>(
			'SELECT * FROM division_members WHERE division_id = ?',
			[divisionId]
		);
		return result.results;
	}

	async getAllDivisions(): Promise<Division[]> {
		const result = await this.dbSession.executeRead<Division>(
			'SELECT * FROM divisions'
		);
		return result.results;
	}

	async getUserDivisions(vatsimId: string): Promise<{ division: Division; role: string }[]> {
		const result = await this.dbSession.executeRead<{ division: Division; role: string }>(
			`
            SELECT d.*, dm.role 
            FROM divisions d 
            JOIN division_members dm ON d.id = dm.division_id 
            WHERE dm.vatsim_id = ?
        `,
			[vatsimId]
		);
		return result.results;
	}
	async userHasAirportAccess(userId: string, airportIcao: string): Promise<boolean> {
		const result = await this.dbSession.executeRead<any>(
			`
          SELECT da.id 
          FROM division_airports da
          JOIN division_members dm ON da.division_id = dm.division_id
          WHERE dm.vatsim_id = ? AND da.icao = ? AND da.status = 'approved'
        `,
			[userId, airportIcao]
		);

		return result.results.length > 0;
	}

	async getUserRoleForAirport(userId: string, airportIcao: string): Promise<'nav_head' | 'nav_member' | null> {
		const result = await this.dbSession.executeRead<{ role: 'nav_head' | 'nav_member' }>(
			`
            SELECT dm.role 
            FROM division_members dm
            JOIN division_airports da ON da.division_id = dm.division_id
            WHERE dm.vatsim_id = ? 
            AND da.icao = ? 
            AND da.status = 'approved'
            LIMIT 1
        `,
			[userId, airportIcao]
		);

		return result.results[0]?.role || null;
	}
}
