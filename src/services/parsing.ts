export type DecimalNumberInput = string | number | null | undefined;

export const parseDecimalNumber = (value: DecimalNumberInput): number => {
	if (value === null || value === undefined) return Number.NaN;
	if (Object(value) === value) return Number.NaN;
	return Number(value);
};

export const normalizeIsoDateTime = (value: string | number): string | null => {
	const stringValue = String(value);
	if (stringValue !== value) {
		const numericValue = Number(value);
		if (!Number.isFinite(numericValue)) return null;
		const date = new Date(numericValue);
		return Number.isFinite(date.getTime()) ? date.toISOString() : null;
	}

	const trimmed = stringValue.trim();
	if (!trimmed) return null;
	const timestamp = Date.parse(trimmed);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};
