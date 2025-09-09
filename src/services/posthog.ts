// Lightweight PostHog wrapper: fire-and-forget event capture with automatic { product: 'Core' }.

import { waitUntil as cfWaitUntil } from 'cloudflare:workers';

interface PostHogCapturePayload {
	api_key: string;
	event: string;
	properties: Record<string, unknown>;
	timestamp?: string; // ISO 8601
	$process_person_profile?: boolean;
}

export interface TrackOptions {
	timestamp?: Date | string;
	product?: string;
	omitProduct?: boolean;
	inline?: boolean; // if true, don't background
}

export class PostHogService {
	private readonly apiKey: string | undefined;
	private readonly host: string;
	private readonly enabled: boolean;
	private readonly piiKeyMatchers: Array<(k: string) => boolean> = [
		(k) => k === 'userId',
		(k) => k === 'vatsimId',
		(k) => k === 'requestedBy',
		(k) => k === 'approvedBy',
		(k) => k === 'decidedBy',
		(k) => k === 'createdBy',
		(k) => k === 'email',
		(k) => k === 'cid',
		(k) => k === 'callsign',
		(k) => k.includes('vatsim'),
	];

	constructor(env: Env) {
		this.apiKey = (env as unknown as { POSTHOG_API_KEY?: string }).POSTHOG_API_KEY;
		this.host = (env as unknown as { POSTHOG_HOST?: string }).POSTHOG_HOST || 'https://eu.i.posthog.com';
		this.enabled = !!this.apiKey;
	}

	private isPIIKey(key: string): boolean {
		const lk = key.toLowerCase();
		return this.piiKeyMatchers.some((fn) => fn(lk));
	}

	private async hashValue(value: unknown): Promise<string> {
		try {
			const encoder = new TextEncoder();
			const data = encoder.encode(String(value));
			const digest = await crypto.subtle.digest('SHA-256', data);
			return Array.from(new Uint8Array(digest))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');
		} catch {
			// Fallback simple hash (non-crypto) if subtle fails
			const s = String(value);
			let h = 0;
			for (let i = 0; i < s.length; i++) {
				h = (h * 31 + s.charCodeAt(i)) >>> 0;
			}
			return h.toString(16);
		}
	}

	private async sanitizeProperties(props: Record<string, unknown>): Promise<Record<string, unknown>> {
		const entries = await Promise.all(
			Object.entries(props).map(async ([k, v]) => {
				if (v == null) return [k, v];
				if (this.isPIIKey(k)) {
					return [k, await this.hashValue(v)];
				}
				return [k, v];
			}),
		);
		return Object.fromEntries(entries);
	}

	track(
		event: string,
		properties: Record<string, unknown> = {},
		distinctId = 'anonymous',
		options: TrackOptions = {},
	): void | Promise<void> {
		if (!this.enabled) return;
		const mergedProps: Record<string, unknown> = {
			...properties,
		};
		if (!options.omitProduct) {
			if (mergedProps.product === undefined) mergedProps.product = options.product || 'Core';
		}
		try {
			const approxSize = JSON.stringify(mergedProps).length;
			if (approxSize > 45_000) {
				mergedProps._truncated = true;
			}
		} catch {
			/* ignore */
		}
		const buildBody = async () => {
			const sanitized = await this.sanitizeProperties(mergedProps);
			const payload: PostHogCapturePayload = {
				api_key: this.apiKey!,
				event,
				properties: {
					distinct_id: distinctId,
					...sanitized,
				},
				$process_person_profile: false,
			};
			if (options.timestamp) {
				payload.timestamp = typeof options.timestamp === 'string' ? options.timestamp : options.timestamp.toISOString();
			}
			return JSON.stringify(payload);
		};

		const doFetch = () =>
			buildBody()
				.then((body) =>
					fetch(`${this.host.replace(/\/$/, '')}/capture/`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body,
					}),
				)
				.then((res) => {
					if (!res.ok) {
						console.warn('[PostHog] Non-OK response', res.status);
					}
				})
				.catch((err) => {
					console.warn('[PostHog] Track failed', err instanceof Error ? err.message : err);
				});
		if (options.inline) return doFetch();
		try {
			if (typeof (cfWaitUntil as unknown) === 'function') {
				cfWaitUntil(doFetch());
				return;
			}
		} catch {
			/* ignore */
		}
		try {
			(globalThis as unknown as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil?.(doFetch());
		} catch {
			/* ignore */
		}
		return;
	}
}
