import { AuthResponse, VatsimUser, VatsimUserResponse } from '../types';
import { HttpError } from './errors';
import { cancelResponseBody } from './http';

export class VatsimService {
	private userCache = new Map<string, { user: VatsimUser; expiresAt: number }>();
	private pendingUserRequests = new Map<string, Promise<VatsimUser>>();
	private pendingConnectionRequests = new Map<string, Promise<string | null>>();
	private readonly userCacheTtlMs: number;

	constructor(
		private clientId: string,
		private clientSecret: string,
		userCacheTtlMs: number = 30000,
	) {
		this.userCacheTtlMs = userCacheTtlMs > 0 ? userCacheTtlMs : 0;
	}

	async getToken(code: string): Promise<AuthResponse> {
		const res = await fetch('https://auth.vatsim.net/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: this.clientId,
				client_secret: this.clientSecret,
				code,
				redirect_uri: 'https://v2.stopbars.com/auth/vatsim/callback',
				scope: 'email full_name vatsim_details',
			}),
		});

		if (!res.ok) {
			await cancelResponseBody(res);
			throw new Error('Failed to get VATSIM token');
		}
		return res.json();
	}

	async getUser(token: string): Promise<VatsimUser> {
		if (this.userCacheTtlMs > 0) {
			const cached = this.userCache.get(token);
			if (cached) {
				if (cached.expiresAt > Date.now()) {
					return cached.user;
				}
				this.userCache.delete(token);
			}
		}
		const pending = this.pendingUserRequests.get(token);
		if (pending) return pending;

		const request = this.fetchAndCacheUser(token);
		this.pendingUserRequests.set(token, request);
		try {
			return await request;
		} finally {
			if (this.pendingUserRequests.get(token) === request) {
				this.pendingUserRequests.delete(token);
			}
		}
	}

	private async fetchAndCacheUser(token: string): Promise<VatsimUser> {
		const res = await fetch('https://auth.vatsim.net/api/user', {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!res.ok) {
			// Translate upstream statuses to client-friendly HTTP errors so routes return 401/403/429/5xx
			// Map common statuses to client-friendly errors
			const status = res.status;
			const text = res.statusText || 'VATSIM API error';
			await cancelResponseBody(res);
			if (status === 401) {
				throw new HttpError(401, 'Unauthorized: invalid or expired VATSIM token');
			}
			if (status === 403) {
				throw new HttpError(403, 'Forbidden: access to VATSIM user endpoint denied');
			}
			if (status === 429) {
				throw new HttpError(429, 'Rate limited by VATSIM');
			}
			if (status >= 500) {
				throw new HttpError(503, `VATSIM service unavailable (${status})`, { statusText: text }, false);
			}
			throw new HttpError(502, `Failed to get VATSIM user (${status})`, { statusText: text }, false);
		}

		const userData = await res.json<VatsimUserResponse>();
		const vatsim = userData.data.vatsim || {};
		const user: VatsimUser = {
			id: userData.data.cid,
			email: userData.data.personal.email,
			first_name: userData.data.personal.name_first || undefined,
			last_name: userData.data.personal.name_last || undefined,
			region: vatsim.region?.id || vatsim.region?.name ? { id: vatsim.region?.id ?? '', name: vatsim.region?.name ?? '' } : null,
			division:
				vatsim.division?.id || vatsim.division?.name ? { id: vatsim.division?.id ?? '', name: vatsim.division?.name ?? '' } : null,
			subdivision:
				vatsim.subdivision?.id || vatsim.subdivision?.name
					? { id: vatsim.subdivision?.id ?? '', name: vatsim.subdivision?.name ?? '' }
					: null,
		};

		if (this.userCacheTtlMs > 0) {
			if (this.userCache.size >= 1024) {
				const now = Date.now();
				for (const [cacheToken, entry] of this.userCache) {
					if (entry.expiresAt <= now) {
						this.userCache.delete(cacheToken);
					}
				}
				if (this.userCache.size >= 1024) {
					const entriesToEvict = this.userCache.size - 511;
					let evicted = 0;
					for (const cacheToken of this.userCache.keys()) {
						this.userCache.delete(cacheToken);
						if (++evicted >= entriesToEvict) break;
					}
				}
			}
			this.userCache.set(token, { user, expiresAt: Date.now() + this.userCacheTtlMs });
		}

		return user;
	}
	async getUserStatus(userId: string): Promise<{ cid: string; callsign: string; type: string } | null> {
		try {
			const text = await this.getUserConnectionsCsv(userId);
			if (text === null) return null;
			const trimmed = text.trim();
			if (!trimmed) {
				return null;
			}

			const parts = trimmed.split(',');
			if (parts.length < 3) {
				return null;
			}

			const [cid, callsign, type] = parts;
			if (!cid || !callsign || !type) {
				return null;
			}

			return { cid, callsign, type };
		} catch {
			return null;
		}
	}

	async getUserConnectionsCsv(userId: string): Promise<string | null> {
		if (!/^\d+$/.test(userId)) {
			return null;
		}

		const pending = this.pendingConnectionRequests.get(userId);
		if (pending) return pending;

		const request = this.fetchUserConnectionsCsv(userId);
		this.pendingConnectionRequests.set(userId, request);
		try {
			return await request;
		} finally {
			if (this.pendingConnectionRequests.get(userId) === request) {
				this.pendingConnectionRequests.delete(userId);
			}
		}
	}

	private async fetchUserConnectionsCsv(userId: string): Promise<string | null> {
		try {
			const params = new URLSearchParams({ cid: userId });
			const url = `https://slurper.vatsim.net/users/info?${params.toString()}`;

			const response = await fetch(url, {
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				await cancelResponseBody(response);
				return null;
			}

			return await response.text();
		} catch {
			return null;
		}
	}
	private readonly ControllerSuffixes = new Set(['DEL', 'RMP', 'GND', 'TWR', 'DEP', 'APP', 'CTR', 'FSS', 'RDO', 'TMU', 'FMP']);

	private getCallsignSuffix(callsign?: string | null): string | null {
		if (!callsign) return null;
		const upper = callsign.toUpperCase();
		const separator = upper.lastIndexOf('_');
		if (separator < 0 || separator === upper.length - 1) return null;
		return upper.slice(separator + 1);
	}

	private isControllerCallsign(callsign?: string | null): boolean {
		const suffix = this.getCallsignSuffix(callsign);
		if (!suffix) return false;
		if (suffix === 'OBS') return false;
		return this.ControllerSuffixes.has(suffix);
	}

	isController(userStatus: { type: string; callsign: string } | null | undefined): boolean {
		return userStatus?.type === 'atc' && this.isControllerCallsign(userStatus?.callsign);
	}

	isPilot(userStatus: { type: string } | null | undefined): boolean {
		return userStatus?.type === 'pilot';
	}

	isObserver(userStatus: { type: string; callsign: string } | null | undefined): boolean {
		return userStatus?.type === 'atc' && !this.isControllerCallsign(userStatus?.callsign);
	}
}
