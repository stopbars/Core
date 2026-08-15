import { ServicePool } from './service-pool';

export type RadarLight = { stateId: number | null; offStateId: number | null; position: [number, number]; heading: number };
export interface LightsByObject {
	[objectId: string]: RadarLight[];
}

const LIGHT_STATE_ID_PATTERN = /stateId\s*=\s*"(\d+)"/i;
const LIGHT_OFF_STATE_ID_PATTERN = /offStateId\s*=\s*"(\d+)"/i;
const LIGHT_POSITION_PATTERN = /<Position>\s*([^<]+)\s*<\/Position>/i;
const LIGHT_HEADING_PATTERN = /<Heading>\s*([^<]+)\s*<\/Heading>/i;

export function parseBarsLightsXml(xml: string): LightsByObject {
	const result: LightsByObject = {};
	if (!xml) return result;

	const objRegex = /<BarsObject[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/BarsObject>/gi;
	let objMatch: RegExpExecArray | null;
	while ((objMatch = objRegex.exec(xml)) !== null) {
		const id = objMatch[1];
		const body = objMatch[2];
		const lights: RadarLight[] = [];
		const lightRegex = /<Light([^>]*)>([\s\S]*?)<\/Light>/gi;
		let lightMatch: RegExpExecArray | null;
		while ((lightMatch = lightRegex.exec(body)) !== null) {
			const attrs = lightMatch[1] || '';
			const inner = lightMatch[2] || '';
			const stateIdMatch = LIGHT_STATE_ID_PATTERN.exec(attrs);
			const offStateIdMatch = LIGHT_OFF_STATE_ID_PATTERN.exec(attrs);
			const posMatch = LIGHT_POSITION_PATTERN.exec(inner);
			const headingMatch = LIGHT_HEADING_PATTERN.exec(inner);
			if (!posMatch || !headingMatch) continue;
			const commaIndex = posMatch[1].indexOf(',');
			if (commaIndex < 0) continue;
			const lat = parseFloat(posMatch[1].slice(0, commaIndex));
			const lon = parseFloat(posMatch[1].slice(commaIndex + 1));
			const heading = parseFloat(headingMatch[1]);
			if (Number.isNaN(lat) || Number.isNaN(lon) || Number.isNaN(heading)) continue;
			const stateId = stateIdMatch ? parseInt(stateIdMatch[1], 10) : null;
			const offStateId = offStateIdMatch ? parseInt(offStateIdMatch[1], 10) : null;
			lights.push({ stateId, offStateId, position: [lat, lon], heading });
		}
		if (lights.length > 0) {
			result[id] = lights;
		}
	}
	return result;
}

// Fetch and cache latest lights mapping for an airport (15 minutes TTL)
export async function getLightsByObject(env: Env, icao: string): Promise<LightsByObject> {
	const normalizedIcao = icao.toUpperCase();
	const cache = ServicePool.getCache(env);
	const cacheKey = `lights-map-${normalizedIcao}`;
	const cached = await cache.get<LightsByObject>(cacheKey, 'airports');
	if (cached) return cached;

	const storage = ServicePool.getStorage(env);
	try {
		const approved = await ServicePool.getContributions(env).listContributionMetadata({
			status: 'approved',
			airportIcao: normalizedIcao,
		});
		for (const contribution of approved.contributions) {
			if (!contribution.barsArtifactKey) continue;
			const published = await storage.getFile(contribution.barsArtifactKey);
			if (!published) continue;
			const mapping = parseBarsLightsXml(await published.text());
			await cache.set(cacheKey, mapping, { ttl: 900, namespace: 'airports' });
			return mapping;
		}

		// Backward compatibility for approved YSCB/YSSY rows published before
		// immutable artifact keys were recorded on contributions.
		const list = await storage.listFiles(`Maps/${normalizedIcao}_`, 50);
		if (!list.objects || list.objects.length === 0) {
			await cache.set(cacheKey, {}, { ttl: 300, namespace: 'airports' });
			return {};
		}
		let latest = list.objects[0];
		for (let index = 1; index < list.objects.length; index++) {
			const object = list.objects[index];
			if (object.uploaded > latest.uploaded) latest = object;
		}
		const fileResp = await storage.getFile(latest.key);
		if (!fileResp) {
			await cache.set(cacheKey, {}, { ttl: 300, namespace: 'airports' });
			return {};
		}
		const xml = await fileResp.text();
		const mapping = parseBarsLightsXml(xml);
		await cache.set(cacheKey, mapping, { ttl: 900, namespace: 'airports' }); // 15 minutes
		return mapping;
	} catch {
		// Cache empty result briefly to avoid thundering herd
		await cache.set(cacheKey, {}, { ttl: 60, namespace: 'airports' });
		return {};
	}
}
