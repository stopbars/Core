export const MAX_CONTRIBUTION_XML_BYTES = 5 * 1024 * 1024; // 5 MB
// XML 1.0 explicitly forbids these C0 controls; a single regex avoids a full-size character array.
// eslint-disable-next-line no-control-regex
const DISALLOWED_XML_CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]', 'g');

export function sanitizeContributionXml(raw: string, opts?: { maxBytes?: number }): string {
	if (!raw) throw new Error('Empty XML');

	const maxBytes = opts?.maxBytes ?? MAX_CONTRIBUTION_XML_BYTES;
	// Reject cheaply by code-unit length first, then enforce the real UTF-8 byte contract.
	if (raw.length > maxBytes || new TextEncoder().encode(raw).byteLength > maxBytes) {
		throw new Error(`Submitted XML too large (> ${maxBytes} bytes)`);
	}

	const trimmed = raw.trim();
	if (!trimmed.startsWith('<?xml')) {
		throw new Error('XML must start with declaration');
	}

	// Quick reject for classic XXE / internal subset attempts
	const forbiddenPatterns: Array<{ re: RegExp; message: string }> = [
		{ re: /<!DOCTYPE/i, message: 'DOCTYPE is not allowed' },
		{ re: /<!ENTITY/i, message: 'ENTITY declarations are not allowed' },
		{ re: /<!ELEMENT/i, message: 'ELEMENT declarations are not allowed' },
		{ re: /SYSTEM\s+"[^"]*"/i, message: 'External SYSTEM identifiers are not allowed' },
		{ re: /PUBLIC\s+"[^"]*"/i, message: 'PUBLIC identifiers are not allowed' },
		{ re: /<\?xml-stylesheet/i, message: 'Stylesheet PIs are not allowed' },
	];
	for (const p of forbiddenPatterns) {
		if (p.re.test(trimmed)) throw new Error(`Invalid XML: ${p.message}`);
	}

	// Ensure required root marker (light supports + BARS processing both expect FSData in contributions)
	if (!/<FSData[\s>]/.test(trimmed)) {
		throw new Error('Invalid XML: Missing FSData root element');
	}

	// Remove any processing instructions after the first line (except XML declaration). Conservative approach.
	let sanitized = trimmed.replace(/(<\?)(?!xml)([\s\S]*?\?>)/gi, '');

	// Strip disallowed control chars (anything below 0x20 except TAB (0x09), LF (0x0A), CR (0x0D))
	sanitized = sanitized.replace(DISALLOWED_XML_CONTROL_CHARS, '');

	// Optional: collapse repeated spaces between tags to keep storage predictable (small normalization)
	sanitized = sanitized.replace(/>\s+</g, '><');

	// Final sanity checks
	if (sanitized.length === 0) throw new Error('Sanitized XML empty');
	if (!sanitized.startsWith('<?xml')) throw new Error('Sanitization error: lost XML declaration');

	return sanitized;
}
