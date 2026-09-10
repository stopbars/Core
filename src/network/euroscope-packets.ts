export const MAX_LIGHTING_MESSAGE_BYTES = 1_000_000;
export const MAX_LIGHTING_UPDATES = 10_000;

function dictionary(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 100 &&
		value !== '__proto__' && value !== 'constructor' && value !== 'prototype';
}

// EuroScope serializes a complete profile as flat node/block dictionaries, not arbitrary nested JSON.
export function isEuroScopeGraphPatch(value: unknown): boolean {
	if (!dictionary(value) || !dictionary(value.nodes) || !dictionary(value.blocks)) return false;
	if (Object.keys(value).some((key) => !['meta', 'profile', 'nodes', 'blocks'].includes(key))) return false;
	if (value.profile !== undefined && !identifier(value.profile)) return false;
	if (value.meta !== undefined && value.meta !== null) {
		if (!dictionary(value.meta) || Object.keys(value.meta).length !== 2) return false;
		for (const key of ['client', 'serial']) {
			const number = value.meta[key];
			if (typeof number !== 'number' || !Number.isFinite(number) || !Number.isInteger(number) || number < 0) return false;
		}
	}
	const nodes = Object.entries(value.nodes);
	const blocks = Object.entries(value.blocks);
	if (nodes.length + blocks.length > MAX_LIGHTING_UPDATES) return false;
	if (!nodes.every(([key, state]) => identifier(key) && typeof state === 'boolean')) return false;
	return blocks.every(([key, state]) => {
		if (!identifier(key)) return false;
		if (state === 'Clear' || state === 'Relax') return true;
		return dictionary(state) && Object.keys(state).length === 1 &&
			Array.isArray(state.Route) && state.Route.length === 2 && state.Route.every(identifier);
	});
}

export function allowsLargeLightingPacket(value: unknown): boolean {
	if (!dictionary(value)) return false;
	if (value.type === 'MULTI_STATE_UPDATE') {
		const updates = Array.isArray(value.data) ? value.data : dictionary(value.data) ? value.data.updates : undefined;
		return Array.isArray(updates) && updates.length > 0 && updates.length <= MAX_LIGHTING_UPDATES;
	}
	return value.type === 'SHARED_STATE_UPDATE' && dictionary(value.data) && isEuroScopeGraphPatch(value.data.sharedStatePatch);
}
