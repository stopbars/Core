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
	has_objects: boolean;
	created_at: string;
	updated_at: string;
}

type DivisionAirportWithDivision = DivisionAirport & {
	division_name: string;
};

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
		const existingRole = await this.getMemberRole(divisionId, vatsimId);
		if (existingRole) {
			throw new HttpError(409, 'User is already a member of this division');
		}

		try {
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
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes('UNIQUE constraint failed: division_members.division_id, division_members.vatsim_id')) {
				throw new HttpError(409, 'User is already a member of this division');
			}
			throw error;
		}
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

	async deleteAirportRequest(
		divisionId: number,
		airportId: number,
		requesterId: string,
		requesterRole: 'nav_head' | 'nav_member',
	): Promise<boolean> {
		const existingResult = await this.dbSession.executeRead<DivisionAirport>(
			`SELECT * FROM division_airports WHERE id = ? AND division_id = ?`,
			[airportId, divisionId],
		);

		const existing = existingResult.results[0];
		if (!existing) {
			throw new HttpError(404, 'Airport request not found');
		}

		const deletableStatuses: Array<DivisionAirport['status']> = ['pending', 'rejected'];
		if (!deletableStatuses.includes(existing.status)) {
			throw new HttpError(400, 'Only pending or rejected requests can be deleted');
		}

		const isOwner = existing.requested_by === requesterId;
		if (!isOwner && requesterRole !== 'nav_head') {
			throw new HttpError(403, 'Forbidden: Only the requester or division head can delete this request');
		}

		const deleteResult = await this.dbSession.executeWrite(
			'DELETE FROM division_airports WHERE id = ? AND status IN (?, ?) RETURNING id',
			[airportId, 'pending', 'rejected'],
		);

		const deleted = !!(deleteResult.results && (deleteResult.results as Array<{ id: number }>)[0]);
		if (deleted) {
			try {
				this.posthog?.track('Division Airport Request Deleted', {
					airportId,
					divisionId,
					requesterId,
				});
			} catch (e) {
				console.warn('Posthog track failed (Division Airport Request Deleted)', e);
			}
		}

		return deleted;
	}

	async getDivisionAirports(divisionId: number): Promise<DivisionAirport[] | null> {
		type DivisionAirportRow = {
			division_exists: number | null;
			id: number | null;
			division_id: number | null;
			icao: string | null;
			status: 'pending' | 'approved' | 'rejected' | null;
			requested_by: string | null;
			approved_by?: string | null;
			has_objects: number | null;
			created_at: string | null;
			updated_at: string | null;
		};

		const result = await this.dbSession.executeRead<DivisionAirportRow>(
			`SELECT
				d.id AS division_exists,
				da.id,
				da.division_id,
				da.icao,
				da.status,
				da.requested_by,
				da.approved_by,
				CASE
					WHEN po.airport_id IS NOT NULL THEN 1
					ELSE 0
				END AS has_objects,
				da.created_at,
				da.updated_at
			FROM divisions d
			LEFT JOIN division_airports da ON da.division_id = d.id
			LEFT JOIN (
				SELECT DISTINCT airport_id FROM points
			) po ON po.airport_id = da.icao
			WHERE d.id = ?
			ORDER BY da.created_at DESC`,
			[divisionId],
		);

		if (result.results.length === 0) {
			return null;
		}

		return result.results
			.filter(
				(
					row,
				): row is DivisionAirportRow & {
					id: number;
					division_id: number;
					icao: string;
					status: 'pending' | 'approved' | 'rejected';
					requested_by: string;
					has_objects: number;
					created_at: string;
					updated_at: string;
				} =>
					row.id !== null &&
					row.division_id !== null &&
					row.icao !== null &&
					row.status !== null &&
					row.requested_by !== null &&
					row.has_objects !== null &&
					row.created_at !== null &&
					row.updated_at !== null,
			)
			.map((row) => ({
				id: row.id,
				division_id: row.division_id,
				icao: row.icao,
				status: row.status,
				requested_by: row.requested_by,
				approved_by: row.approved_by ?? undefined,
				has_objects: row.has_objects === 1,
				created_at: row.created_at,
				updated_at: row.updated_at,
			}));
	}

	async getAllDivisionAirports(): Promise<DivisionAirportWithDivision[]> {
		const result = await this.dbSession.executeRead<
			Omit<DivisionAirportWithDivision, 'has_objects'> & {
				division_name: string | null;
				has_objects: number | null;
			}
		>(
			`SELECT
				da.id,
				da.division_id,
				d.name AS division_name,
				da.icao,
				da.status,
				da.requested_by,
				da.approved_by,
				CASE
					WHEN po.airport_id IS NOT NULL THEN 1
					ELSE 0
				END AS has_objects,
				da.created_at,
				da.updated_at
			FROM division_airports da
			JOIN divisions d ON d.id = da.division_id
			LEFT JOIN (
				SELECT DISTINCT airport_id FROM points
			) po ON po.airport_id = da.icao
			ORDER BY d.name ASC, da.created_at DESC`,
		);

		return result.results.map((row) => ({
			id: row.id,
			division_id: row.division_id,
			division_name: row.division_name ?? '',
			icao: row.icao,
			status: row.status,
			requested_by: row.requested_by,
			approved_by: row.approved_by ?? undefined,
			has_objects: row.has_objects === 1,
			created_at: row.created_at,
			updated_at: row.updated_at,
		}));
	}

	async getDivisionMembers(divisionId: number): Promise<(DivisionMember & { display_name: string })[] | null> {
		type DivisionMemberRow = {
			division_exists: number | null;
			id: number | null;
			division_id: number | null;
			vatsim_id: string | null;
			role: 'nav_head' | 'nav_member' | null;
			created_at: string | null;
			display_name: string | null;
		};

		const result = await this.dbSession.executeRead<DivisionMemberRow>(
			`SELECT
					d.id AS division_exists,
					dm.id,
					dm.division_id,
					dm.vatsim_id,
					dm.role,
					dm.created_at,
					COALESCE(u.display_name, dm.vatsim_id) AS display_name
				FROM divisions d
				LEFT JOIN division_members dm ON dm.division_id = d.id
				LEFT JOIN users u ON u.vatsim_id = dm.vatsim_id
				WHERE d.id = ?
				ORDER BY dm.created_at DESC`,
			[divisionId],
		);

		if (result.results.length === 0) {
			return null;
		}

		return result.results
			.filter(
				(
					row,
				): row is DivisionMemberRow & {
					id: number;
					division_id: number;
					vatsim_id: string;
					role: 'nav_head' | 'nav_member';
					created_at: string;
					display_name: string | null;
				} => row.id !== null && row.division_id !== null && row.role !== null && row.vatsim_id !== null && row.created_at !== null,
			)
			.map((row) => ({
				id: row.id,
				division_id: row.division_id,
				vatsim_id: row.vatsim_id,
				role: row.role,
				created_at: row.created_at,
				display_name: row.display_name ?? row.vatsim_id,
			}));
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
