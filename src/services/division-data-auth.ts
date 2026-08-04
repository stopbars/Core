export const DIVISION_DATA_ACTOR_ID = 'division-data-ci';

type TimingSafeEqual = (left: ArrayBufferView, right: ArrayBufferView) => boolean;

const encoder = new TextEncoder();

export function extractBearerToken(authorization: string): string | null {
	const match = authorization.match(/^\s*Bearer\s+(.+?)\s*$/i);
	return match?.[1] || null;
}

/**
 * Authenticates the division-data CI credential without exposing a user or
 * staff principal. Callers must still explicitly opt into the narrow
 * automation permissions supported by their route.
 */
export function isDivisionDataAutomationRequest(
	authorization: string,
	configuredSecret: string | undefined,
	timingSafeEqual: TimingSafeEqual = crypto.subtle.timingSafeEqual.bind(crypto.subtle),
): boolean {
	const suppliedToken = extractBearerToken(authorization);
	if (!suppliedToken || !configuredSecret) return false;

	const suppliedBytes = encoder.encode(suppliedToken);
	const configuredBytes = encoder.encode(configuredSecret);
	const sameLength = suppliedBytes.byteLength === configuredBytes.byteLength;

	// timingSafeEqual requires equal-length inputs. Comparing the configured
	// value with itself on a length mismatch avoids an early content comparison.
	const comparableBytes = sameLength ? suppliedBytes : configuredBytes;
	return timingSafeEqual(comparableBytes, configuredBytes) && sameLength;
}
