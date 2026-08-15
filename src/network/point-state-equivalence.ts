import type { AirportObject, MultiStateUpdateItem, Point } from '../types';

export type OfflineStatePoint = { id: string; state: boolean };

export type OfflineStateTemplate = {
	points: OfflineStatePoint[];
	equivalentIdsById: ReadonlyMap<string, readonly string[]>;
};

const getDefaultState = (point: Point): boolean => point.type === 'taxiway' || point.type === 'lead_on' || point.type === 'stand';

/**
 * State equivalence intentionally follows the intrinsic properties that affect
 * the generated simulator lights. IDs and names are metadata, while linkedTo
 * describes control relationships rather than the physical light object.
 *
 * Coordinates are compared exactly and in order. This favors a false negative
 * over coupling two merely-nearby light objects.
 */
const getPointStateFingerprint = (point: Point): string | null => {
	if (point.coordinates.length === 0) return null;

	return JSON.stringify([
		point.airportId.toUpperCase(),
		point.type,
		point.coordinates.map(({ lat, lng }) => [lat, lng]),
		point.directionality ?? null,
		point.color ?? null,
		point.elevated ?? false,
		point.ihp ?? false,
	]);
};

export const buildPointStateTemplate = (airportPoints: readonly Point[]): OfflineStateTemplate => {
	const duplicateGroups = new Map<string, string[]>();

	for (const point of airportPoints) {
		const fingerprint = getPointStateFingerprint(point);
		if (fingerprint === null) continue;

		const ids = duplicateGroups.get(fingerprint);
		if (ids) {
			ids.push(point.id);
		} else {
			duplicateGroups.set(fingerprint, [point.id]);
		}
	}

	const equivalentIdsById = new Map<string, readonly string[]>();
	for (const unsortedIds of duplicateGroups.values()) {
		if (unsortedIds.length < 2) continue;
		const ids = Object.freeze([...unsortedIds].sort());
		for (const id of ids) equivalentIdsById.set(id, ids);
	}

	return {
		points: airportPoints.map((point) => ({ id: point.id, state: getDefaultState(point) })),
		equivalentIdsById,
	};
};

export const getGeneratedAliasUpdates = (
	updates: readonly MultiStateUpdateItem[],
	requestedObjectIds: ReadonlySet<string>,
): MultiStateUpdateItem[] => updates.filter((update) => !requestedObjectIds.has(update.objectId));

export const selectCanonicalEquivalentState = (
	ids: readonly string[],
	objects: ReadonlyMap<string, AirportObject>,
): AirportObject | undefined => {
	let latest: AirportObject | undefined;
	for (const id of ids) {
		const candidate = objects.get(id);
		if (
			candidate &&
			(!latest || candidate.timestamp > latest.timestamp || (candidate.timestamp === latest.timestamp && candidate.id < latest.id))
		) {
			latest = candidate;
		}
	}
	return latest;
};

export const chunkStateUpdates = (updates: readonly MultiStateUpdateItem[], maximumChunkSize: number): MultiStateUpdateItem[][] => {
	if (!Number.isInteger(maximumChunkSize) || maximumChunkSize < 1) {
		throw new Error('maximumChunkSize must be a positive integer');
	}

	const chunks: MultiStateUpdateItem[][] = [];
	for (let index = 0; index < updates.length; index += maximumChunkSize) {
		chunks.push(updates.slice(index, index + maximumChunkSize));
	}
	return chunks;
};
