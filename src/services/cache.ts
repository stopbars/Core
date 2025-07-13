interface CacheOptions {
    ttl?: number;  // Time to live in seconds
    namespace?: string;
}

/**
 * Server-side caching service using Cloudflare's Cache API
 * More efficient than KV for short-lived cached data
 */
export class CacheService {
    constructor(private env: Env) { }

    /**
     * Get data from cache
     * @param key - Cache key
     * @returns Cached data or null if not found
     */
    async get<T>(key: string, namespace = 'default'): Promise<T | null> {
        // Create a cache key with namespace
        const cacheKey = new Request(`https://cache.stopbars/${namespace}/${key}`);

        // Try to get from cache
        const cache = caches.default;
        const cachedResponse = await cache.match(cacheKey);

        if (!cachedResponse) {
            return null;
        }

        try {
            return await cachedResponse.json();
        } catch (e) {
            return null;
        }
    }

    /**
     * Set data in cache
     * @param key - Cache key
     * @param data - Data to cache
     * @param options - Cache options
     */
    async set<T>(key: string, data: T, options: CacheOptions = {}): Promise<void> {
        const { ttl = 60, namespace = 'default' } = options;

        // Create a cache key with namespace
        const cacheKey = new Request(`https://cache.stopbars/${namespace}/${key}`);

        // Create response with the data
        const response = new Response(JSON.stringify(data), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `max-age=${ttl}`,
            },
        });

        // Store in cache
        const cache = caches.default;
        await cache.put(cacheKey, response);
    }

    /**
     * Delete data from cache
     * @param key - Cache key
     * @param namespace - Cache namespace
     */
    async delete(key: string, namespace = 'default'): Promise<void> {
        const cacheKey = new Request(`https://cache.stopbars/${namespace}/${key}`);
        const cache = caches.default;
        await cache.delete(cacheKey);
    }
}

/**
 * Cache middleware for Hono
 * @param cacheKeyFn - Function to generate cache key from request
 * @param ttl - Time to live in seconds
 * @param namespace - Cache namespace
 */
export function withCache(
    cacheKeyFn: (req: Request) => string,
    ttl: number = 60,
    namespace: string = 'default'
) {
    return async (c: any, next: () => Promise<void>) => {
        // Skip caching for non-GET requests
        if (c.req.method !== 'GET') {
            return next();
        }

        const cacheService = new CacheService(c.env);
        const cacheKey = cacheKeyFn(c.req.raw);

        // Try to get from cache
        const cachedData = await cacheService.get(cacheKey, namespace);
        if (cachedData) {
            // Set header to indicate cache hit
            c.header('X-Cache', 'HIT');
            return c.json(cachedData);
        }

        // Cache miss, proceed to handler
        c.header('X-Cache', 'MISS');
        await next();

        // After handler executes, cache the response if it was successful
        // Don't cache error responses (4xx, 5xx) including 404 Not Found
        if (c.res && c.res.status >= 200 && c.res.status < 300) {
            try {
                // Clone the response to read it without consuming the original
                const clonedRes = c.res.clone();
                const contentType = clonedRes.headers.get('content-type');

                // Only cache JSON responses
                if (contentType && contentType.includes('application/json')) {
                    const data = await clonedRes.json();
                    // Cache the data
                    await cacheService.set(cacheKey, data, { ttl, namespace });
                }
            } catch (e) {
                // Silently fail if we can't cache
                console.error('Failed to cache response:', e);
            }
        }
    };
}

/**
 * Simple cache key generators for common patterns
 */
export const CacheKeys = {
    /**
     * Generate cache key from URL path and query params
     */
    fromUrl: (req: Request): string => {
        const url = new URL(req.url);
        return `${url.pathname}${url.search}`;
    },

    /**
     * Generate cache key from specific query parameters
     */
    fromParams: (...params: string[]) => (req: Request): string => {
        const url = new URL(req.url);
        const values = params.map(p => url.searchParams.get(p) || '').join('-');
        return `${url.pathname}-${values}`;
    },

    /**
     * Generate cache key with user context (for authenticated endpoints)
     */
    withUser: (baseKey: string) => (req: Request): string => {
        const token = req.headers.get('X-Vatsim-Token') || 'anonymous';
        // Use a hash of the token to avoid storing sensitive data in cache keys
        const userHash = token.substring(0, 8); // Simple approach, could use proper hashing
        return `${baseKey}-user-${userHash}`;
    },
};
