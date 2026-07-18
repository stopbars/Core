interface NamespaceVersionHint {
	version: number;
	checkedAt: number;
}

// Revalidate periodically so a namespace bump from another isolate cannot leave
// a hot cached entry on an old version indefinitely.
const NAMESPACE_VERSION_FRESH_MS = 5_000;
const namespaceVersionHints = new Map<string, NamespaceVersionHint>();
const pendingNamespaceVersionReads = new Map<string, Promise<number>>();

interface CacheOptions {
	ttl?: number; // Time to live in seconds
	namespace?: string;
}

/**
 * Server-side caching service using Cloudflare's Cache API
 * More efficient than KV for short-lived cached data
 */
export class CacheService {
	constructor(env: Env) {
		void env;
	}

	private versionMetaKey(namespace: string): Request {
		return new Request(`https://cache.stopbars/__version/${namespace}`);
	}

	private getCachedNamespaceVersion(namespace: string): number | undefined {
		const hinted = namespaceVersionHints.get(namespace);
		if (hinted && Date.now() - hinted.checkedAt < NAMESPACE_VERSION_FRESH_MS) {
			return hinted.version;
		}
		return undefined;
	}

	private rememberNamespaceVersion(namespace: string, version: number): number {
		namespaceVersionHints.set(namespace, { version, checkedAt: Date.now() });
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

		const pending = pendingNamespaceVersionReads.get(namespace);
		if (pending) {
			return pending;
		}

		const request = this.fetchNamespaceVersion(namespace).then((fresh) => this.rememberNamespaceVersion(namespace, fresh));
		pendingNamespaceVersionReads.set(namespace, request);
		try {
			return await request;
		} finally {
			if (pendingNamespaceVersionReads.get(namespace) === request) {
				pendingNamespaceVersionReads.delete(namespace);
			}
		}
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

	private dataKey(key: string, namespace: string, version: number): Request {
		return new Request(`https://cache.stopbars/${namespace}/v${version}/${key}`);
	}

	private async matchResponse(key: string, namespace: string, version: number): Promise<Response | null> {
		return (await caches.default.match(this.dataKey(key, namespace, version))) ?? null;
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
	async getResponse(key: string, namespace = 'default'): Promise<Response | null> {
		const version = await this.resolveNamespaceVersion(namespace);
		return this.matchResponse(key, namespace, version);
	}

	async get<T>(key: string, namespace = 'default'): Promise<T | null> {
		const cachedResponse = await this.getResponse(key, namespace);
		if (!cachedResponse) return null;
		try {
			return await cachedResponse.json<T>();
		} catch {
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

		// Versioned cache key with namespace
		const ver = await this.resolveNamespaceVersion(namespace);
		const cacheKey = this.dataKey(key, namespace, ver);

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

	/** Store an existing response without parsing and serializing its body. */
	async setResponse(key: string, response: Response, options: CacheOptions = {}): Promise<void> {
		const { ttl = 60, namespace = 'default' } = options;
		const ver = await this.resolveNamespaceVersion(namespace);
		const headers = new Headers(response.headers);
		headers.set('Cache-Control', `max-age=${ttl}`);
		headers.delete('Set-Cookie');
		headers.delete('X-Cache');
		await caches.default.put(
			this.dataKey(key, namespace, ver),
			new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			}),
		);
	}

	/**
	 * Delete data from cache
	 * @param key - Cache key
	 * @param namespace - Cache namespace
	 */
	async delete(key: string, namespace = 'default'): Promise<void> {
		const ver = await this.resolveNamespaceVersion(namespace);
		const cacheKey = this.dataKey(key, namespace, ver);
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
	let cacheService: CacheService | undefined;
	return async (c: import('hono').Context<{ Bindings: Env }>, next: () => Promise<void>) => {
		// Skip caching for non-GET requests
		if (c.req.method !== 'GET') {
			return next();
		}

		if (shouldBypass?.(c.req.raw)) {
			return next();
		}

		cacheService ??= new CacheService(c.env);
		const cacheKey = cacheKeyFn(c.req.raw);

		// Try to get from cache
		const cachedResponse = await cacheService.getResponse(cacheKey, namespace);
		if (cachedResponse) {
			const response = new Response(cachedResponse.body, cachedResponse);
			// Cache-Control governs the internal Cache API entry. Do not expose it to
			// browser caches, which cannot vary user-scoped entries by our private key.
			response.headers.delete('Cache-Control');
			response.headers.set('X-Cache', 'HIT');
			return response;
		}

		// Cache miss, proceed to handler
		c.header('X-Cache', 'MISS');
		await next();

		// After handler executes, cache the response if it was successful
		// Don't cache error responses (4xx, 5xx) including 404 Not Found
		if (c.res && c.res.status >= 200 && c.res.status < 300) {
			try {
				const contentType = c.res.headers.get('content-type');
				if (
					contentType?.includes('application/json') ||
					contentType?.includes('application/xml') ||
					contentType?.includes('text/xml')
				) {
					const cacheWrite = cacheService.setResponse(cacheKey, c.res.clone(), { ttl, namespace });
					try {
						c.executionCtx.waitUntil(cacheWrite);
					} catch {
						await cacheWrite;
					}
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
		const entries: Array<[string, string]> = [];
		for (const [key, value] of url.searchParams) {
			if (!/^auth(orization)?$/i.test(key)) entries.push([key, value]);
		}
		entries.sort(([left], [right]) => left.localeCompare(right));
		let params = '';
		for (const [key, value] of entries) {
			if (params) params += '&';
			params += `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
		}
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
