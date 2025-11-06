import { IDService } from './id';
import { DivisionService } from './divisions';
import { AuthService } from './auth';
import { HttpError } from './errors';
import { Point, PointChangeset, PointData } from '../types';
import { PostHogService } from './posthog';

import { DatabaseSessionService, PreparedStatement } from './database-session';

type PointRow = {
	id: string;
	airport_id: string;
	type: Point['type'];
	name: string;
	coordinates: string;
	directionality: Point['directionality'] | null;
	orientation: string | null;
	color: Point['color'] | null;
	elevated: number | boolean | null;
	ihp: number | boolean | null;
	created_at: string;
	updated_at: string;
	created_by: string;
};

export class PointsService {
	private dbSession: DatabaseSessionService;

	private static isCoordinate(value: unknown): value is { lat: number; lng: number } {
		if (!value || typeof value !== 'object') return false;
		const obj = value as Record<string, unknown>;
		return (
			Object.prototype.hasOwnProperty.call(obj, 'lat') &&
			Object.prototype.hasOwnProperty.call(obj, 'lng') &&
			typeof obj.lat === 'number' &&
			typeof obj.lng === 'number' &&
			obj.lat >= -90 &&
			obj.lat <= 90 &&
			obj.lng >= -180 &&
			obj.lng <= 180
		);
	}

	private static isCoordinateArray(value: unknown): value is Array<{ lat: number; lng: number }> {
		return Array.isArray(value) && value.length > 0 && value.every((v) => PointsService.isCoordinate(v));
	}

