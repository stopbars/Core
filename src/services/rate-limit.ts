import type { Context, Next } from 'hono';

export class RateLimiter implements DurableObject {
	private buckets: Record<string, { count: number; resetAt: number }> = {};
	private readonly state: DurableObjectState;
	private readonly env: Env;
	static readonly defaultMaxRequests = 20;
	static readonly defaultIntervalMs = 60_000;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		try {
			type RLBody = Partial<{ key: string; maxRequests: number; intervalMs: number }>;
			const body = await request.json<RLBody>().catch(() => ({}) as RLBody);
			const { key, maxRequests, intervalMs } = body;
			const now = Date.now();

			if (!key) return new Response('Missing key', { status: 400 });

			const bucket = this.buckets[key] || { count: 0, resetAt: now + (intervalMs ?? RateLimiter.defaultIntervalMs) };

			if (now >= bucket.resetAt) {
				bucket.count = 0;
				bucket.resetAt = now + (intervalMs ?? RateLimiter.defaultIntervalMs);
			}

			if (bucket.count >= (maxRequests ?? RateLimiter.defaultMaxRequests)) {
				const wait = bucket.resetAt - now;
				return Response.json({ wait });
			}

			bucket.count += 1;
			this.buckets[key] = bucket;
			return Response.json({ wait: 0 });
		} catch {
			return new Response('Bad Request', { status: 400 });
		}
	}
}

export type RateLimitOptions = {
	maxRequests?: number;
	intervalMs?: number;
	key?: (c: Context) => string;
	message?: string;
	tags?: string[];
};

/**
 * Hono middleware: per-endpoint, per-user/IP rate limiting using in-memory DO buckets
 */
export const rateLimit = (opts: RateLimitOptions = {}) => {
	const maxRequests = opts.maxRequests ?? RateLimiter.defaultMaxRequests;
	const intervalMs = opts.intervalMs ?? RateLimiter.defaultIntervalMs;
	const message = opts.message ?? 'Rate limit exceeded';

	return async (
		c: Context<{
			Bindings: Env;
			Variables: { clientIp?: string };
		}>,
		next: Next,
	) => {
		const url = new URL(c.req.url);
		const path = url.pathname;
		const method = c.req.method;
		const ip = c.get('clientIp') || '0.0.0.0';

		const baseKey = `${method}:${path}:${ip}` + (opts.tags?.length ? `:${opts.tags.join(':')}` : '');
		const key = opts.key ? opts.key(c) : baseKey;

		if (!('BARS_RATE_LIMITER' in c.env) || !c.env.BARS_RATE_LIMITER) {
			return c.text('Rate limiter unavailable', 502);
		}

		const id = c.env.BARS_RATE_LIMITER.idFromName(key);
		const stub = c.env.BARS_RATE_LIMITER.get(id);

		const resp = await stub.fetch('https://stopbars.local/rl', {
			method: 'POST',
			body: JSON.stringify({ key, maxRequests, intervalMs }),
		});

		if (!resp.ok) return c.text('Rate limiter unavailable', 502);

		const data = (await resp.json().catch(() => ({ wait: 0 }))) as { wait: number };

		if (data.wait > 0) {
			const retry = Math.ceil(data.wait / 1000);
			return c.text(message, 429, {
				'Retry-After': String(retry),
				'X-RateLimit-Wait': String(data.wait),
			});
		}

		await next();
	};
};
