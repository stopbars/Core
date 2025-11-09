const namespaceVersionHints = new Map<string, number>();

interface CacheOptions {
	ttl?: number; // Time to live in seconds
	namespace?: string;
}

/**
 * Server-side caching service using Cloudflare's Cache API
 * More efficient than KV for short-lived cached data
 */
export class CacheService {
	private namespaceVersionCache = new Map<string, number>();

	constructor(private env: Env) { }

	private versionMetaKey(namespace: string): Request {
		return new Request(`https://cache.stopbars/__version/${namespace}`);
	}

	private getCachedNamespaceVersion(namespace: string): number | undefined {
		const local = this.namespaceVersionCache.get(namespace);
		if (local !== undefined) {
			return local;
		}
		const hinted = namespaceVersionHints.get(namespace);
		if (hinted !== undefined) {
			this.namespaceVersionCache.set(namespace, hinted);
		}
		return hinted;
	}

	private rememberNamespaceVersion(namespace: string, version: number): number {
		this.namespaceVersionCache.set(namespace, version);
		namespaceVersionHints.set(namespace, version);
		return version;
	}

	private async fetchNamespaceVersion(namespace: string): Promise<number> {
		const cache = caches.default;
		const res = await cache.match(this.versionMetaKey(namespace));
		if (!res) return 1;
		try {
			const data = (await res.json()) as { version?: number };
			const v = Number(data?.version);
			return Number.isFinite(v) && v > 0 ? v : 1;
		} catch {
			return 1;
		}
	}

	private async resolveNamespaceVersion(namespace: string, forceRefresh = false): Promise<number> {
		if (!forceRefresh) {
			const cached = this.getCachedNamespaceVersion(namespace);
			if (cached !== undefined) {
				return cached;
			}
		}
		const fresh = await this.fetchNamespaceVersion(namespace);
		return this.rememberNamespaceVersion(namespace, fresh);
	}

	private async setNamespaceVersion(namespace: string, version: number): Promise<void> {
		const cache = caches.default;
		const body = JSON.stringify({ version });
		const res = new Response(body, {
			headers: {
				'Content-Type': 'application/json',
				// Long max-age; it's just a version marker we overwrite on bump
				'Cache-Control': 'public, max-age=31536000',
			},
		});
		await cache.put(this.versionMetaKey(namespace), res);
		this.rememberNamespaceVersion(namespace, version);
	}

	/** Bump and return the new version for a namespace. */
	async bumpNamespaceVersion(namespace: string): Promise<number> {
		const current = await this.resolveNamespaceVersion(namespace, true);
		const next = current + 1;
		await this.setNamespaceVersion(namespace, next);
		return next;
	}

	/**
	 * Get data from cache
	 * @param key - Cache key
	 * @returns Cached data or null if not found
	 */
	async get<T>(key: string, namespace = 'default'): Promise<T | null> {
		const cache = caches.default;
		const matchWithVersion = async (version: number): Promise<T | null> => {
			const cacheKey = new Request(`https://cache.stopbars/${namespace}/v${version}/${key}`);
			const cachedResponse = await cache.match(cacheKey);

			if (!cachedResponse) {
				return null;
			}

			try {
				return await cachedResponse.json();
			} catch {
				return null;
			}
		};

		const hintedVersion = this.getCachedNamespaceVersion(namespace);
		if (hintedVersion !== undefined) {
			const hintedHit = await matchWithVersion(hintedVersion);
			if (hintedHit !== null) {
				return hintedHit;
			}

			const refreshedVersion = await this.resolveNamespaceVersion(namespace, true);
			if (refreshedVersion !== hintedVersion) {
				return await matchWithVersion(refreshedVersion);
			}

			return null;
		}

		const ver = await this.resolveNamespaceVersion(namespace);
		return await matchWithVersion(ver);
	}

	/**
	 * Set data in cache
	 * @param key - Cache key
	 * @param data - Data to cache
	 * @param options - Cache options
	 */
	async set<T>(key: string, data: T, options: CacheOptions = {}): Promise<void> {
		const { ttl = 60, namespace = 'default' } = options;

		// Versioned cache key with namespace
		const ver = await this.resolveNamespaceVersion(namespace);
		const cacheKey = new Request(`https://cache.stopbars/${namespace}/v${ver}/${key}`);

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
		const ver = await this.resolveNamespaceVersion(namespace);
		const cacheKey = new Request(`https://cache.stopbars/${namespace}/v${ver}/${key}`);
		const cache = caches.default;
		await cache.delete(cacheKey);
	}
}

/**
 * Cache middleware for Hono
 * @param cacheKeyFn - Function to generate cache key from request
 * @param ttl - Time to live in seconds
 * @param namespace - Cache namespace
 * @param shouldBypass - Optional predicate to skip caching for a request
 */
export function withCache(
	cacheKeyFn: (req: Request) => string,
	ttl: number = 60,
	namespace: string = 'default',
	shouldBypass?: (req: Request) => boolean,
) {
	return async (c: import('hono').Context<{ Bindings: Env }>, next: () => Promise<void>) => {
		// Skip caching for non-GET requests
		if (c.req.method !== 'GET') {
			return next();
		}

		if (shouldBypass?.(c.req.raw)) {
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
			} catch {
				// Silently fail if we can't cache
				// console.error('Failed to cache response:', e);
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
		// Normalize path and sort params to avoid cache key ambiguity/poisoning
		const path = url.pathname.replace(/[^A-Za-z0-9/_-]/g, '');
		const params = Array.from(url.searchParams.entries())
			.filter(([k]) => !/^auth(orization)?$/i.test(k))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
			.join('&');
		return params ? `${path}?${params}` : path;
	},

	/**
	 * Generate cache key from specific query parameters
	 */
	fromParams:
		(...params: string[]) =>
			(req: Request): string => {
				const url = new URL(req.url);
				const path = url.pathname.replace(/[^A-Za-z0-9/_-]/g, '');
				const safeValues = params
					.map((p) => url.searchParams.get(p) || '')
					.map((v) => v.replace(/[^A-Za-z0-9._-]/g, '')) // whitelist chars
					.join('-');
				return `${path}-${safeValues}`;
			},

	/**
	 * Generate cache key with user context (for authenticated endpoints)
	 */
	withUser:
		(baseKey: string) =>
			(req: Request): string => {
				// Prefer explicit X-Vatsim-Token; fall back to Bearer token from Authorization
				let token = req.headers.get('X-Vatsim-Token') || '';
				if (!token) {
					const authz = req.headers.get('Authorization') || '';
					if (authz.toLowerCase().startsWith('bearer ')) {
						token = authz.slice(7);
					}
				}
				if (!token) {
					return `${baseKey}-user-anonymous`;
				}
				// Synchronous non-cryptographic hash (djb2) to avoid leaking token bytes
				let hash = 5381;
				for (let i = 0; i < token.length; i++) {
					hash = ((hash << 5) + hash) ^ token.charCodeAt(i);
				}
				const userHash = (hash >>> 0).toString(16).padStart(8, '0');
				return `${baseKey}-user-${userHash}`;
			},
};
