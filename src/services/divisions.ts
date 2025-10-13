import { DatabaseSessionService } from './database-session';
import { HttpError } from './errors';
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

	constructor(
		private db: D1Database,
		private posthog?: PostHogService,
	) {
		this.dbSession = new DatabaseSessionService(db);
	}

	async createDivision(name: string, headVatsimId: string): Promise<Division> {
		const result = await this.dbSession.executeWrite('INSERT INTO divisions (name) VALUES (?) RETURNING *', [name]);
		const rows = result.results as unknown as Division[] | null;
		const division = rows && rows[0];
		if (!division) throw new Error('Failed to create division');

		await this.addMember(division.id, headVatsimId, 'nav_head');
		try {
			this.posthog?.track('Division Created', { divisionId: division.id, name });
		} catch (e) {
			console.warn('Posthog track failed (Division Created)', e);
		}

		return division;
	}

	async updateDivisionName(id: number, newName: string): Promise<Division> {
		const result = await this.dbSession.executeWrite('UPDATE divisions SET name = ? WHERE id = ? RETURNING *', [newName, id]);
		const rows = result.results as unknown as Division[] | null;
		const division = rows && rows[0];
		if (!division) throw new Error('Division not found');
		try {
			this.posthog?.track('Division Renamed', { divisionId: id, name: newName });
		} catch (e) {
			console.warn('Posthog track failed (Division Renamed)', e);
		}
		return division;
	}

	async deleteDivision(id: number): Promise<boolean> {
		const result = await this.dbSession.executeWrite('DELETE FROM divisions WHERE id = ? RETURNING id', [id]);
		const rows = result.results as unknown as Array<{ id: number }> | null;
		const deleted = !!(rows && rows[0]);
		if (deleted) {
			try {
				this.posthog?.track('Division Deleted', { divisionId: id });
			} catch (e) {
				console.warn('Posthog track failed (Division Deleted)', e);
			}
		}
		return deleted;
	}

	async getDivision(id: number): Promise<Division | null> {
		const result = await this.dbSession.executeRead<Division>('SELECT * FROM divisions WHERE id = ?', [id]);
		return result.results[0] || null;
	}

	async addMember(divisionId: number, vatsimId: string, role: 'nav_head' | 'nav_member'): Promise<DivisionMember> {
		const result = await this.dbSession.executeWrite(
			'INSERT INTO division_members (division_id, vatsim_id, role) VALUES (?, ?, ?) RETURNING *',
			[divisionId, vatsimId, role],
		);

		const rows = result.results as unknown as DivisionMember[] | null;
		const member = rows && rows[0];
		if (!member) throw new Error('Failed to add member to division');
		try {
			this.posthog?.track('Division Member Added', { divisionId, vatsimId, role });
		} catch (e) {
			console.warn('Posthog track failed (Division Member Added)', e);
		}
		return member;
	}

	async removeMember(divisionId: number, vatsimId: string): Promise<void> {
		await this.dbSession.executeWrite('DELETE FROM division_members WHERE division_id = ? AND vatsim_id = ?', [divisionId, vatsimId]);
		try {
			this.posthog?.track('Division Member Removed', { divisionId, vatsimId });
		} catch (e) {
			console.warn('Posthog track failed (Division Member Removed)', e);
		}
	}

	async getMemberRole(divisionId: number, vatsimId: string): Promise<'nav_head' | 'nav_member' | null> {
		const result = await this.dbSession.executeRead<{ role: 'nav_head' | 'nav_member' }>(
			'SELECT role FROM division_members WHERE division_id = ? AND vatsim_id = ?',
			[divisionId, vatsimId],
		);

		return result.results[0]?.role || null;
	}
	async requestAirport(divisionId: number, icao: string, requestedBy: string): Promise<DivisionAirport> {
		const role = await this.getMemberRole(divisionId, requestedBy);
		if (!role) throw new HttpError(403, 'Forbidden: User is not a member of this division');

		const result = await this.dbSession.executeWrite(
			'INSERT INTO division_airports (division_id, icao, requested_by) VALUES (?, ?, ?) RETURNING *',
			[divisionId, icao, requestedBy],
		);

		const rows = result.results as unknown as DivisionAirport[] | null;
		const request = rows && rows[0];
		if (!request) throw new Error('Failed to create airport request');
		try {
			this.posthog?.track('Division Airport Access Requested', { divisionId, icao, requestedBy });
		} catch (e) {
			console.warn('Posthog track failed (Division Airport Access Requested)', e);
		}
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
			[approved ? 'approved' : 'rejected', approvedBy, airportId],
		);

		const rows = result.results as unknown as DivisionAirport[] | null;
		const airport = rows && rows[0];
		if (!airport) throw new Error('Airport request not found');
		try {
			this.posthog?.track(approved ? 'Division Airport Request Approved' : 'Division Airport Request Rejected', {
				airportId,
				approvedBy,
				approved,
			});
		} catch (e) {
			console.warn('Posthog track failed (Approve Airport)', e);
		}
		return airport;
	}

	async getDivisionAirports(divisionId: number): Promise<DivisionAirport[]> {
		const result = await this.dbSession.executeRead<DivisionAirport>('SELECT * FROM division_airports WHERE division_id = ?', [
			divisionId,
		]);
		return result.results;
	}

	async getDivisionMembers(divisionId: number): Promise<(DivisionMember & { display_name: string })[]> {
		// Use cached display_name; fallback to vatsim_id if null
		const result = await this.dbSession.executeRead<DivisionMember & { display_name: string }>(
			`SELECT dm.id, dm.division_id, dm.vatsim_id, dm.role, dm.created_at,
			COALESCE(u.display_name, dm.vatsim_id) AS display_name
			FROM division_members dm
			LEFT JOIN users u ON u.vatsim_id = dm.vatsim_id
			WHERE dm.division_id = ?`,
			[divisionId],
		);
		return result.results;
	}

	async getAllDivisions(): Promise<Division[]> {
		const result = await this.dbSession.executeRead<Division>('SELECT * FROM divisions');
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
			[vatsimId],
		);
		return result.results;
	}
	async userHasAirportAccess(userId: string, airportIcao: string): Promise<boolean> {
		const result = await this.dbSession.executeRead<{ id: number }>(
			`
          SELECT da.id 
          FROM division_airports da
          JOIN division_members dm ON da.division_id = dm.division_id
          WHERE dm.vatsim_id = ? AND da.icao = ? AND da.status = 'approved'
        `,
			[userId, airportIcao],
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
			[userId, airportIcao],
		);

		return result.results[0]?.role || null;
	}
}
