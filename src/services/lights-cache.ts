import { CacheService } from './cache';
import { ServicePool } from './service-pool';

export type RadarLight = { stateId: number | null; position: [number, number]; heading: number };

// Parse BARS Lights XML into objectId -> lights[] mapping
export function parseBarsLightsXml(xml: string): Record<string, RadarLight[]> {
    const result: Record<string, RadarLight[]> = {};
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
            const stateIdMatch = attrs.match(/stateId\s*=\s*"(\d+)"/i);
            const posMatch = inner.match(/<Position>\s*([^<]+)\s*<\/Position>/i);
            const headingMatch = inner.match(/<Heading>\s*([^<]+)\s*<\/Heading>/i);
            if (!posMatch || !headingMatch) continue;
            const [latStr, lonStr] = posMatch[1].split(',').map((s) => s.trim());
            const lat = parseFloat(latStr);
            const lon = parseFloat(lonStr);
            const heading = parseFloat(headingMatch[1]);
            if (Number.isNaN(lat) || Number.isNaN(lon) || Number.isNaN(heading)) continue;
            const stateId = stateIdMatch ? parseInt(stateIdMatch[1], 10) : null;
            lights.push({ stateId, position: [lat, lon], heading });
        }
        if (lights.length > 0) {
            result[id] = lights;
        }
    }
    return result;
}

// Fetch and cache latest lights mapping for an airport (15 minutes TTL)
export async function getLightsByObject(env: Env, icao: string): Promise<Record<string, RadarLight[]>> {
    const cache = new CacheService(env);
    const cacheKey = `lights-map-${icao.toUpperCase()}`;
    const cached = await cache.get<Record<string, RadarLight[]>>(cacheKey, 'airports');
    if (cached) return cached;

    const storage = ServicePool.getStorage(env);
    try {
        const list = await storage.listFiles(`Maps/${icao}_`, 50);
        if (!list.objects || list.objects.length === 0) {
            await cache.set(cacheKey, {}, { ttl: 300, namespace: 'airports' });
            return {};
        }
        let latest = list.objects[0];
        for (const obj of list.objects) {
            const objUploaded = (obj as any)?.uploaded as number | undefined;
            const latestUploaded = (latest as any)?.uploaded as number | undefined;
            if (objUploaded && latestUploaded && objUploaded > latestUploaded) {
                latest = obj as any;
            }
        }
        const fileResp = await storage.getFile((latest as any).key);
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
