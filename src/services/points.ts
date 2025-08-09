import { IDService } from './id';
import { DivisionService } from './divisions';
import { AuthService } from './auth';
import { Point, PointChangeset, PointData } from '../types';
import { PostHogService } from './posthog';

import { DatabaseSessionService, PreparedStatement } from './database-session';

export class PointsService {
	private dbSession: DatabaseSessionService;

	private stmtSelect: PreparedStatement<{
		id: string;
		airportId: string;
	}>;
	private stmtInsert: PreparedStatement<{
		coordinates: string;
		createdAt: string;
	} & Omit<Point, 'coordinates' | 'createdAt' | 'updatedAt'>>;
	private stmtUpdate: PreparedStatement<{
		id: string;
		airportId: string;
		// properties here are required-nullable instead of optional as in `Point`
		type: Point['type'];
		name: string;
		coordinates: string;
		directionality: null | Required<Point>['directionality'];
		orientation: null | Required<Point>['orientation'];
		color: null | Required<Point>['color'];
		elevated: null | boolean;
		ihp: null | boolean;
	}>;
	private stmtDelete: PreparedStatement<{
		id: string;
		airportId: string;
	}>;

	constructor(
		private db: D1Database,
		private idService: IDService,
		private divisions: DivisionService,
		private auth: AuthService,
		private posthog?: PostHogService,
	) {
		this.dbSession = new DatabaseSessionService(db);

		this.stmtSelect = this.dbSession.prepare(
			`SELECT
				type, name, coordinates, directionality, orientation, color, elevated, ihp
				FROM points
				WHERE id = ? AND airport_id = ?;`,
			['id', 'airportId']
		);
		this.stmtInsert = this.dbSession.prepare(
			`INSERT
				INTO points (
					id, airport_id, type, name, coordinates, directionality, orientation,
					color, elevated, ihp, created_at, updated_at, created_by
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
			[
				'id', 'airportId', 'type', 'name', 'coordinates', 'directionality',
				'orientation', 'color', 'elevated', 'ihp', 'createdAt', 'createdAt',
				'createdBy'
			]
		);
		this.stmtUpdate = this.dbSession.prepare(
			`UPDATE points
				SET
					type           = ?,
					name           = ?,
					coordinates    = ?,
					directionality = ?,
					orientation    = ?,
					color          = ?,
					elevated       = ?,
					ihp            = ?,
					updated_at     = CURRENT_TIMESTAMP
				WHERE id = ? AND airport_id = ?;`,
			[
				'type', 'name', 'coordinates', 'directionality', 'orientation', 'color',
				'elevated', 'ihp', 'id', 'airportId'
			]
		);
		this.stmtDelete = this.dbSession.prepare(
			'DELETE FROM points WHERE id = ? AND airport_id = ?;',
			['id', 'airportId']
		);
	}

	async createPoint(
		airportId: string,
		userId: string,
		point: PointData,
	): Promise<Point> {
		// Check if user has permission for this airport
		const hasDivisionAccess = await this.divisions.userHasAirportAccess(userId, airportId);
		if (!hasDivisionAccess) {
			throw new Error('User does not have permission to modify this airport');
		}

		// Generate unique BARS ID
		const barsId = await this.idService.generateBarsId();

		// Validate point data
		this.validatePoint(point);

		const now = new Date().toISOString();
		const newPoint: Point = {
			...point,
			id: barsId,
			airportId,
			createdAt: now,
			updatedAt: now,
			createdBy: userId,
		};

		// Insert into database
		await this.dbSession.executeWrite(
			`
				INSERT INTO points (
				id, airport_id, type, name, coordinates, directionality,
				orientation, color, elevated, ihp, created_at, updated_at, created_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
			[
				newPoint.id,
				airportId,
				newPoint.type,
				newPoint.name,
				JSON.stringify(newPoint.coordinates),
				newPoint.directionality || null,
				newPoint.orientation || null,
				newPoint.color || null,
				newPoint.elevated || false,
				newPoint.ihp || false,
				newPoint.createdAt,
				newPoint.updatedAt,
				newPoint.createdBy,
			]
		);

		try { this.posthog?.track('Point Created', { airportId, userId, type: point.type }); } catch { }
		return newPoint;
	}
	async updatePoint(
		pointId: string,
		userId: string,
		updates: Partial<PointData>,
	): Promise<Point> {
		// Get existing point
		const point = await this.getPoint(pointId);
		if (!point) {
			throw new Error('Point not found');
		}

		// Check permissions
		const hasDivisionAccess = await this.divisions.userHasAirportAccess(userId, point.airportId);
		if (!hasDivisionAccess) {
			throw new Error('User does not have permission to modify this point');
		}

		// Validate updates
		const mergedPoint = { ...point, ...updates };
		this.validatePoint(mergedPoint);

		// Define allowed fields for updates
		const allowedFields = [
			'type', 'name', 'coordinates', 'directionality',
			'orientation', 'color', 'elevated', 'ihp'
		];
		const processedUpdates: Record<string, any> = {};
		Object.entries(updates).forEach(([key, value]) => {
			if (allowedFields.includes(key)) {
				processedUpdates[key] = key === 'coordinates' ? JSON.stringify(value) : value;
			}
		});
		if (Object.keys(processedUpdates).length === 0) {
			return this.getPoint(pointId) as Promise<Point>;
		}
		const fieldMappings: Record<string, string> = {
			'type': 'type',
			'name': 'name',
			'coordinates': 'coordinates',
			'directionality': 'directionality',
			'orientation': 'orientation',
			'color': 'color',
			'elevated': 'elevated',
			'ihp': 'ihp'
		};

		const updateFields = Object.keys(processedUpdates)
			.map((field) => `${fieldMappings[field]} = ?`)
			.join(', ');

		await this.dbSession.executeWrite(
			`
			UPDATE points
			SET ${updateFields}, updated_at = ?
			WHERE id = ?
			`,
			[...Object.values(processedUpdates), new Date().toISOString(), pointId]
		);

		const finalPoint = await this.getPoint(pointId) as Point;
		try { this.posthog?.track('Point Updated', { pointId, airportId: finalPoint.airportId, userId, fields: Object.keys(processedUpdates) }); } catch { }
		return finalPoint;
	}

	async deletePoint(pointId: string, userId: string): Promise<void> {
		// Get point to check permissions
		const point = await this.getPoint(pointId);
		if (!point) {
			throw new Error('Point not found');
		}

		// Check basic airport access permissions
		const hasDivisionAccess = await this.divisions.userHasAirportAccess(userId, point.airportId);
		if (!hasDivisionAccess) {
			throw new Error('User does not have permission to delete this point');
		}

		// Delete from database
		await this.dbSession.executeWrite(
			'DELETE FROM points WHERE id = ?',
			[pointId]
		);
		try { this.posthog?.track('Point Deleted', { pointId, airportId: point.airportId, userId }); } catch { }
	}

	async applyChangeset(
		airportId: string,
		userId: string,
		changeset: PointChangeset
	): Promise<Point[]> {
		const hasDivisionAccess = await this.divisions.userHasAirportAccess(userId, airportId);
		if (!hasDivisionAccess) {
			throw new Error('User does not have permission to apply this changeset');
		}

		const selects = Object.keys(changeset.modify ?? {})
			.map((id) => this.stmtSelect.bindAll({ id, airportId }));
		const modifiedPoints = (await this.dbSession.executeBatch(selects))
			.map((result) => {
				if (!result.results || result.results.length === 0) {
					throw new Error('Point targeted by modify operation does not exist');
				}
				return this.mapPointFromDb(result.results[0]) as PointData;
			})
			.map((basis, i) => ({
				...basis,
				...Object.values(changeset.modify!)[i],
				id: Object.keys(changeset.modify!)[i],
			}));

		([] as PointData[])
			.concat(changeset.create ?? [])
			.concat(modifiedPoints)
			.forEach((point) => this.validatePoint(point));

		const now = new Date().toISOString();

		const createdPoints: Point[] = await Promise.all(
			(changeset.create ?? []).map(async (data) => ({
				...data,
				id: await this.idService.generateBarsId(),
				airportId,
				createdAt: now,
				updatedAt: now,
				createdBy: userId,
			}))
		);

		const inserts = createdPoints
			.map((point) => this.stmtInsert.bindAll({
				...point,
				coordinates: JSON.stringify(point.coordinates)
			}));
		const updates = modifiedPoints
			.map((point) => this.stmtUpdate.bindAll({
				id: point.id,
				airportId,
				type: point.type ?? null,
				name: point.name ?? null,
				coordinates: JSON.stringify(point.coordinates),
				directionality: point.directionality ?? null,
				orientation: point.orientation ?? null,
				color: point.color ?? null,
				elevated: point.elevated ?? null,
				ihp: point.ihp ?? null,
			}));
		const deletes = (changeset.delete ?? [])
			.map((id) => this.stmtDelete.bindAll({ id, airportId }));

		await this.dbSession.executeBatch(inserts.concat(updates).concat(deletes));

		try { this.posthog?.track('Points Changeset Applied', { airportId, userId, created: createdPoints.length, modified: modifiedPoints.length, deleted: (changeset.delete ?? []).length }); } catch { }
		return createdPoints;
	}

	async getPoint(pointId: string): Promise<Point | null> {
		const result = await this.dbSession.executeRead<any>(
			'SELECT * FROM points WHERE id = ?',
			[pointId]
		);
		if (!result.results[0]) return null;
		return this.mapPointFromDb(result.results[0]);
	}

	async getAirportPoints(airportId: string): Promise<Point[]> {
		const results = await this.dbSession.executeRead<any>(
			'SELECT * FROM points WHERE airport_id = ?',
			[airportId]
		);
		return results.results.map(this.mapPointFromDb);
	}

	private validatePoint(point: PointData) {
		// Validate coordinates format for single point
		if (!point.coordinates || typeof point.coordinates !== 'object') {
			throw new Error('Point must have coordinates');
		}

		const { lat, lng } = point.coordinates;
		if (typeof lat !== 'number' || typeof lng !== 'number') {
			throw new Error('Invalid coordinate format');
		}
		if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
			throw new Error('Coordinates out of valid range');
		}

		// Validate type-specific fields
		if (point.type === 'stopbar') {
			if (!point.directionality) {
				throw new Error('Stopbar must have directionality specified');
			}

			// For bi-directional stopbars, orientation should not be set
			if (point.directionality === 'bi-directional') {
				// Remove orientation if it exists
				delete point.orientation;
			} else if (point.directionality === 'uni-directional' && !point.orientation) {
				throw new Error('Uni-directional stopbar must have orientation specified');
			}

			if (point.elevated) {
				if (point.directionality !== 'uni-directional') {
					throw new Error('Stopbar with elevated property must be uni-directional');
				}
			}

			// elevated is optional for stopbars, defaulting to false
			if (point.elevated !== undefined) {
				// Convert numeric 1/0 to boolean if needed
				if (point.elevated === true || (point.elevated as unknown as number) === 1) {
					point.elevated = true;
				} else if (point.elevated === false || (point.elevated as unknown as number) === 0) {
					point.elevated = false;
				}

				if (typeof point.elevated !== 'boolean') {
					throw new Error('Elevated property must be a boolean when specified');
				}
			}

			if (point.ihp !== undefined) {
				// Convert numeric 1/0 to boolean if needed
				if (point.ihp === true || (point.ihp as unknown as number) === 1) {
					point.ihp = true;
				} else if (point.ihp === false || (point.ihp as unknown as number) === 0) {
					point.ihp = false;
				}

				if (typeof point.ihp !== 'boolean') {
					throw new Error('IHP property must be a boolean when specified');
				}
			}
		}
		if (point.type === 'taxiway') {
			if (!point.directionality) {
				throw new Error('Taxiway must have directionality specified');
			}

			if (point.color === undefined) {
				throw new Error('Taxiway must have color specified');
			}
		}

		// Validate name
		if (!point.name || point.name.trim().length === 0) {
			throw new Error('Point must have a name');
		}
	}

	private mapPointFromDb(dbPoint: any): Point {
		return {
			id: dbPoint.id,
			airportId: dbPoint.airport_id,
			type: dbPoint.type,
			name: dbPoint.name,
			coordinates: JSON.parse(dbPoint.coordinates),
			directionality: dbPoint.directionality,
			orientation: dbPoint.orientation,
			color: dbPoint.color,
			elevated: dbPoint.elevated || false,
			ihp: dbPoint.ihp || false,
			createdAt: dbPoint.created_at,
			updatedAt: dbPoint.updated_at,
			createdBy: dbPoint.created_by,
		};
	}
}
