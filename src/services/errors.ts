// Lightweight HTTP error for controlled responses through Hono's global onError
export class HttpError extends Error {
	status: number;
	details?: unknown;
	expose: boolean;

	constructor(status: number, message: string, details?: unknown, expose = true) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.details = details;
		this.expose = expose;
	}
}