	private stmtSelect: PreparedStatement<{
		id: string;
		airportId: string;
	}>;
	private stmtUpdate: PreparedStatement<{
		id: string;
		airportId: string;
		// properties here are required-nullable instead of optional as in `Point`
		type: Point['type'];
		name: string;
		coordinates: string;
		directionality: null | Required<Point>['directionality'];
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
				type, name, coordinates, directionality, color, elevated, ihp
				FROM points
				WHERE id = ? AND airport_id = ?;`,
			['id', 'airportId'],
		);
		this.stmtUpdate = this.dbSession.prepare(
			`UPDATE points
				SET
					type           = ?,
					name           = ?,
					coordinates    = ?,
					directionality = ?,
					color          = ?,
					elevated       = ?,
					ihp            = ?,
					updated_at     = CURRENT_TIMESTAMP
				WHERE id = ? AND airport_id = ?;`,
			['type', 'name', 'coordinates', 'directionality', 'color', 'elevated', 'ihp', 'id', 'airportId'],
		);
		this.stmtDelete = this.dbSession.prepare('DELETE FROM points WHERE id = ? AND airport_id = ?;', ['id', 'airportId']);
	}

	async createPoint(airportId: string, userId: string, point: PointData): Promise<Point> {
		// Check if user has permission for this airport
		const hasDivisionAccess = await this.divisions.userHasAirportAccess(userId, airportId);
		if (!hasDivisionAccess) {
			throw new HttpError(403, 'Forbidden: You do not have permission to modify this airport');
		}

		// Validate and normalize point data (coordinates array)
		this.validatePoint(point);

		const now = new Date().toISOString();
		const newPoint: Point = {
			...point,
			id: '',
			airportId,
			createdAt: now,
			updatedAt: now,
			createdBy: userId,
		};

		// Insert into database
		let inserted = false;
		for (let attempt = 0; attempt < 8; attempt++) {
			const barsId = await this.idService.generateBarsId();
			try {
				await this.dbSession.executeWrite(
					`
		INSERT INTO points (
			id, airport_id, type, name, coordinates, directionality,
			color, elevated, ihp, created_at, updated_at, created_by
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
					[
						barsId,
						airportId,
						newPoint.type,
						newPoint.name,
						JSON.stringify(newPoint.coordinates),
						newPoint.directionality || null,
						newPoint.color || null,
						newPoint.elevated || false,
						newPoint.ihp || false,
						newPoint.createdAt,
						newPoint.updatedAt,
						newPoint.createdBy,
					],
				);

				newPoint.id = barsId;
				inserted = true;
				break;
			} catch (e) {
				if (!this.isUniqueConstraintError(e)) {
					throw e;
				}
				console.warn(`Attempt ${attempt + 1} to create point with unique ID failed`, e);
			}
		}
		if (!inserted) {
			throw new HttpError(500, 'Failed to create point with unique ID');
		}

		try {
			this.posthog?.track('Point Created', { airportId, userId, type: point.type });
		} catch (e) {
			console.warn('Posthog track failed (Point Created)', e);
		}
		return newPoint;
	}
	async updatePoint(pointId: string, userId: string, updates: Partial<PointData>): Promise<Point> {
		// Get existing point
		const point = await this.getPoint(pointId);
		if (!point) {
			throw new HttpError(404, 'Point not found');
		}

		// Check permissions
		const hasDivisionAccess = await this.divisions.userHasAirportAccess(userId, point.airportId);
		if (!hasDivisionAccess) {
			throw new HttpError(403, 'Forbidden: You do not have permission to modify this point');
		}

		// Validate updates
		const mergedPoint = { ...point, ...updates } as PointData;
		this.validatePoint(mergedPoint);

		// Define allowed fields for updates
		const allowedFields = ['type', 'name', 'coordinates', 'directionality', 'color', 'elevated', 'ihp'];
		const processedUpdates: Record<string, string | number | boolean | null> = {};
		Object.entries(updates).forEach(([key, value]) => {
			if (allowedFields.includes(key)) {
				if (key === 'coordinates') {
					processedUpdates[key] = JSON.stringify((mergedPoint as PointData).coordinates);
				} else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
					processedUpdates[key] = value;
				} else if (value == null) {
					processedUpdates[key] = null;
				}
			}
		});
		if (Object.keys(processedUpdates).length === 0) {
			return point;
		}
		const fieldMappings: Record<string, string> = {
			type: 'type',
			name: 'name',
			coordinates: 'coordinates',
			directionality: 'directionality',
			color: 'color',
			elevated: 'elevated',
			ihp: 'ihp',
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
			[...Object.values(processedUpdates), new Date().toISOString(), pointId],
		);

		const finalPoint = (await this.getPoint(pointId)) as Point;
		try {
			this.posthog?.track('Point Updated', {
				pointId,
				airportId: finalPoint.airportId,
				userId,
				fields: Object.keys(processedUpdates),
			});
		} catch (e) {
			console.warn('Posthog track failed (Point Updated)', e);
		}
		return finalPoint;
	}

	async deletePoint(pointId: string, userId: string): Promise<void> {
		// Get point to check permissions
		const point = await this.getPoint(pointId);
		if (!point) {
			throw new HttpError(404, 'Point not found');
		}

		// Check basic airport access permissions
		const hasDivisionAccess = await this.divisions.userHasAirportAccess(userId, point.airportId);
		if (!hasDivisionAccess) {
			throw new HttpError(403, 'Forbidden: You do not have permission to delete this point');
		}

		// Delete from database
		await this.dbSession.executeWrite('DELETE FROM points WHERE id = ?', [pointId]);
		try {
			this.posthog?.track('Point Deleted', { pointId, airportId: point.airportId, userId });
		} catch (e) {
			console.warn('Posthog track failed (Point Deleted)', e);
		}
	}

	async applyChangeset(airportId: string, userId: string, changeset: PointChangeset): Promise<Point[]> {
		const hasDivisionAccess = await this.divisions.userHasAirportAccess(userId, airportId);
		if (!hasDivisionAccess) {
			throw new HttpError(403, 'Forbidden: You do not have permission to apply this changeset');
		}

		const modifyEntries = Object.entries(changeset.modify ?? {});
		const selects = modifyEntries.map(([id]) => this.stmtSelect.bindAll({ id, airportId }));
		const selectResults = await this.dbSession.executeBatch(selects);
		const modifiedPoints = selectResults
			.map((result) => {
				const rows = result.results as unknown as PointRow[] | null;
				const first = rows && rows[0];
				if (!first) {
					throw new HttpError(404, 'Point targeted by modify operation does not exist');
				}
				return this.mapPointFromDb(first) as PointData;
			})
			.map((basis, index) => {
				const [id, patch] = modifyEntries[index];
				return {
					...basis,
					...patch,
					id,
				};
			});

		for (const point of changeset.create ?? []) {
			this.validatePoint(point);
		}
		for (const point of modifiedPoints) {
			this.validatePoint(point);
		}

		const now = new Date().toISOString();

		const createdPoints: Point[] = [];
		for (const data of changeset.create ?? []) {
			const point: Point = {
				...data,
				id: '',
				airportId,
				createdAt: now,
				updatedAt: now,
				createdBy: userId,
			};
			let inserted = false;
			for (let attempt = 0; attempt < 8; attempt++) {
				const barsId = await this.idService.generateBarsId();
				try {
					await this.dbSession.executeWrite(
						`
						INSERT INTO points (
							id, airport_id, type, name, coordinates, directionality,
							color, elevated, ihp, created_at, updated_at, created_by
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						`,
						[
							barsId,
							airportId,
							point.type,
							point.name,
							JSON.stringify(point.coordinates),
							point.directionality || null,
							point.color || null,
							point.elevated || false,
							point.ihp || false,
							point.createdAt,
							point.updatedAt,
							point.createdBy,
						],
					);

					point.id = barsId;
					createdPoints.push(point);
					inserted = true;
					break;
				} catch (e) {
					if (!this.isUniqueConstraintError(e)) {
						throw e;
					}
					console.warn(`Attempt ${attempt + 1} to create point with unique ID failed`, e);
				}
			}
			if (!inserted) {
				throw new HttpError(500, 'Failed to create point with unique ID');
			}
		}
		const updates = modifiedPoints.map((point) =>
			this.stmtUpdate.bindAll({
				id: point.id,
				airportId,
				type: point.type ?? null,
				name: point.name ?? null,
				coordinates: JSON.stringify(point.coordinates),
				directionality: point.directionality ?? null,
				color: point.color ?? null,
				elevated: point.elevated ?? null,
				ihp: point.ihp ?? null,
			}),
		);
		const deletes = (changeset.delete ?? []).map((id) => this.stmtDelete.bindAll({ id, airportId }));

		await this.dbSession.executeBatch(updates.concat(deletes));

		try {
			this.posthog?.track('Points Changeset Applied', {
				airportId,
				userId,
				created: createdPoints.length,
				modified: modifiedPoints.length,
				deleted: (changeset.delete ?? []).length,
			});
		} catch (e) {
			console.warn('Posthog track failed (Points Changeset Applied)', e);
		}
		return createdPoints;
	}

	async getPoint(pointId: string): Promise<Point | null> {
		const result = await this.dbSession.executeRead<PointRow>('SELECT * FROM points WHERE id = ?', [pointId]);
		const row = result.results[0];
		if (!row) return null;
		return this.mapPointFromDb(row);
	}

	async getAirportPoints(airportId: string): Promise<Point[]> {
		const results = await this.dbSession.executeRead<PointRow>('SELECT * FROM points WHERE airport_id = ?', [airportId]);
		return results.results.map((r) => this.mapPointFromDb(r));
	}

	private isUniqueConstraintError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false;
		}
		const msg = error.message.toLowerCase();
		return msg.includes('unique constraint failed') || msg.includes('constraint failed') || msg.includes('sqlite_constraint');
	}

	private validatePoint(point: PointData) {
		// Normalize coordinates: accept either legacy single object or array of objects
		const rawCoords: unknown = (point as unknown as { coordinates?: unknown }).coordinates;
		if (rawCoords === undefined || rawCoords === null) throw new HttpError(400, 'Point must have coordinates');

		let arr: Array<{ lat: number; lng: number }>;
		if (PointsService.isCoordinateArray(rawCoords)) {
			arr = rawCoords;
		} else if (PointsService.isCoordinate(rawCoords)) {
			arr = [rawCoords];
		} else {
			throw new HttpError(400, 'Invalid coordinates format');
		}

		if (arr.length < 1) {
			throw new HttpError(400, 'Coordinates must contain at least one point');
		}
		(point as PointData).coordinates = arr as { lat: number; lng: number }[];

		// Validate type-specific fields
		if (point.type === 'stopbar') {
			if (!point.directionality) {
				throw new HttpError(400, 'Stopbar must have directionality specified');
			}

			if (point.elevated) {
				if (point.directionality !== 'uni-directional') {
					throw new HttpError(400, 'Stopbar with elevated property must be uni-directional');
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
					throw new HttpError(400, 'Elevated property must be a boolean when specified');
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
					throw new HttpError(400, 'IHP property must be a boolean when specified');
				}
			}
		}
		if (point.type === 'taxiway') {
			if (!point.directionality) {
				throw new HttpError(400, 'Taxiway must have directionality specified');
			}

			if (point.color === undefined) {
				throw new HttpError(400, 'Taxiway must have color specified');
			}
		}

		// Validate name
		if (!point.name || point.name.trim().length === 0) {
			throw new HttpError(400, 'Point must have a name');
		}
	}

	private mapPointFromDb(dbPoint: PointRow): Point {
		let raw: unknown;
		try {
			raw = JSON.parse(dbPoint.coordinates);
		} catch {
			raw = null;
		}
		let coordinates: Array<{ lat: number; lng: number }> = [];
		if (PointsService.isCoordinateArray(raw)) {
			coordinates = raw;
		} else if (PointsService.isCoordinate(raw)) {
			coordinates = [raw];
		}
		return {
			id: dbPoint.id,
			airportId: dbPoint.airport_id,
			type: dbPoint.type,
			name: dbPoint.name,
			coordinates,
			directionality: dbPoint.directionality ?? undefined,
			color: dbPoint.color ?? undefined,
			elevated: dbPoint.elevated === 1 || dbPoint.elevated === true,
			ihp: dbPoint.ihp === 1 || dbPoint.ihp === true,
			createdAt: dbPoint.created_at,
			updatedAt: dbPoint.updated_at,
			createdBy: dbPoint.created_by,
		};
	}
}
