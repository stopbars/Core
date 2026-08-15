// Lightweight PostHog wrapper: fire-and-forget event capture with automatic { product: 'Core' }.

import { waitUntil as cfWaitUntil } from 'cloudflare:workers';
import { cancelResponseBody } from './http';

export type AnalyticsPropertyValue = string | number | boolean | null | undefined | AnalyticsPropertyValue[] | AnalyticsProperties;

export interface AnalyticsProperties {
	[key: string]: AnalyticsPropertyValue;
}

type BackgroundTaskRuntime = typeof globalThis & {
	waitUntil?: (promise: Promise<void>) => void;
};

interface PostHogCapturePayload {
	api_key: string;
	event: string;
	properties: AnalyticsProperties;
	timestamp?: string; // ISO 8601
	$process_person_profile?: boolean;
}

export interface TrackOptions {
	timestamp?: Date | string;
	product?: string;
	omitProduct?: boolean;
	inline?: boolean; // if true, don't background
}

export interface BatchTrackEvent {
	event: string;
	properties?: AnalyticsProperties;
	distinctId?: string;
	timestamp?: Date | string;
}

const PII_KEYS = new Set(['userid', 'vatsimid', 'requestedby', 'approvedby', 'decidedby', 'createdby', 'email', 'cid', 'callsign']);
const UTF8_ENCODER = new TextEncoder();
const BYTE_TO_HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

export class PostHogService {
	private readonly apiKey: string | undefined;
	private readonly host: string;
	private readonly enabled: boolean;
	constructor(env: Env) {
		this.apiKey = env.POSTHOG_API_KEY;
		this.host = (env.POSTHOG_HOST || 'https://a.stopbars.com').replace(/\/$/, '');
		this.enabled = !!this.apiKey;
	}

	private isPIIKey(key: string): boolean {
		const lk = key.toLowerCase();
		return PII_KEYS.has(lk) || lk.includes('vatsim');
	}

	private async hashValue(value: AnalyticsPropertyValue): Promise<string> {
		try {
			const data = UTF8_ENCODER.encode(String(value));
			const digest = await crypto.subtle.digest('SHA-256', data);
			let hex = '';
			for (const byte of new Uint8Array(digest)) hex += BYTE_TO_HEX[byte];
			return hex;
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

	private async sanitizeProperties(props: AnalyticsProperties): Promise<AnalyticsProperties> {
		const sanitized: AnalyticsProperties = {};
		const pendingHashes: Promise<void>[] = [];
		for (const [key, value] of Object.entries(props)) {
			sanitized[key] = value;
			if (value != null && this.isPIIKey(key)) {
				pendingHashes.push(this.hashValue(value).then((hash) => void (sanitized[key] = hash)));
			}
		}
		await Promise.all(pendingHashes);
		return sanitized;
	}

	private async prepareProperties(
		properties: AnalyticsProperties,
		distinctId: string,
		options: Pick<TrackOptions, 'product' | 'omitProduct'>,
	): Promise<AnalyticsProperties> {
		const mergedProps: AnalyticsProperties = { ...properties };
		if (!options.omitProduct && mergedProps.product === undefined) {
			mergedProps.product = options.product || 'Core';
		}
		try {
			if (JSON.stringify(mergedProps).length > 45_000) mergedProps._truncated = true;
		} catch {
			/* ignore */
		}
		return {
			distinct_id: distinctId,
			...(await this.sanitizeProperties(mergedProps)),
		};
	}

	private dispatch(doFetch: () => Promise<void>, inline = false): void | Promise<void> {
		if (inline) return doFetch();
		try {
			cfWaitUntil(doFetch());
			return;
		} catch {
			/* ignore */
		}
		try {
			const runtimeGlobal: BackgroundTaskRuntime = globalThis;
			runtimeGlobal.waitUntil?.(doFetch());
		} catch {
			/* ignore */
		}
	}

	track(
		event: string,
		properties: AnalyticsProperties = {},
		distinctId = 'anonymous',
		options: TrackOptions = {},
	): void | Promise<void> {
		if (!this.enabled) return;
		const buildBody = async () => {
			const payload: PostHogCapturePayload = {
				api_key: this.apiKey!,
				event,
				properties: await this.prepareProperties(properties, distinctId, options),
				$process_person_profile: false,
			};
			if (options.timestamp) {
				payload.timestamp = options.timestamp instanceof Date ? options.timestamp.toISOString() : options.timestamp;
			}
			return JSON.stringify(payload);
		};

		const doFetch = () =>
			buildBody()
				.then((body) =>
					fetch(`${this.host}/capture/`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body,
					}),
				)
				.then((res) => {
					if (!res.ok) {
						console.warn('[PostHog] Non-OK response', res.status);
					}
					return cancelResponseBody(res);
				})
				.catch((err) => {
					console.warn('[PostHog] Track failed', err instanceof Error ? err.message : err);
				});
		return this.dispatch(doFetch, options.inline);
	}

	trackBatch(
		events: readonly BatchTrackEvent[],
		options: Pick<TrackOptions, 'product' | 'omitProduct' | 'inline'> = {},
	): void | Promise<void> {
		if (!this.enabled || events.length === 0) return;

		const doFetch = async () => {
			const batch = await Promise.all(
				events.map(async (item) => {
					const payload: Omit<PostHogCapturePayload, 'api_key'> = {
						event: item.event,
						properties: await this.prepareProperties(item.properties ?? {}, item.distinctId ?? 'anonymous', options),
						$process_person_profile: false,
					};
					if (item.timestamp) {
						payload.timestamp = item.timestamp instanceof Date ? item.timestamp.toISOString() : item.timestamp;
					}
					return payload;
				}),
			);

			return fetch(`${this.host}/batch/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.apiKey!, batch }),
			})
				.then((res) => {
					if (!res.ok) console.warn('[PostHog] Non-OK batch response', res.status);
					return cancelResponseBody(res);
				})
				.catch((err) => {
					console.warn('[PostHog] Batch track failed', err instanceof Error ? err.message : err);
				});
		};

		return this.dispatch(doFetch, options.inline);
	}
}
