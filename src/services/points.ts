import { IDService } from './id';
import { DivisionService } from './divisions';
import { AuthService } from './auth';
import { Point } from '../types';

export class PointsService {
	constructor(
		private db: D1Database,
		private idService: IDService,
		private divisions: DivisionService,
		private auth: AuthService,
	) {}

	async createPoint(
		airportId: string,
		userId: string,
		point: Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>,
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
			createdAt: now,
			updatedAt: now,
			createdBy: userId,
		};

		// Insert into database
		await this.db
			.prepare(
				`
      INSERT INTO points (
        id, airport_id, type, name, coordinates, directionality, 
        orientation, color, elevated, ihp, created_at, updated_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
			)
			.bind(
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
			)
			.run();

		return newPoint;
	}

	async updatePoint(
		pointId: string,
		userId: string,
		updates: Partial<Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>>,
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
		const updatedPoint = { ...point, ...updates };
		this.validatePoint(updatedPoint);

		// Prepare updates with serialized coordinates
		const processedUpdates: Record<string, any> = {};
		Object.entries(updates).forEach(([key, value]) => {
			processedUpdates[key] = key === 'coordinates' ? JSON.stringify(value) : value;
		});

		// Update in database
		const updateFields = Object.keys(processedUpdates)
			.map((field) => `${this.toSnakeCase(field)} = ?`)
			.join(', ');

		await this.db
			.prepare(
				`
      UPDATE points 
      SET ${updateFields}, updated_at = ? 
      WHERE id = ?
    `,
			)
			.bind(...Object.values(processedUpdates), new Date().toISOString(), pointId)
			.run();

		return this.getPoint(pointId) as Promise<Point>;
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

		// Get the user's role in the division
		const divisionRole = await this.divisions.getUserRoleForAirport(userId, point.airportId);
		if (divisionRole !== 'nav_head') {
			throw new Error('Only NAV HEAD members can delete points');
		}

		// Delete from database
		await this.db.prepare('DELETE FROM points WHERE id = ?').bind(pointId).run();
	}

	async getPoint(pointId: string): Promise<Point | null> {
		const result = await this.db.prepare('SELECT * FROM points WHERE id = ?').bind(pointId).first();

		if (!result) return null;

		return this.mapPointFromDb(result);
	}

	async getAirportPoints(airportId: string): Promise<Point[]> {
		const results = await this.db.prepare('SELECT * FROM points WHERE airport_id = ?').bind(airportId).all();

		return results.results.map(this.mapPointFromDb);
	}

	private validatePoint(point: Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>) {
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

	private toSnakeCase(str: string): string {
		return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
	}
}
