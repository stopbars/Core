import type { Context, Next } from 'hono';
import { DurableObject } from 'cloudflare:workers';
import { getClientIp } from './http';

export class RateLimiter extends DurableObject<Env> {
	private count = 0;
	private resetAt = 0;
	static readonly defaultMaxRequests = 20;
	static readonly defaultIntervalMs = 60_000;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
	}

	/** Fast typed RPC path. Each limiter object is already sharded by key. */
	check(maxRequests = RateLimiter.defaultMaxRequests, intervalMs = RateLimiter.defaultIntervalMs): number {
		const now = Date.now();
		if (now >= this.resetAt) {
			this.count = 0;
			this.resetAt = now + intervalMs;
		}

		if (this.count >= maxRequests) {
			return this.resetAt - now;
		}

		this.count += 1;
		return 0;
	}

	async fetch(request: Request): Promise<Response> {
		try {
			type RLBody = Partial<{ key: string; maxRequests: number; intervalMs: number }>;
			const body = await request.json<RLBody>().catch(() => ({}) as RLBody);
			const { key, maxRequests, intervalMs } = body;
			if (!key) return new Response('Missing key', { status: 400 });
			return Response.json({
				wait: this.check(maxRequests ?? RateLimiter.defaultMaxRequests, intervalMs ?? RateLimiter.defaultIntervalMs),
			});
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
		const path = c.req.path;
		const method = c.req.method;
		const ip = c.get('clientIp') || getClientIp(c.req.raw);
		c.set('clientIp', ip);

		const baseKey = `${method}:${path}:${ip}` + (opts.tags?.length ? `:${opts.tags.join(':')}` : '');
		const key = opts.key ? opts.key(c) : baseKey;

		if (!('BARS_RATE_LIMITER' in c.env) || !c.env.BARS_RATE_LIMITER) {
			return c.text('Rate limiter unavailable', 502);
		}

		let wait: number;
		try {
			wait = await c.env.BARS_RATE_LIMITER.getByName(key).check(maxRequests, intervalMs);
		} catch {
			return c.text('Rate limiter unavailable', 502);
		}

		if (wait > 0) {
			const retry = Math.ceil(wait / 1000);
			return c.text(message, 429, {
				'Retry-After': String(retry),
				'X-RateLimit-Wait': String(wait),
			});
		}

		await next();
	};
};
