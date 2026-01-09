import { IDService } from './id';
import { DivisionService } from './divisions';
import { HttpError } from './errors';
import { Point, PointChangeset, PointData } from '../types';
import { PostHogService } from './posthog';

import { DatabaseSessionService, PreparedStatement, DatabaseSerializable } from './database-session';

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
	linked_to: string | null;
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
	private stmtCheckPointId: PreparedStatement<{
		id: string;
	}>;
	private stmtGetLinkedLeadOns: PreparedStatement<{
		stopbarId: string;
	}>;

	constructor(
		private db: D1Database,
		private idService: IDService,
		private divisions: DivisionService,
		private posthog?: PostHogService,
	) {
		this.dbSession = new DatabaseSessionService(db);

		this.stmtSelect = this.dbSession.prepare(
			`SELECT
				type, name, coordinates, directionality, color, elevated, ihp, linked_to
				FROM points
				WHERE id = ? AND airport_id = ?;`,
			['id', 'airportId'],
		);
		this.stmtCheckPointId = this.dbSession.prepare('SELECT id FROM points WHERE id = ? LIMIT 1;', ['id']);
		this.stmtGetLinkedLeadOns = this.dbSession.prepare(
			'SELECT id FROM points WHERE linked_to = ? AND type = ?',
			['stopbarId'],
		);
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
		const [barsId] = await this.generatePointIds(1);
		const newPoint: Point = {
			...point,
			id: barsId,
			airportId,
			createdAt: now,
			updatedAt: now,
			createdBy: userId,
		};

		await this.dbSession.executeWrite(
			`
	INSERT INTO points (
		id, airport_id, type, name, coordinates, directionality,
		color, elevated, ihp, created_at, updated_at, created_by
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
			[
				newPoint.id,
				airportId,
				newPoint.type,
				newPoint.name,
				JSON.stringify(newPoint.coordinates),
				newPoint.directionality ?? null,
				newPoint.color ?? null,
				newPoint.elevated ?? false,
				newPoint.ihp ?? false,
				newPoint.createdAt,
				newPoint.updatedAt,
				newPoint.createdBy,
			],
		);

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
		const modifyContexts = modifyEntries.map(([id, patch], index) => {
			const rows = selectResults[index]?.results as unknown as PointRow[] | null;
			const first = rows && rows[0];
			if (!first) {
				throw new HttpError(404, 'Point targeted by modify operation does not exist');
			}
			const basePoint = this.mapPointFromDb(first);
			const merged: PointData = {
				type: patch.type ?? basePoint.type,
				name: patch.name ?? basePoint.name,
				coordinates: patch.coordinates ?? basePoint.coordinates,
				directionality: Object.prototype.hasOwnProperty.call(patch, 'directionality')
					? (patch.directionality ?? undefined)
					: basePoint.directionality,
				color: Object.prototype.hasOwnProperty.call(patch, 'color') ? (patch.color ?? undefined) : basePoint.color,
				elevated: Object.prototype.hasOwnProperty.call(patch, 'elevated') ? (patch.elevated ?? undefined) : basePoint.elevated,
				ihp: Object.prototype.hasOwnProperty.call(patch, 'ihp') ? (patch.ihp ?? undefined) : basePoint.ihp,
			};
			this.validatePoint(merged);
			return { id, patch, merged };
		});

		for (const point of changeset.create ?? []) {
			this.validatePoint(point);
		}

		const now = new Date().toISOString();
		const createdPoints: Point[] = [];
		const statements: Array<{ query: string; params: DatabaseSerializable[] }> = [];
		const createData = changeset.create ?? [];
		if (createData.length > 0) {
			const ids = await this.generatePointIds(createData.length);
			createData.forEach((data, index) => {
				const point: Point = {
					...data,
					id: ids[index],
					airportId,
					createdAt: now,
					updatedAt: now,
					createdBy: userId,
				};
				createdPoints.push(point);
				statements.push({
					query: `INSERT INTO points (
						id, airport_id, type, name, coordinates, directionality,
						color, elevated, ihp, created_at, updated_at, created_by
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					params: [
						point.id,
						airportId,
						point.type,
						point.name,
						JSON.stringify(point.coordinates),
						point.directionality ?? null,
						point.color ?? null,
						point.elevated ?? false,
						point.ihp ?? false,
						point.createdAt,
						point.updatedAt,
						point.createdBy,
					],
				});
			});
		}

		if (modifyContexts.length > 0) {
			const updateMappings: Array<{
				key: keyof PointData;
				column: string;
				resolver: (context: { patch: Partial<PointData>; merged: PointData }) => DatabaseSerializable;
			}> = [
					{ key: 'type', column: 'type', resolver: ({ merged }) => merged.type },
					{ key: 'name', column: 'name', resolver: ({ merged }) => merged.name },
					{ key: 'coordinates', column: 'coordinates', resolver: ({ merged }) => JSON.stringify(merged.coordinates) },
					{
						key: 'directionality',
						column: 'directionality',
						resolver: ({ patch, merged }) => (patch.directionality === null ? null : (merged.directionality ?? null)),
					},
					{ key: 'color', column: 'color', resolver: ({ patch, merged }) => (patch.color === null ? null : (merged.color ?? null)) },
					{
						key: 'elevated',
						column: 'elevated',
						resolver: ({ patch, merged }) => (patch.elevated === null ? null : (merged.elevated ?? null)),
					},
					{ key: 'ihp', column: 'ihp', resolver: ({ patch, merged }) => (patch.ihp === null ? null : (merged.ihp ?? null)) },
				];

			for (const context of modifyContexts) {
				const { id, patch, merged } = context;
				const setFragments: string[] = [];
				const params: DatabaseSerializable[] = [];

				for (const mapping of updateMappings) {
					if (!Object.prototype.hasOwnProperty.call(patch, mapping.key)) {
						continue;
					}
					const rawValue = patch[mapping.key];
					if (rawValue === undefined) {
						continue;
					}
					setFragments.push(`${mapping.column} = ?`);
					params.push(mapping.resolver({ patch, merged }));
				}

				if (setFragments.length === 0) {
					continue;
				}

				setFragments.push('updated_at = ?');
				params.push(now, airportId, id);

				statements.push({
					query: `UPDATE points
					SET ${setFragments.join(', ')}
					WHERE airport_id = ? AND id = ?`,
					params,
				});
			}
		}

		const deleteIds = changeset.delete ?? [];
		if (deleteIds.length > 0) {
			const maxIdsPerDelete = 99;
			for (let index = 0; index < deleteIds.length; index += maxIdsPerDelete) {
				const chunk = deleteIds.slice(index, index + maxIdsPerDelete);
				const deletePlaceholders = chunk.map(() => '?').join(', ');
				statements.push({
					query: `DELETE FROM points WHERE airport_id = ? AND id IN (${deletePlaceholders})`,
					params: [airportId, ...chunk],
				});
			}
		}

		if (statements.length > 0) {
			await this.dbSession.executeBatch(statements);
		}

		try {
			this.posthog?.track('Points Changeset Applied', {
				airportId,
				userId,
				created: createdPoints.length,
				modified: modifyContexts.length,
				deleted: deleteIds.length,
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

	private async generatePointIds(count: number): Promise<string[]> {
		if (count <= 0) {
			return [];
		}

		const allocatedIds = new Set<string>();
		let attempts = 0;
		const maxAttempts = 3;

		while (allocatedIds.size < count && attempts < maxAttempts) {
			attempts += 1;
			const needed = count - allocatedIds.size;
			let generated: string[];
			try {
				generated = await this.idService.generateBarsIds(needed);
			} catch (error) {
				throw new HttpError(
					500,
					'Failed to allocate unique point IDs',
					{
						cause: error instanceof Error ? error.message : error,
					},
					false,
				);
			}
			const candidateSet = new Set(generated.filter((candidate) => !allocatedIds.has(candidate)));
			if (candidateSet.size === 0) {
				continue;
			}

			const candidates = Array.from(candidateSet);
			const statements = candidates.map((id) => this.stmtCheckPointId.bindAll({ id }));
			const results = await this.dbSession.executeBatch(statements);

			results.forEach((result, index) => {
				const rows = (result.results as unknown as Array<{ id: string }> | null) ?? [];
				if (rows.length === 0) {
					allocatedIds.add(candidates[index]);
				}
			});
		}

		if (allocatedIds.size < count) {
			throw new HttpError(500, 'Failed to allocate unique point IDs');
		}

		return Array.from(allocatedIds);
	}

	private validatePoint(point: PointData) {
		const allowedTypes: Array<Point['type']> = ['stopbar', 'lead_on', 'taxiway', 'stand'];
		if (!point.type || !allowedTypes.includes(point.type)) {
			throw new HttpError(400, 'Point must have a valid type');
		}

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

		// Parse linkedTo - can be JSON array, single string, or null
		let linkedTo: string[] | undefined;
		if (dbPoint.linked_to) {
			try {
				const parsed = JSON.parse(dbPoint.linked_to);
				if (Array.isArray(parsed)) {
					linkedTo = parsed.filter((id): id is string => typeof id === 'string');
				} else if (typeof parsed === 'string') {
					linkedTo = [parsed];
				}
			} catch {
				// Not JSON - treat as single ID (legacy format)
				linkedTo = [dbPoint.linked_to];
			}
			if (linkedTo && linkedTo.length === 0) {
				linkedTo = undefined;
			}
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
			linkedTo,
			createdAt: dbPoint.created_at,
			updatedAt: dbPoint.updated_at,
			createdBy: dbPoint.created_by,
		};
	}

	/**
	 * Link a lead-on to a stopbar for auto-toggle behavior.
	 * A lead-on can be linked to multiple stopbars.
	 */
	async linkLeadOnToStopbar(leadOnId: string, stopbarId: string, userId: string): Promise<void> {
		// Get both points
		const leadOn = await this.getPoint(leadOnId);
		const stopbar = await this.getPoint(stopbarId);

		if (!leadOn) {
			throw new HttpError(404, 'Lead-on point not found');
		}
		if (!stopbar) {
			throw new HttpError(404, 'Stopbar point not found');
		}

		// Validate types
		if (leadOn.type !== 'lead_on') {
			throw new HttpError(400, 'First point must be a lead_on');
		}
		if (stopbar.type !== 'stopbar') {
			throw new HttpError(400, 'Second point must be a stopbar');
		}

		// Must be same airport
		if (leadOn.airportId !== stopbar.airportId) {
			throw new HttpError(400, 'Points must be at the same airport');
		}

		// Check permissions
		const hasDivisionAccess = await this.divisions.userHasAirportAccess(userId, leadOn.airportId);
		if (!hasDivisionAccess) {
			throw new HttpError(403, 'Forbidden: You do not have permission to modify this airport');
		}

		// Add to existing links array (or create new one)
		const existingLinks = leadOn.linkedTo || [];
		if (existingLinks.includes(stopbarId)) {
			// Already linked, no-op
			return;
		}
		const newLinks = [...existingLinks, stopbarId];

		// Update the lead_on's linked_to field as JSON array
		await this.dbSession.executeWrite(
			'UPDATE points SET linked_to = ?, updated_at = ? WHERE id = ?',
			[JSON.stringify(newLinks), new Date().toISOString(), leadOnId],
		);

		try {
			this.posthog?.track('Lead-on Linked', {
				leadOnId,
				stopbarId,
				airportId: leadOn.airportId,
				userId,
				totalLinks: newLinks.length,
			});
		} catch (e) {
			console.warn('Posthog track failed (Lead-on Linked)', e);
		}
	}

	/**
	 * Unlink a lead-on from a specific stopbar, or all stopbars if stopbarId is not provided
	 */
	async unlinkLeadOn(leadOnId: string, userId: string, stopbarId?: string): Promise<void> {
		const leadOn = await this.getPoint(leadOnId);

		if (!leadOn) {
			throw new HttpError(404, 'Lead-on point not found');
		}

		if (leadOn.type !== 'lead_on') {
			throw new HttpError(400, 'Point must be a lead_on');
		}

		if (!leadOn.linkedTo || leadOn.linkedTo.length === 0) {
			throw new HttpError(400, 'Lead-on is not linked to any stopbar');
		}

		// Check permissions
		const hasDivisionAccess = await this.divisions.userHasAirportAccess(userId, leadOn.airportId);
		if (!hasDivisionAccess) {
			throw new HttpError(403, 'Forbidden: You do not have permission to modify this airport');
		}

		let newLinks: string[] | null = null;
		if (stopbarId) {
			// Remove specific stopbar from links
			newLinks = leadOn.linkedTo.filter((id) => id !== stopbarId);
			if (newLinks.length === 0) {
				newLinks = null;
			}
		}
		// If no stopbarId provided, newLinks stays null (unlink all)

		await this.dbSession.executeWrite(
			'UPDATE points SET linked_to = ?, updated_at = ? WHERE id = ?',
			[newLinks ? JSON.stringify(newLinks) : null, new Date().toISOString(), leadOnId],
		);

		try {
			this.posthog?.track('Lead-on Unlinked', {
				leadOnId,
				stopbarId: stopbarId || 'all',
				previousLinks: leadOn.linkedTo,
				airportId: leadOn.airportId,
				userId,
			});
		} catch (e) {
			console.warn('Posthog track failed (Lead-on Unlinked)', e);
		}
	}

	/**
	 * Get all lead-ons linked to a specific stopbar
	 */
	async getLinkedLeadOns(stopbarId: string): Promise<string[]> {
		// Need to check if stopbarId is in the JSON array or equals the legacy single value
		const results = await this.dbSession.executeRead<{ id: string; linked_to: string }>(
			"SELECT id, linked_to FROM points WHERE type = 'lead_on' AND linked_to IS NOT NULL",
			[],
		);

		const linkedIds: string[] = [];
		for (const row of results.results) {
			try {
				const parsed = JSON.parse(row.linked_to);
				if (Array.isArray(parsed) && parsed.includes(stopbarId)) {
					linkedIds.push(row.id);
				}
			} catch {
				// Legacy single ID format
				if (row.linked_to === stopbarId) {
					linkedIds.push(row.id);
				}
			}
		}
		return linkedIds;
	}

	/**
	 * Get all link mappings for an airport (stopbar -> lead_on[])
	 */
	async getAirportLinks(airportId: string): Promise<Record<string, string[]>> {
		const results = await this.dbSession.executeRead<{ id: string; linked_to: string }>(
			'SELECT id, linked_to FROM points WHERE airport_id = ? AND linked_to IS NOT NULL',
			[airportId],
		);

		const links: Record<string, string[]> = {};
		for (const row of results.results) {
			let stopbarIds: string[] = [];
			try {
				const parsed = JSON.parse(row.linked_to);
				if (Array.isArray(parsed)) {
					stopbarIds = parsed.filter((id): id is string => typeof id === 'string');
				} else if (typeof parsed === 'string') {
					stopbarIds = [parsed];
				}
			} catch {
				// Legacy single ID format
				stopbarIds = [row.linked_to];
			}

			for (const stopbarId of stopbarIds) {
				if (!links[stopbarId]) {
					links[stopbarId] = [];
				}
				links[stopbarId].push(row.id);
			}
		}
		return links;
	}

	/**
	 * Bulk update links between lead-ons and stopbars for an airport.
	 * Supports multiple stopbars per lead-on.
	 * @param link - Array of links to add (additive, won't remove existing links)
	 * @param unlink - Array of specific links to remove { leadOnId, stopbarId }
	 */
	async bulkUpdateLinks(
		airportId: string,
		userId: string,
		operations: {
			link: Array<{ leadOnId: string; stopbarId: string }>;
			unlink: Array<{ leadOnId: string; stopbarId: string }>;
		},
	): Promise<{ linked: number; unlinked: number }> {
		// Check permissions for this airport
		const hasDivisionAccess = await this.divisions.userHasAirportAccess(userId, airportId);
		if (!hasDivisionAccess) {
			throw new HttpError(403, 'Forbidden: You do not have permission to modify this airport');
		}

		const { link, unlink } = operations;
		const now = new Date().toISOString();

		// Collect all unique point IDs
		const allLeadOnIds = [...new Set([...link.map((l) => l.leadOnId), ...unlink.map((u) => u.leadOnId)])];
		const allStopbarIds = [...new Set([...link.map((l) => l.stopbarId), ...unlink.map((u) => u.stopbarId)])];
		const allPointIds = [...new Set([...allLeadOnIds, ...allStopbarIds])];

		if (allPointIds.length === 0) {
			return { linked: 0, unlinked: 0 };
		}

		// Fetch all points in bulk
		const placeholders = allPointIds.map(() => '?').join(', ');
		const pointsResult = await this.dbSession.executeRead<PointRow>(
			`SELECT * FROM points WHERE id IN (${placeholders}) AND airport_id = ?`,
			[...allPointIds, airportId],
		);

		const pointsById = new Map(pointsResult.results.map((p) => [p.id, this.mapPointFromDb(p)]));

		// Validate all points exist and have correct types
		for (const op of link) {
			const leadOn = pointsById.get(op.leadOnId);
			const stopbar = pointsById.get(op.stopbarId);

			if (!leadOn) {
				throw new HttpError(404, `Lead-on point not found: ${op.leadOnId}`);
			}
			if (!stopbar) {
				throw new HttpError(404, `Stopbar point not found: ${op.stopbarId}`);
			}
			if (leadOn.type !== 'lead_on') {
				throw new HttpError(400, `Point ${op.leadOnId} is not a lead_on`);
			}
			if (stopbar.type !== 'stopbar') {
				throw new HttpError(400, `Point ${op.stopbarId} is not a stopbar`);
			}
		}

		for (const op of unlink) {
			const leadOn = pointsById.get(op.leadOnId);
			if (!leadOn) {
				throw new HttpError(404, `Lead-on point not found: ${op.leadOnId}`);
			}
			if (leadOn.type !== 'lead_on') {
				throw new HttpError(400, `Point ${op.leadOnId} is not a lead_on`);
			}
		}

		// Build a map of lead-on ID -> new links array
		// Start with current links, then apply changes
		const leadOnUpdates = new Map<string, Set<string>>();

		// Initialize with current links for all affected lead-ons
		for (const leadOnId of allLeadOnIds) {
			const leadOn = pointsById.get(leadOnId);
			if (leadOn) {
				leadOnUpdates.set(leadOnId, new Set(leadOn.linkedTo || []));
			}
		}

		// Apply unlink operations (remove specific stopbar from lead-on)
		for (const op of unlink) {
			const currentLinks = leadOnUpdates.get(op.leadOnId);
			if (currentLinks) {
				currentLinks.delete(op.stopbarId);
			}
		}

		// Apply link operations (add stopbar to lead-on)
		for (const op of link) {
			const currentLinks = leadOnUpdates.get(op.leadOnId);
			if (currentLinks) {
				currentLinks.add(op.stopbarId);
			}
		}

		// Build batch update statements
		const statements: Array<{ query: string; params: DatabaseSerializable[] }> = [];

		for (const [leadOnId, linksSet] of leadOnUpdates.entries()) {
			const linksArray = Array.from(linksSet);
			const linkedToValue = linksArray.length > 0 ? JSON.stringify(linksArray) : null;

			statements.push({
				query: 'UPDATE points SET linked_to = ?, updated_at = ? WHERE id = ? AND airport_id = ?',
				params: [linkedToValue, now, leadOnId, airportId],
			});
		}

		// Execute all operations in a batch
		if (statements.length > 0) {
			await this.dbSession.executeBatch(statements);
		}

		try {
			this.posthog?.track('Bulk Links Updated', {
				airportId,
				userId,
				linked: link.length,
				unlinked: unlink.length,
			});
		} catch (e) {
			console.warn('Posthog track failed (Bulk Links Updated)', e);
		}

		return { linked: link.length, unlinked: unlink.length };
	}
}
