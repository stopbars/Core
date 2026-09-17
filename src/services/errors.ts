// Lightweight HTTP error for controlled responses through Hono's global onError
export interface HttpErrorDetails {
	statusText?: string;
	cause?: unknown;
}

export class HttpError extends Error {
	status: number;
	details?: HttpErrorDetails;
	expose: boolean;

	constructor(status: number, message: string, details?: HttpErrorDetails, expose = true) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.details = details;
		this.expose = expose;
	}
}
