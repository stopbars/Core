import { AuthResponse, VatsimUser, VatsimUserResponse } from '../types';

export class VatsimService {
	constructor(
		private clientId: string,
		private clientSecret: string,
	) {}

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
				scope: 'email',
			}),
		});

		if (!res.ok) {
			throw new Error('Failed to get VATSIM token');
		}
		return res.json();
	}

	async getUser(token: string): Promise<VatsimUser> {
		const res = await fetch('https://auth.vatsim.net/api/user', {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!res.ok) {
			throw new Error('Failed to get VATSIM user');
		}

		const userData = (await res.json()) as VatsimUserResponse;
		return {
			id: userData.data.cid,
			email: userData.data.personal.email,
			first_name: userData.data.personal.name_first || undefined,
			last_name: userData.data.personal.name_last || undefined,
		};
	}
	async getUserStatus(userId: string): Promise<{ cid: string; callsign: string; type: string } | null> {
		try {
			if (!/^\d+$/.test(userId)) {
				return null;
			}

			const params = new URLSearchParams({ CID: userId });
			const url = `https://slurper.vatsim.net/users/info?${params.toString()}`;

			const response = await fetch(url, {
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				return null;
			}

			const text = await response.text();
			if (!text.trim()) {
				return null;
			}

			const parts = text.trim().split(',');
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
	isController(userStatus: { type: string; callsign: string } | null | undefined): boolean {
		return userStatus?.type === 'atc' && !this.isObserver(userStatus);
	}

	isPilot(userStatus: { type: string } | null | undefined): boolean {
		return userStatus?.type === 'pilot';
	}

	isObserver(userStatus: { type: string; callsign: string } | null | undefined): boolean {
		return userStatus?.type === 'atc' && userStatus?.callsign?.includes('_OBS');
	}
}
