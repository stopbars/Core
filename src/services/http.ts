export async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Best-effort cleanup for response bodies we intentionally do not read.
	}
}

/** Resolve the originating client address only on endpoints that need it. */
export function getClientIp(request: Request): string {
	const headers = request.headers;
	const direct = headers.get('CF-Connecting-IP') || headers.get('X-Real-IP');
	if (direct) return direct;

	const forwardedFor = headers.get('X-Forwarded-For');
	if (forwardedFor) {
		const comma = forwardedFor.indexOf(',');
		return (comma === -1 ? forwardedFor : forwardedFor.slice(0, comma)).trim() || '0.0.0.0';
	}

	const forwarded = headers.get('Forwarded');
	const match = forwarded?.match(/for=([^;]+)/i);
	return match ? match[1].replace(/"/g, '') : '0.0.0.0';
}
