import { Hono } from 'hono';
import openapiSpec from '../openapi.json';
import { cors } from 'hono/cors';
import { PointChangeset, PointData } from './types';
import { VatsimService } from './services/vatsim';
import { AuthService } from './services/auth';
import { StaffRole } from './services/roles';
import { InstallerProduct } from './services/releases';
import { Connection } from './network/connection';
import { UserService } from './services/users';
import { DatabaseContextFactory } from './services/database-context';
import { withCache, CacheKeys } from './services/cache';
import { ServicePool } from './services/service-pool';
import { sanitizeContributionXml } from './services/xml-sanitizer';
const POINT_ID_REGEX = /^[A-Z0-9-_]+$/;

interface CreateDivisionPayload {
	name: string;
	headVatsimId: string;
}

interface AddMemberPayload {
	vatsimId: string;
	role: 'nav_head' | 'nav_member';
}

interface RequestAirportPayload {
	icao: string;
}

interface ApproveAirportPayload {
	approved: boolean;
}

interface ContributionSubmissionPayload {
	airportIcao: string;
	packageName: string;
	submittedXml: string;
	notes?: string;
}

interface ContributionDecisionPayload {
	approved: boolean;
	rejectionReason?: string;
	newPackageName?: string;
}

export class BARS {
	private connection: Connection;

	constructor(
		private state: DurableObjectState,
		private env: Env,
	) {
		const vatsim = new VatsimService(env.VATSIM_CLIENT_ID, env.VATSIM_CLIENT_SECRET);
		const auth = new AuthService(env.DB, vatsim);
		this.connection = new Connection(env, auth, vatsim, state);
	}

	async fetch(request: Request) {
		return this.connection.fetch(request);
	}
}

const app = new Hono<{
	Bindings: Env;
	Variables: {
		vatsimUser?: any;
		user?: any;
		auth?: any;
		vatsim?: any;
		userService?: any;
		clientIp?: string;
	};
}>();

app.use('*', async (c, next) => {
	const start = Date.now();
	await next();
	try {
		const url = new URL(c.req.url);
		const path = url.pathname;
		if (c.req.method === 'OPTIONS') return;
		if (path === '/favicon.ico') return;
		if (path.includes('/health')) return;
		const ignoreRaw = (c.env as any).ANALYTICS_IGNORE as string | undefined;
		if (ignoreRaw) {
			const ignores = ignoreRaw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			for (const pattern of ignores) {
				if (pattern.endsWith('*')) {
					const prefix = pattern.slice(0, -1);
					if (path.startsWith(prefix)) return;
				} else if (pattern === path) {
					return;
				}
			}
		}
		const posthog = ServicePool.getPostHog(c.env);
		posthog.track(
			'API Request',
			{
				path,
				method: c.req.method,
				status: c.res?.status ?? 0,
				duration_ms: Date.now() - start,
			},
			'anonymous',
		);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn('[Analytics] failed', err instanceof Error ? err.message : err);
	}
});

app.use(
	'*',
	cors({
		origin: '*',
		allowHeaders: ['Content-Type', 'Authorization', 'X-Vatsim-Token', 'Upgrade', 'X-Client-Type'],
		allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
	}),
);

app.get('/favicon.ico', (c) => {
	const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axhLZ4AAAAASUVORK5CYII='; // 1x1 transparent PNG
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	return new Response(bytes, {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=604800, immutable',
		},
	});
});

// Extract client IP (best-effort) and attach to context
app.use('*', async (c, next) => {
	const cf = c.req.header('CF-Connecting-IP');
	const real = c.req.header('X-Real-IP');
	const fwdFor = c.req.header('X-Forwarded-For');
	const forwarded = c.req.header('Forwarded');
	let ip: string | undefined = cf || real;
	if (!ip && fwdFor) {
		ip = fwdFor.split(',')[0].trim();
	}
	if (!ip && forwarded) {
		// Forwarded: for=1.2.3.4; proto=http; by=...
		const match = forwarded.match(/for=([^;]+)/i);
		if (match) ip = match[1].replace(/"/g, '');
	}
	c.set('clientIp', ip || '0.0.0.0');
	await next();
});

/**
 * @openapi
 * /contact:
 *   post:
 *     summary: Submit a contact form
 *     tags:
 *       - Contact
 *     description: Public endpoint to submit a contact/support message. Limited to 1 submission per 24 hours per IP.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, topic, message]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               topic:
 *                 type: string
 *               message:
 *                 type: string
 *     responses:
 *       201:
 *         description: Message stored
 *       400:
 *         description: Validation error
 *       429:
 *         description: Rate limited (already submitted within 24h)
 */
app.post('/contact', async (c) => {
	const dbContext = DatabaseContextFactory.createRequestContext(c.env.DB, c.req.raw);
	try {
		let body: any;
		try {
			body = await c.req.json();
		} catch {
			return dbContext.jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
		}
		const email = typeof body.email === 'string' ? body.email.trim() : '';
		const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
		const message = typeof body.message === 'string' ? body.message.trim() : '';
		const ip = c.get('clientIp') || '0.0.0.0';

		const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
		if (!email || !emailRegex.test(email)) {
			return dbContext.jsonResponse({ error: 'Invalid email' }, { status: 400 });
		}
		if (!topic || topic.length < 3 || topic.length > 120) {
			return dbContext.jsonResponse({ error: 'Invalid topic', message: 'topic must be 3-120 chars' }, { status: 400 });
		}
		if (!message || message.length < 5 || message.length > 4000) {
			return dbContext.jsonResponse({ error: 'Invalid message', message: 'message must be 5-4000 chars' }, { status: 400 });
		}

		const contact = ServicePool.getContact(c.env);
		const already = await contact.hasRecentSubmissionFromIp(ip, 24);
		if (already) {
			return dbContext.jsonResponse(
				{ error: 'Rate limited', message: 'Only one submission per 24 hours from this IP' },
				{ status: 429 },
			);
		}
		const stored = await contact.createMessage(email, topic, message, ip);
		return dbContext.jsonResponse({ success: true, id: stored.id, created_at: stored.created_at }, { status: 201 });
	} finally {
		dbContext.close();
	}
});

/**
 * @openapi
 * /contact:
 *   get:
 *     summary: List submitted contact messages
 *     x-hidden: true
 *     tags:
 *       - Contact
 *       - Staff
 *     description: Returns all contact messages (newest first). Requires Product Manager or higher.
 *     security:
 *       - VatsimToken: []
 *     responses:
 *       200:
 *         description: Messages returned
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
app.get('/contact', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) return c.text('Unauthorized', 401);

	const dbContext = DatabaseContextFactory.createRequestContext(c.env.DB, c.req.raw);
	try {
		const vatsim = ServicePool.getVatsim(c.env);
		const auth = ServicePool.getAuth(c.env);
		const roles = ServicePool.getRoles(c.env);
		const vatsimUser = await vatsim.getUser(vatsimToken);
		const user = await auth.getUserByVatsimId(vatsimUser.id);
		if (!user) return dbContext.textResponse('Unauthorized', { status: 401 });

		const allowed = await roles.hasPermission(user.id, StaffRole.PRODUCT_MANAGER);
		if (!allowed) return dbContext.textResponse('Forbidden', { status: 403 });

		const contact = ServicePool.getContact(c.env);
		const messages = await contact.listMessages();
		return dbContext.jsonResponse({ messages });
	} finally {
		dbContext.close();
	}
});

/**
 * @openapi
 * /contact/{id}/status:
 *   patch:
 *     summary: Update contact message status
 *     x-hidden: true
 *     tags:
 *       - Contact
 *       - Staff
 *     description: Set status to pending, handling, or handled. Requires Product Manager or higher.
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, handling, handled]
 *     responses:
 *       200:
 *         description: Updated message returned
 *       400:
 *         description: Invalid status
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Message not found
 */
app.patch('/contact/:id/status', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) return c.text('Unauthorized', 401);
	const id = c.req.param('id');
	const dbContext = DatabaseContextFactory.createRequestContext(c.env.DB, c.req.raw);
	try {
		let body: any;
		try { body = await c.req.json(); } catch { return dbContext.jsonResponse({ error: 'Invalid JSON body' }, { status: 400 }); }
		const status = body?.status;
		if (!['pending', 'handling', 'handled'].includes(status)) {
			return dbContext.jsonResponse({ error: 'Invalid status' }, { status: 400 });
		}
		const vatsim = ServicePool.getVatsim(c.env);
		const auth = ServicePool.getAuth(c.env);
		const roles = ServicePool.getRoles(c.env);
		const vatsimUser = await vatsim.getUser(vatsimToken);
		const user = await auth.getUserByVatsimId(vatsimUser.id);
		if (!user) return dbContext.textResponse('Unauthorized', { status: 401 });
		const allowed = await roles.hasPermission(user.id, StaffRole.PRODUCT_MANAGER);
		if (!allowed) return dbContext.textResponse('Forbidden', { status: 403 });
		const contact = ServicePool.getContact(c.env);
		const existing = await contact.getMessage(id);
		if (!existing) return dbContext.textResponse('Not found', { status: 404 });
		const updated = await contact.updateStatus(id, status, user.vatsim_id);
		return dbContext.jsonResponse({ message: updated });
	} finally {
		dbContext.close();
	}
});

/**
 * @openapi
 * /contact/{id}:
 *   delete:
 *     summary: Delete a contact message
 *     x-hidden: true
 *     tags:
 *       - Contact
 *       - Staff
 *     description: Permanently deletes a contact message. Requires Product Manager or higher.
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Deleted
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Not found
 */
app.delete('/contact/:id', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) return c.text('Unauthorized', 401);
	const id = c.req.param('id');
	const dbContext = DatabaseContextFactory.createRequestContext(c.env.DB, c.req.raw);
	try {
		const vatsim = ServicePool.getVatsim(c.env);
		const auth = ServicePool.getAuth(c.env);
		const roles = ServicePool.getRoles(c.env);
		const vatsimUser = await vatsim.getUser(vatsimToken);
		const user = await auth.getUserByVatsimId(vatsimUser.id);
		if (!user) return dbContext.textResponse('Unauthorized', { status: 401 });
		const allowed = await roles.hasPermission(user.id, StaffRole.PRODUCT_MANAGER);
		if (!allowed) return dbContext.textResponse('Forbidden', { status: 403 });
		const contact = ServicePool.getContact(c.env);
		const existing = await contact.getMessage(id);
		if (!existing) return dbContext.textResponse('Not found', { status: 404 });
		await contact.deleteMessage(id);
		return dbContext.textResponse('', { status: 204 });
	} finally {
		dbContext.close();
	}
});

/**
 * @openapi
 * /connect:
 *   get:
 *     summary: Establish a WebSocket for an airport
 *     tags:
 *       - RealTime
 *     description: |
 *       Performs a WebSocket upgrade to stream real-time airport state. Requires:
 *       - GET with `Upgrade: websocket`
 *       - `airport` (ICAO, 4 chars) & `key` (API key) query params
 *       The API key is forwarded as a Bearer token to the airport's Durable Object for auth.
 *     parameters:
 *       - in: query
 *         name: airport
 *         required: true
 *         description: Airport ICAO (4 alphanumeric characters)
 *         schema:
 *           type: string
 *           minLength: 4
 *           maxLength: 4
 *           pattern: "^[A-Z0-9]{4}$"
 *       - in: query
 *         name: key
 *         required: true
 *         description: User API key
 *         schema:
 *           type: string
 *     responses:
 *       101:
 *         description: WebSocket upgrade accepted
 *       400:
 *         description: Missing/invalid params or not a WebSocket upgrade
 *       401:
 *         description: API key rejected
 */
app.get('/connect', async (c) => {
	const upgradeHeader = c.req.header('Upgrade');
	if (upgradeHeader !== 'websocket') {
		return c.json(
			{
				message: 'This endpoint is for WebSocket connections only. Use a WebSocket client to test.',
			},
			400,
		);
	}

	const airportId = c.req.query('airport');
	const apiKey = c.req.query('key');

	if (!apiKey) {
		return c.text('Missing API key', 400);
	}

	if (!airportId) {
		return c.text('Missing airport ID', 400);
	}

	const newHeaders = new Headers(c.req.raw.headers);
	newHeaders.set('Authorization', `Bearer ${apiKey}`);

	const modifiedRequest = new Request(c.req.raw.url, {
		method: c.req.raw.method,
		headers: newHeaders,
		body: c.req.raw.body,
	});

	const id = c.env.BARS.idFromName(airportId);
	const obj = c.env.BARS.get(id);
	return obj.fetch(modifiedRequest);
});

// State endpoint
/**
 * @openapi
 * /state:
 *   get:
 *     summary: Get current lighting/network state
 *     tags:
 *       - State
 *     description: Retrieves real-time state for a specific airport or all active airports.
 *     parameters:
 *       - in: query
 *         name: airport
 *         required: true
 *         description: ICAO code of airport or 'all' for every active airport
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: State information returned
 *       400:
 *         description: Missing or invalid airport parameter
 */
app.get('/state', async (c) => {
	const airport = c.req.query('airport');
	if (!airport) {
		return c.json(
			{
				error: 'Airport parameter required',
			},
			400,
		);
	}

	// Create database context for this request with bookmark handling
	const dbContext = DatabaseContextFactory.createRequestContext(c.env.DB, c.req.raw);

	try {
		if (airport === 'all') {
			// Use session-aware database operations
			await dbContext.db.executeWrite("DELETE FROM active_objects WHERE last_updated <= datetime('now', '-2 day')");

			const activeObjectsResult = await dbContext.db.executeRead<any>(
				"SELECT id, name FROM active_objects WHERE last_updated > datetime('now', '-2 day')",
			);

			const allStates = await Promise.all(
				activeObjectsResult.results.map(async (obj: any) => {
					const id = c.env.BARS.idFromString(obj.id);
					const durableObj = c.env.BARS.get(id);

					const [airportIcao, controllerCount, pilotCount] = obj.name.split('/');

					const stateRequest = new Request(`https://internal/state?airport=${airportIcao}`, {
						method: 'GET',
						headers: new Headers({
							'X-Request-Type': 'get_state',
						}),
					});

					const response = await durableObj.fetch(stateRequest);
					const state = (await response.json()) as {
						airport: string;
						controllers: string[];
						pilots: string[];
						objects: any[];
					};

					return {
						airport: state.airport,
						controllers: state.controllers,
						pilots: state.pilots,
						objects: state.objects,
						connections: {
							controllers: parseInt(controllerCount) || 0,
							pilots: parseInt(pilotCount) || 0,
						},
					};
				}),
			);

			// Return response with bookmark for consistency
			return dbContext.jsonResponse({
				states: allStates,
			});
		} else {
			const id = c.env.BARS.idFromName(airport);
			const obj = c.env.BARS.get(id);

			if (airport.length !== 4) {
				return dbContext.jsonResponse(
					{
						error: 'Invalid airport ICAO',
					},
					{ status: 400 },
				);
			}

			const stateRequest = new Request(`https://internal/state?airport=${airport}`, {
				method: 'GET',
				headers: new Headers({
					'X-Request-Type': 'get_state',
				}),
			});

			return obj.fetch(stateRequest);
		}
	} finally {
		// Clean up database context
		dbContext.close();
	}
});

// VATSIM auth callback
/**
 * @openapi
 * /auth/vatsim/callback:
 *   get:
 *     summary: VATSIM OAuth callback
 *     tags:
 *       - Auth
 *     description: Exchanges authorization code for a VATSIM token and redirects to frontend with token.
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirect to application with token or error
 *       400:
 *         description: Missing code parameter
 */
app.get('/auth/vatsim/callback', async (c) => {
	const code = c.req.query('code');
	if (!code) {
		return Response.redirect('https://v2.stopbars.com/auth?error=missing_code', 302);
	}

	const auth = ServicePool.getAuth(c.env);

	const { vatsimToken } = await auth.handleCallback(code);
	return Response.redirect(`https://preview.stopbars.com/auth/callback?token=${vatsimToken}`, 302);
});

// Get account info
/**
 * @openapi
 * /auth/account:
 *   get:
 *     summary: Get authenticated account information
 *     tags:
 *       - Auth
 *     security:
 *       - VatsimToken: []
 *     responses:
 *       200:
 *         description: Account found
 *       401:
 *         description: Missing or invalid token
 *       404:
 *         description: User not found
 */
app.get('/auth/account', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	// Create database context for this request
	const dbContext = DatabaseContextFactory.createRequestContext(c.env.DB, c.req.raw);

	try {
		const vatsim = ServicePool.getVatsim(c.env);
		const auth = ServicePool.getAuth(c.env);

		const vatsimUser = await vatsim.getUser(vatsimToken);
		let user = await auth.getUserByVatsimId(vatsimUser.id);
		if (!user) {
			return dbContext.textResponse('User not found', { status: 404 });
		}
		// Backfill full_name if missing locally but available from VATSIM
		if ((!user.full_name || user.full_name.trim() === '') && (vatsimUser.first_name || vatsimUser.last_name)) {
			const newFullName = [vatsimUser.first_name, vatsimUser.last_name].filter(Boolean).join(' ').trim();
			if (newFullName) {
				try {
					await auth.updateFullName(user.id, newFullName);
				} catch {
					/* ignore */
				}
				const refreshed = await auth.getUserByVatsimId(vatsimUser.id);
				if (refreshed) user = refreshed;
			}
		}

		return dbContext.jsonResponse({
			id: user.id,
			vatsim_id: user.vatsim_id,
			email: vatsimUser.email,
			api_key: user.api_key,
			full_name: user.full_name || null,
			display_mode: user.display_mode ?? 0,
			display_name: user.display_name || auth.computeDisplayName(user, vatsimUser),
			created_at: user.created_at,
			last_login: user.last_login,
		});
	} finally {
		dbContext.close();
	}
});

/**
 * @openapi
 * /auth/display-mode:
 *   put:
 *     summary: Update preferred display name mode
 *     tags:
 *       - Auth
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mode]
 *             properties:
 *               mode:
 *                 type: integer
 *                 enum: [0,1,2]
 *                 description: 0=First,1=First LastInitial,2=CID
 *     responses:
 *       200:
 *         description: Updated
 */
app.put('/auth/display-mode', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) return c.text('Unauthorized', 401);

	let body: any;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const rawMode = body?.mode;
	const mode = Number(rawMode);
	if (!Number.isInteger(mode) || ![0, 1, 2].includes(mode)) {
		return c.json({ error: 'Invalid mode', message: 'mode must be integer 0,1,2' }, 400);
	}

	const dbContext = DatabaseContextFactory.createRequestContext(c.env.DB, c.req.raw);
	try {
		const vatsim = ServicePool.getVatsim(c.env);
		const auth = ServicePool.getAuth(c.env);
		const vatsimUser = await vatsim.getUser(vatsimToken);
		const user = await auth.getUserByVatsimId(vatsimUser.id);
		if (!user) return dbContext.textResponse('User not found', { status: 404 });
		await auth.updateDisplayMode(user.id, mode);
		return dbContext.jsonResponse({ mode });
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Unknown error';
		const status = msg.includes('Invalid display mode') ? 400 : 500;
		return dbContext.jsonResponse({ error: 'Failed to update display mode', message: msg }, { status });
	} finally {
		dbContext.close();
	}
});

/**
 * @openapi
 * /auth/regenerate-api-key:
 *   post:
 *     summary: Regenerate API key
 *     tags:
 *       - Auth
 *     description: Generates a new API key for the authenticated user (24h cooldown).
 *     security:
 *       - VatsimToken: []
 *     responses:
 *       200:
 *         description: Key regenerated
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: User not found
 *       429:
 *         description: Rate limited (cooldown not elapsed)
 */
app.post('/auth/regenerate-api-key', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	// Create database context for this request
	const dbContext = DatabaseContextFactory.createRequestContext(c.env.DB, c.req.raw);

	try {
		const vatsim = ServicePool.getVatsim(c.env);
		const auth = ServicePool.getAuth(c.env);

		const vatsimUser = await vatsim.getUser(vatsimToken);
		const user = await auth.getUserByVatsimId(vatsimUser.id);

		if (!user) {
			return dbContext.textResponse('User not found', { status: 404 });
		}

		// Check when the user last regenerated their API key using session-aware query
		const lastRegenerationResult = await dbContext.db.executeRead<{ last_api_key_regen: string }>(
			'SELECT last_api_key_regen FROM users WHERE id = ?',
			[user.id],
		);
		const lastRegeneration = lastRegenerationResult.results[0];

		// If the user has regenerated their API key within the last 24 hours, block the request
		if (lastRegeneration?.last_api_key_regen) {
			const lastRegenTime = new Date(lastRegeneration.last_api_key_regen).getTime();
			const currentTime = Date.now();
			const timeSinceLastRegen = currentTime - lastRegenTime;
			const cooldownMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

			if (timeSinceLastRegen < cooldownMs) {
				// Calculate remaining time in hours and minutes
				const remainingMs = cooldownMs - timeSinceLastRegen;
				const remainingHours = Math.floor(remainingMs / (60 * 60 * 1000));
				const remainingMinutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));

				return dbContext.jsonResponse(
					{
						error: 'Rate limited',
						message: `You can only regenerate your API key once every 24 hours. Please try again in ${remainingHours} hour${remainingHours !== 1 ? 's' : ''}${remainingMinutes > 0 ? ` and ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}` : ''}.`,
						retryAfter: Math.ceil(remainingMs / 1000),
					},
					{ status: 429 },
				);
			}
		}

		// Generate new API key
		const newApiKey = await auth.regenerateApiKey(user.id);

		// Update the last regeneration timestamp using session-aware write
		await dbContext.db.executeWrite("UPDATE users SET last_api_key_regen = datetime('now') WHERE id = ?", [user.id]);

		return dbContext.jsonResponse({
			success: true,
			apiKey: newApiKey,
		});
	} catch (error) {
		return dbContext.jsonResponse(
			{
				error: 'Failed to regenerate API key',
				message: error instanceof Error ? error.message : 'Unknown error',
			},
			{ status: 500 },
		);
	} finally {
		dbContext.close();
	}
});

/**
 * @openapi
 * /auth/delete:
 *   delete:
 *     summary: Delete current user account
 *     tags:
 *       - Auth
 *     security:
 *       - VatsimToken: []
 *     responses:
 *       204:
 *         description: Account deleted
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: User not found
 */
app.delete('/auth/delete', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	try {
		const vatsim = ServicePool.getVatsim(c.env);
		const auth = ServicePool.getAuth(c.env);

		const vatsimUser = await vatsim.getUser(vatsimToken);
		const success = await auth.deleteUserAccount(vatsimUser.id);
		if (!success) {
			return c.text('User not found', 404);
		}
		return c.body(null, 204);
	} catch (error) {
		return c.text('Failed to delete account', 500);
	}
});

/**
 * @openapi
 * /auth/is-staff:
 *   get:
 *     x-hidden: true
 *     summary: Check staff status
 *     tags:
 *       - Staff
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Staff status returned
 *       401:
 *         description: Unauthorized
 */
app.get('/auth/is-staff', withCache(CacheKeys.withUser('is-staff'), 3600, 'auth'), async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader) {
		return c.text('Unauthorized', 401);
	}

	const token = authHeader.replace('Bearer ', '');

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);

	const vatsimUser = await vatsim.getUser(token);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('Unauthorized', 401);
	}

	const isStaff = await roles.isStaff(user.id);
	const role = await roles.getUserRole(user.id);
	return c.json({ isStaff, role });
});

/**
 * @openapi
 * /airports:
 *   get:
 *     summary: Get airport data
 *     tags:
 *       - Airports
 *     description: Fetch airport(s) by ICAO(s) or by continent.
 *     parameters:
 *       - in: query
 *         name: icao
 *         required: false
 *         description: Single ICAO or comma-separated list
 *         schema:
 *           type: string
 *       - in: query
 *         name: continent
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Airport data returned
 *       400:
 *         description: Invalid parameters
 *       404:
 *         description: Airport not found
 */
app.get(
	'/airports',
	withCache(CacheKeys.fromUrl, 31536000, 'airports'), // Cache for 1 year because airports data doesn't change ever :P
	async (c) => {
		const airports = ServicePool.getAirport(c.env);
		const icao = c.req.query('icao');
		const continent = c.req.query('continent');

		try {
			let data;
			if (icao) {
				// Handle batch requests
				if (icao.includes(',')) {
					const icaos = icao.split(',').map((code) => code.trim());
					if (icaos.some((code) => !code.match(/^[A-Z0-9]{4}$/i))) {
						return c.text('Invalid ICAO format', 400);
					}
					data = await airports.getAirports(icaos);
				} else {
					// Single airport request
					data = await airports.getAirport(icao);
					if (!data) {
						return c.text('Airport not found', 404);
					}
				}
			} else if (continent) {
				data = await airports.getAirportsByContinent(continent);
			} else {
				return c.text('Missing query parameter', 400);
			}

			return c.json(data);
		} catch (error) {
			return c.json({ error: 'Failed to fetch airport data' }, 500);
		}
	},
);

/**
 * @openapi
 * /airports/nearest:
 *   get:
 *     summary: Find nearest airport
 *     tags:
 *       - Airports
 *     description: Returns the nearest airport to a given latitude/longitude. Results are cached in 5NM buckets for high performance.
 *     parameters:
 *       - in: query
 *         name: lat
 *         required: true
 *         description: Latitude in decimal degrees (-90 to 90)
 *         schema: { type: number }
 *       - in: query
 *         name: lon
 *         required: true
 *         description: Longitude in decimal degrees (-180 to 180)
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Nearest airport returned
 *       400:
 *         description: Invalid coordinates
 *       404:
 *         description: No airport found
 */
app.get(
	'/airports/nearest',
	withCache(
		(req) => {
			// Bucket cache key by ~5NM (~9.26km). 1 degree lat ~111km => bucket size deg ≈ 9.26/111 ≈ 0.083
			const url = new URL(req.url);
			const lat = parseFloat(url.searchParams.get('lat') || '0');
			const lon = parseFloat(url.searchParams.get('lon') || '0');
			const bucketDeg = 0.083; // ~5NM
			const bucketLat = Math.round(lat / bucketDeg);
			const bucketLon = Math.round(lon / bucketDeg);
			return `/airports/nearest/${bucketLat}_${bucketLon}`;
		},
		600,
		'airports',
	),
	async (c) => {
		const latStr = c.req.query('lat');
		const lonStr = c.req.query('lon');

		if (!latStr || !lonStr) {
			return c.text('Missing lat/lon', 400);
		}
		const lat = parseFloat(latStr);
		const lon = parseFloat(lonStr);
		if (Number.isNaN(lat) || Number.isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			return c.text('Invalid lat/lon', 400);
		}

		try {
			const airports = ServicePool.getAirport(c.env);
			const nearest = await airports.getNearestAirport(lat, lon);
			if (!nearest) return c.text('No airport found', 404);
			return c.json(nearest);
		} catch (err) {
			return c.json({ error: 'Failed to find nearest airport' }, 500);
		}
	},
);

const divisionsApp = new Hono<{
	Bindings: Env;
	Variables: {
		vatsimUser?: any;
		user?: any;
		auth?: any;
		vatsim?: any;
	};
}>();

divisionsApp.use('*', async (c, next) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	c.set('vatsimUser', vatsimUser);
	c.set('user', user);
	c.set('auth', auth);
	c.set('vatsim', vatsim);
	await next();
});

/**
 * @openapi
 * /divisions:
 *   get:
 *     summary: List all divisions
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     responses:
 *       200:
 *         description: Divisions returned
 *       401:
 *         description: Unauthorized
 */
divisionsApp.get('/', async (c) => {
	const divisions = ServicePool.getDivisions(c.env);
	const allDivisions = await divisions.getAllDivisions();
	return c.json(allDivisions);
});

/**
 * @openapi
 * /divisions:
 *   post:
 *     x-hidden: true
 *     summary: Create a new division
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, headVatsimId]
 *             properties:
 *               name:
 *                 type: string
 *               headVatsimId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Division created
 *       403:
 *         description: Forbidden
 */
divisionsApp.post('/', async (c) => {
	const user = c.get('user');
	const roles = ServicePool.getRoles(c.env);
	const divisions = ServicePool.getDivisions(c.env);

	const isLeadDev = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
	if (!isLeadDev) {
		return c.text('Forbidden', 403);
	}

	const { name, headVatsimId } = (await c.req.json()) as CreateDivisionPayload;
	const division = await divisions.createDivision(name, headVatsimId);
	return c.json(division);
});

/**
 * @openapi
 * /divisions/{id}:
 *   put:
 *     x-hidden: true
 *     summary: Update division name
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Division updated
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Division not found
 */
divisionsApp.put('/:id', async (c) => {
	const user = c.get('user');
	const roles = ServicePool.getRoles(c.env);
	const divisions = ServicePool.getDivisions(c.env);
	const id = parseInt(c.req.param('id'));

	const isLeadDev = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
	if (!isLeadDev) return c.text('Forbidden', 403);

	const existing = await divisions.getDivision(id);
	if (!existing) return c.text('Division not found', 404);

	const body = (await c.req.json()) as { name: string };
	if (!body.name || !body.name.trim()) return c.text('Invalid name', 400);

	const updated = await divisions.updateDivisionName(id, body.name.trim());
	return c.json(updated);
});

/**
 * @openapi
 * /divisions/{id}:
 *   delete:
 *     x-hidden: true
 *     summary: Delete a division
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Division deleted
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Division not found
 */
divisionsApp.delete('/:id', async (c) => {
	const user = c.get('user');
	const roles = ServicePool.getRoles(c.env);
	const divisions = ServicePool.getDivisions(c.env);
	const id = parseInt(c.req.param('id'));

	const isLeadDev = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
	if (!isLeadDev) return c.text('Forbidden', 403);

	const existing = await divisions.getDivision(id);
	if (!existing) return c.text('Division not found', 404);

	await divisions.deleteDivision(id);
	return c.body(null, 204);
});

/**
 * @openapi
 * /divisions/user:
 *   get:
 *     summary: Get divisions for current user
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     responses:
 *       200:
 *         description: User divisions returned
 */
divisionsApp.get('/user', withCache(CacheKeys.withUser('divisions'), 3600, 'divisions'), async (c) => {
	const vatsimUser = c.get('vatsimUser');
	const divisions = ServicePool.getDivisions(c.env);

	const userDivisions = await divisions.getUserDivisions(vatsimUser.id);
	return c.json(userDivisions);
});

/**
 * @openapi
 * /divisions/{id}:
 *   get:
 *     summary: Get division details
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Division returned
 *       404:
 *         description: Division not found
 */
divisionsApp.get('/:id', withCache(CacheKeys.fromParams('id'), 2592000, 'divisions'), async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const divisions = ServicePool.getDivisions(c.env);

	const division = await divisions.getDivision(divisionId);
	if (!division) {
		return c.text('Division not found', 404);
	}

	return c.json(division);
});

/**
 * @openapi
 * /divisions/{id}/members:
 *   get:
 *     summary: List division members
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Members listed
 *       404:
 *         description: Division not found
 */
divisionsApp.get('/:id/members', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const divisions = ServicePool.getDivisions(c.env);

	// Verify division exists
	const division = await divisions.getDivision(divisionId);
	if (!division) {
		return c.text('Division not found', 404);
	}

	const members = await divisions.getDivisionMembers(divisionId);
	return c.json(members);
});

/**
 * @openapi
 * /divisions/{id}/members:
 *   post:
 *     x-hidden: true
 *     summary: Add member to division
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vatsimId, role]
 *             properties:
 *               vatsimId:
 *                 type: string
 *               role:
 *                 type: string
 *     responses:
 *       200:
 *         description: Member added
 *       403:
 *         description: Forbidden
 */
divisionsApp.post('/:id/members', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const vatsimUser = c.get('vatsimUser');
	const divisions = ServicePool.getDivisions(c.env);

	// Verify division exists
	const division = await divisions.getDivision(divisionId);
	if (!division) {
		return c.text('Division not found', 404);
	}

	const userRole = await divisions.getMemberRole(divisionId, vatsimUser.id);
	if (userRole !== 'nav_head') {
		return c.text('Forbidden', 403);
	}

	const { vatsimId, role } = (await c.req.json()) as AddMemberPayload;
	const member = await divisions.addMember(divisionId, vatsimId, role);
	return c.json(member);
});

/**
 * @openapi
 * /divisions/{id}/members/{vatsimId}:
 *   delete:
 *     x-hidden: true
 *     summary: Remove member from division
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: vatsimId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Member removed
 *       403:
 *         description: Forbidden
 */
divisionsApp.delete('/:id/members/:vatsimId', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const targetVatsimId = c.req.param('vatsimId');
	const vatsimUser = c.get('vatsimUser');
	const divisions = ServicePool.getDivisions(c.env);

	// Verify division exists
	const division = await divisions.getDivision(divisionId);
	if (!division) {
		return c.text('Division not found', 404);
	}

	const userRole = await divisions.getMemberRole(divisionId, vatsimUser.id);
	if (userRole !== 'nav_head') {
		return c.text('Forbidden', 403);
	}

	// Prevent removing yourself
	if (targetVatsimId === vatsimUser.id.toString()) {
		return c.text('Cannot remove yourself from the division', 400);
	}

	await divisions.removeMember(divisionId, targetVatsimId);
	return c.body(null, 204);
});

/**
 * @openapi
 * /divisions/{id}/airports:
 *   get:
 *     summary: List division airports
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Airports listed
 *       404:
 *         description: Division not found
 */
divisionsApp.get('/:id/airports', withCache(CacheKeys.fromParams('id'), 600, 'divisions'), async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const divisions = ServicePool.getDivisions(c.env);

	// Verify division exists
	const division = await divisions.getDivision(divisionId);
	if (!division) {
		return c.text('Division not found', 404);
	}

	const airports = await divisions.getDivisionAirports(divisionId);
	return c.json(airports);
});

/**
 * @openapi
 * /divisions/{id}/airports:
 *   post:
 *     x-hidden: true
 *     summary: Request airport addition to division
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [icao]
 *             properties:
 *               icao:
 *                 type: string
 *     responses:
 *       200:
 *         description: Airport request created
 *       404:
 *         description: Division not found
 */
divisionsApp.post('/:id/airports', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const vatsimUser = c.get('vatsimUser');
	const divisions = ServicePool.getDivisions(c.env);

	// Verify division exists
	const division = await divisions.getDivision(divisionId);
	if (!division) {
		return c.text('Division not found', 404);
	}

	const { icao } = (await c.req.json()) as RequestAirportPayload;
	const airport = await divisions.requestAirport(divisionId, icao, vatsimUser.id);
	return c.json(airport);
});

// POST /divisions/:id/airports/:airportId/approve - Approve/reject airport (requires lead_developer role)
/**
 * @openapi
 * /divisions/{id}/airports/{airportId}/approve:
 *   post:
 *     x-hidden: true
 *     summary: Approve or reject airport request
 *     tags:
 *       - Divisions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: airportId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [approved]
 *             properties:
 *               approved:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Airport approval processed
 *       403:
 *         description: Forbidden
 */
divisionsApp.post('/:id/airports/:airportId/approve', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const airportId = parseInt(c.req.param('airportId'));
	const user = c.get('user');
	const vatsimUser = c.get('vatsimUser');
	const roles = ServicePool.getRoles(c.env);
	const divisions = ServicePool.getDivisions(c.env);

	// Verify division exists
	const division = await divisions.getDivision(divisionId);
	if (!division) {
		return c.text('Division not found', 404);
	}

	const isLeadDev = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
	if (!isLeadDev) {
		return c.text('Forbidden', 403);
	}

	const { approved } = (await c.req.json()) as ApproveAirportPayload;
	const airport = await divisions.approveAirport(airportId, vatsimUser.id, approved);
	return c.json(airport);
});

app.route('/divisions', divisionsApp);

// Points endpoints
/**
 * @openapi
 * /airports/{icao}/points:
 *   get:
 *     summary: List lighting/navigation points for airport
 *     tags:
 *       - Points
 *     parameters:
 *       - in: path
 *         name: icao
 *         required: true
 *         schema: { type: string, minLength: 4, maxLength: 4 }
 *     responses:
 *       200:
 *         description: Points returned
 *       400:
 *         description: Invalid ICAO
 */
app.get(
	'/airports/:icao/points',
	withCache(CacheKeys.fromUrl, 600, 'airports'), // 1296000 - For after beta
	async (c) => {
		const airportId = c.req.param('icao');

		// Validate ICAO format (exactly 4 uppercase letters/numbers)
		if (!airportId.match(/^[A-Z0-9]{4}$/)) {
			return c.text('Invalid airport ICAO format', 400);
		}

		const points = ServicePool.getPoints(c.env);

		const airportPoints = await points.getAirportPoints(airportId);
		return c.json(airportPoints);
	},
);

/**
 * @openapi
 * /airports/{icao}/points:
 *   post:
 *     x-hidden: true
 *     summary: Create a single point
 *     tags:
 *       - Points
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: icao
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PointData'
 *     responses:
 *       201:
 *         description: Point created
 *       401:
 *         description: Unauthorized
 */
app.post('/airports/:icao/points', async (c) => {
	const airportId = c.req.param('icao');

	// Validate ICAO format (exactly 4 uppercase letters/numbers)
	if (!airportId.match(/^[A-Z0-9]{4}$/)) {
		return c.text('Invalid airport ICAO format', 400);
	}

	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) {
		return c.text('Unauthorized', 401);
	}

	const points = ServicePool.getPoints(c.env);

	const pointData = (await c.req.json()) as PointData;
	const newPoint = await points.createPoint(airportId, user.vatsim_id, pointData);
	return c.json(newPoint, 201);
});

// OSM-style batched transaction
/**
 * @openapi
 * /airports/{icao}/points/batch:
 *   post:
 *     x-hidden: true
 *     summary: Apply a batch point changeset
 *     tags:
 *       - Points
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: icao
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PointChangeset'
 *     responses:
 *       201:
 *         description: Changeset applied
 */
app.post('/airports/:icao/points/batch', async (c) => {
	const airportId = c.req.param('icao');

	// Validate ICAO format (exactly 4 uppercase letters/numbers)
	if (!airportId.match(/^[A-Z0-9]{4}$/)) {
		return c.text('Invalid airport ICAO format', 400);
	}

	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) {
		return c.text('Unauthorized', 401);
	}

	const points = ServicePool.getPoints(c.env);

	const changeset = (await c.req.json()) as PointChangeset;
	const newPoints = await points.applyChangeset(airportId, user.vatsim_id, changeset);
	return c.json(newPoints, 201);
});

/**
 * @openapi
 * /airports/{icao}/points/{id}:
 *   put:
 *     x-hidden: true
 *     summary: Update a point
 *     tags:
 *       - Points
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: icao
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Point updated
 */
app.put('/airports/:icao/points/:id', async (c) => {
	const airportId = c.req.param('icao');
	const pointId = c.req.param('id');

	// Validate ICAO format (exactly 4 uppercase letters/numbers)
	if (!airportId.match(/^[A-Z0-9]{4}$/)) {
		return c.text('Invalid airport ICAO format', 400);
	}

	// Validate point ID format (alphanumeric, dash, underscore)
	if (!pointId.match(POINT_ID_REGEX)) {
		return c.text('Invalid point ID format', 400);
	}

	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) {
		return c.text('Unauthorized', 401);
	}

	const points = ServicePool.getPoints(c.env);

	const updates = (await c.req.json()) as Partial<PointData>;
	const updatedPoint = await points.updatePoint(pointId, vatsimUser.id, updates);
	return c.json(updatedPoint);
});

/**
 * @openapi
 * /airports/{icao}/points/{id}:
 *   delete:
 *     x-hidden: true
 *     summary: Delete a point
 *     tags:
 *       - Points
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: icao
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Deleted
 */
app.delete('/airports/:icao/points/:id', async (c) => {
	const airportId = c.req.param('icao');
	const pointId = c.req.param('id');

	// Validate ICAO format (exactly 4 uppercase letters/numbers)
	if (!airportId.match(/^[A-Z0-9]{4}$/)) {
		return c.text('Invalid airport ICAO format', 400);
	}

	// Validate point ID format (alphanumeric, dash, underscore)
	if (!pointId.match(POINT_ID_REGEX)) {
		return c.text('Invalid point ID format', 400);
	}

	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) {
		return c.text('Unauthorized', 401);
	}

	const points = ServicePool.getPoints(c.env);

	try {
		await points.deletePoint(pointId, vatsimUser.id);
		return c.body(null, 204);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'An unknown error occurred';
		return c.json({ error: message }, 403);
	}
});

/**
 * @openapi
 * /points/{id}:
 *   get:
 *     summary: Get a single point by ID
 *     tags:
 *       - Points
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Point found
 *       404:
 *         description: Not found
 */
app.get('/points/:id', withCache(CacheKeys.fromUrl, 3600, 'points'), async (c) => {
	const pointId = c.req.param('id');

	// Validate point ID format (alphanumeric, dash, underscore)
	if (!pointId.match(POINT_ID_REGEX)) {
		return c.text('Invalid point ID format', 400);
	}

	const points = ServicePool.getPoints(c.env);
	const point = await points.getPoint(pointId);

	if (!point) {
		return c.text('Point not found', 404);
	}

	return c.json(point);
});

// Get multiple points by IDs (batch endpoint)
/**
 * @openapi
 * /points:
 *   get:
 *     summary: Get multiple points by IDs
 *     tags:
 *       - Points
 *     parameters:
 *       - in: query
 *         name: ids
 *         required: true
 *         description: Comma-separated list of point IDs (max 100)
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Points returned
 *       400:
 *         description: Validation error
 */
app.get('/points', withCache(CacheKeys.fromUrl, 3600, 'points'), async (c) => {
	const ids = c.req.query('ids');

	if (!ids) {
		return c.json(
			{
				error: 'Missing ids query parameter',
				message: 'Provide comma-separated point IDs: /points?ids=id1,id2,id3',
			},
			400,
		);
	}

	// Parse and validate point IDs
	const pointIds = ids
		.split(',')
		.map((id) => id.trim())
		.filter((id) => id.length > 0);

	if (pointIds.length === 0) {
		return c.json(
			{
				error: 'No valid point IDs provided',
			},
			400,
		);
	}

	if (pointIds.length > 100) {
		return c.json(
			{
				error: 'Too many point IDs requested',
				message: 'Maximum 100 points can be requested at once',
			},
			400,
		);
	}

	const invalidIds = pointIds.filter((id) => !id.match(POINT_ID_REGEX));
	if (invalidIds.length > 0) {
		return c.json(
			{
				error: 'Invalid point ID format',
				invalidIds,
			},
			400,
		);
	}

	const points = ServicePool.getPoints(c.env);

	// Fetch all points in parallel
	const pointPromises = pointIds.map((id) => points.getPoint(id));
	const pointResults = await Promise.all(pointPromises);

	// Filter out null results and create response
	const foundPoints = pointResults.filter((point) => point !== null);
	const foundIds = foundPoints.map((point) => point!.id);
	const notFoundIds = pointIds.filter((id) => !foundIds.includes(id));

	return c.json({
		points: foundPoints,
		requested: pointIds.length,
		found: foundPoints.length,
		notFound: notFoundIds.length > 0 ? notFoundIds : undefined,
	});
});

/**
 * @openapi
 * /supports/generate:
 *   post:
 *     summary: Generate Light Supports and BARS XML
 *     tags:
 *       - Generation
 *     description: Upload raw XML and generate both light supports XML and processed BARS XML.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [xmlFile, icao]
 *             properties:
 *               xmlFile:
 *                 type: string
 *                 format: binary
 *               icao:
 *                 type: string
 *     responses:
 *       200:
 *         description: Generated XML returned
 *       400:
 *         description: Validation error
 */
app.post('/supports/generate', async (c) => {
	try {
		const formData = await c.req.formData();
		const xmlFile = formData.get('xmlFile');
		const icao = formData.get('icao')?.toString();

		if (!xmlFile || !(xmlFile instanceof File)) {
			return c.json({ error: 'XML file is required' }, 400);
		}
		if (!icao) {
			return c.json({ error: 'ICAO code is required' }, 400);
		}

		const MAX_XML_BYTES = 200_000;
		if (xmlFile.size > MAX_XML_BYTES) {
			return c.json({ error: `XML file too large (>${MAX_XML_BYTES} bytes)` }, 400);
		}

		const rawXml = await xmlFile.text();

		let sanitized: string;
		try {
			sanitized = sanitizeContributionXml(rawXml, { maxBytes: MAX_XML_BYTES });
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Invalid XML';
			return c.json({ error: msg }, 400);
		}

		const supportService = ServicePool.getSupport(c.env);
		const polygonService = ServicePool.getPolygons(c.env);

		const [supportsXml, barsXml] = await Promise.all([
			supportService.generateLightSupportsXML(sanitized, icao),
			polygonService.processBarsXML(sanitized, icao),
		]);

		return c.json({ supportsXml, barsXml });
	} catch (error) {
		console.error('Error generating XMLs:', error);
		return c.json({ error: error instanceof Error ? error.message : 'Unknown error generating XMLs' }, 500);
	}
});

/**
 * @openapi
 * /notam:
 *   get:
 *     summary: Get global NOTAM
 *     tags:
 *       - NOTAM
 *     responses:
 *       200:
 *         description: Current NOTAM returned
 */
app.get(
	'/notam',
	withCache(() => 'global-notam', 900, 'notam'),
	async (c) => {
		const notamService = ServicePool.getNotam(c.env);
		const notamData = await notamService.getGlobalNotam();
		return c.json({
			notam: notamData?.content || null,
			type: notamData?.type || 'warning',
		});
	},
);

/**
 * @openapi
 * /notam:
 *   put:
 *     x-hidden: true
 *     summary: Update global NOTAM
 *     tags:
 *       - NOTAM
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *               type:
 *                 type: string
 *     responses:
 *       200:
 *         description: NOTAM updated
 *       403:
 *         description: Forbidden
 */
app.put('/notam', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	// Check if user has staff permissions
	const isStaff = await roles.isStaff(user.id);
	if (!isStaff) {
		return c.text('Forbidden', 403);
	}

	// Update the NOTAM
	const { content, type } = (await c.req.json()) as { content: string; type?: string };
	const notamService = ServicePool.getNotam(c.env);
	const updated = await notamService.updateGlobalNotam(content, type, user.vatsim_id);

	if (!updated) {
		return c.json({ error: 'Failed to update NOTAM' }, 500);
	}

	return c.json({ success: true });
});

const staffUsersApp = new Hono<{
	Bindings: Env;
	Variables: {
		user?: any;
		userService?: any;
		clientIp?: string;
	};
}>();

staffUsersApp.use('*', async (c, next) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	c.set('user', user);
	c.set('userService', new UserService(c.env.DB, roles, auth));
	await next();
});

/**
 * @openapi
 * /staff/users:
 *   get:
 *     x-hidden: true
 *     summary: List users (staff only)
 *     tags:
 *       - Staff
 *     security:
 *       - VatsimToken: []
 *     responses:
 *       200:
 *         description: Users returned
 *       401:
 *         description: Unauthorized
 */
staffUsersApp.get('/', async (c) => {
	try {
		const user = c.get('user');
		const userService = c.get('userService');

		const page = 1; // Default to page 1 for user contributions
		const limit = Number.MAX_SAFE_INTEGER; // Default to max limit for user contributions

		const result = await userService.getAllUsers(page, limit, user.id);
		return c.json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'An unknown error occurred';
		const status = error instanceof Error && error.message.includes('Unauthorized') ? 403 : 500;
		return c.json({ error: message }, status);
	}
});

/**
 * @openapi
 * /staff/users/search:
 *   get:
 *     x-hidden: true
 *     summary: Search users (staff only)
 *     tags:
 *       - Staff
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string, minLength: 3 }
 *     responses:
 *       200:
 *         description: Search results returned
 *       400:
 *         description: Invalid query
 */
staffUsersApp.get('/search', async (c) => {
	try {
		const query = c.req.query('q') || '';
		if (query.length < 3) {
			return c.json(
				{
					error: 'Search query must be at least 3 characters',
				},
				400,
			);
		}

		const user = c.get('user');
		const userService = c.get('userService');

		const results = await userService.searchUsers(query, user.id);
		return c.json({ users: results });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'An unknown error occurred';
		const status = error instanceof Error && error.message.includes('Unauthorized') ? 403 : 500;
		return c.json({ error: message }, status);
	}
});

/**
 * @openapi
 * /staff/users/refresh-api-token:
 *   post:
 *     x-hidden: true
 *     summary: Refresh a user's API token (staff only)
 *     tags:
 *       - Staff
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vatsimId]
 *             properties:
 *               vatsimId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token refreshed
 */
staffUsersApp.post('/refresh-api-token', async (c) => {
	try {
		const { vatsimId } = (await c.req.json()) as { vatsimId: string };

		if (!vatsimId) {
			return c.json(
				{
					error: 'VATSIM ID is required',
				},
				400,
			);
		}

		const user = c.get('user');
		const userService = c.get('userService');

		await userService.refreshUserApiToken(vatsimId, user.id);

		return c.json({
			success: true,
			vatsimId,
			message: 'API token has been successfully refreshed',
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'An unknown error occurred';
		let status = 500;

		if (error instanceof Error) {
			if (error.message.includes('Unauthorized')) {
				status = 403;
			} else if (error.message.includes('User not found')) {
				status = 404;
			}
		}

		return c.json({ error: message }, status as any);
	}
});

// DELETE /staff/users/:id - Delete a user
/**
 * @openapi
 * /staff/users/{id}:
 *   delete:
 *     x-hidden: true
 *     summary: Delete a user (staff only)
 *     tags:
 *       - Staff
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: User deletion result
 */
staffUsersApp.delete('/:id', async (c) => {
	try {
		const userId = parseInt(c.req.param('id'));
		const user = c.get('user');
		const userService = c.get('userService');

		const success = await userService.deleteUser(userId, user.id);
		return c.json({ success });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'An unknown error occurred';
		const status = error instanceof Error && error.message.includes('Unauthorized') ? 403 : 500;
		return c.json({ error: message }, status);
	}
});

app.route('/staff/users', staffUsersApp);

// Staff management (lead developer only) – manage staff roles
const staffManageApp = new Hono<{ Bindings: Env }>();

/**
 * @openapi
 * /staff/manage:
 *   get:
 *     x-hidden: true
 *     summary: List staff members
 *     tags: [Staff]
 *     security:
 *       - VatsimToken: []
 *     responses:
 *       200: { description: Staff listed }
 *       403: { description: Forbidden }
 */
staffManageApp.get('/', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) return c.text('Unauthorized', 401);
	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);
	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) return c.text('User not found', 404);
	const allowed = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
	if (!allowed) return c.text('Forbidden', 403);
	const staff = await roles.listStaff();
	return c.json({ staff });
});

/**
 * @openapi
 * /staff/manage:
 *   post:
 *     x-hidden: true
 *     summary: Add or update a staff member
 *     tags: [Staff]
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vatsimId, role]
 *             properties:
 *               vatsimId: { type: string }
 *               role: { type: string, enum: [LEAD_DEVELOPER, PRODUCT_MANAGER] }
 *     responses:
 *       200: { description: Staff added/updated }
 *       403: { description: Forbidden }
 */
staffManageApp.post('/', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) return c.text('Unauthorized', 401);
	let body: any; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
	const { vatsimId, role } = body || {};
	if (!vatsimId || !role || !(role in StaffRole)) return c.json({ error: 'vatsimId and valid role required' }, 400);
	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);
	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) return c.text('User not found', 404);
	const allowed = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
	if (!allowed) return c.text('Forbidden', 403);
	const targetUser = await auth.getUserByVatsimId(vatsimId);
	if (!targetUser) return c.json({ error: 'Target user not found' }, 404);
	try {
		const staff = await roles.addStaff(targetUser.id, role as StaffRole);
		return c.json({ success: true, staff });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : 'Failed to add/update staff' }, 400);
	}
});

/**
 * @openapi
 * /staff/manage/{vatsimId}:
 *   delete:
 *     x-hidden: true
 *     summary: Remove staff member
 *     tags: [Staff]
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: vatsimId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Staff removed }
 *       403: { description: Forbidden }
 */
staffManageApp.delete('/:vatsimId', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) return c.text('Unauthorized', 401);
	const targetVatsimId = c.req.param('vatsimId');
	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);
	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) return c.text('User not found', 404);
	const allowed = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
	if (!allowed) return c.text('Forbidden', 403);
	const targetUser = await auth.getUserByVatsimId(targetVatsimId);
	if (!targetUser) return c.json({ error: 'Target user not found' }, 404);
	try {
		const removed = await roles.removeStaff(targetUser.id);
		return c.json({ success: removed });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : 'Failed to remove staff' }, 400);
	}
});

app.route('/staff/manage', staffManageApp);

// Contributions endpoints
const contributionsApp = new Hono<{ Bindings: Env }>();

/**
 * @openapi
 * /contributions:
 *   get:
 *     summary: List contributions
 *     tags:
 *       - Contributions
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: airport
 *         schema: { type: string }
 *       - in: query
 *         name: user
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Contributions listed
 */
contributionsApp.get('/', async (c) => {
	const contributions = ServicePool.getContributions(c.env);

	// Parse query parameters for filtering
	const status = (c.req.query('status') as 'pending' | 'approved' | 'rejected' | 'outdated' | 'all') || 'all';
	const airportIcao = c.req.query('airport') || undefined;
	const userId = c.req.query('user') || undefined;
	const page = 1; // Default to page 1 for user contributions
	const limit = Number.MAX_SAFE_INTEGER;

	// Get contributions with filters
	const result = await contributions.listContributions({
		status,
		airportIcao,
		userId,
		page,
		limit,
	});

	return c.json(result);
});

/**
 * @openapi
 * /contributions/leaderboard:
 *   get:
 *     summary: Get top contributors
 *     tags:
 *       - Contributions
 *     responses:
 *       200:
 *         description: Leaderboard returned
 */
contributionsApp.get(
	'/leaderboard',
	withCache(() => 'contribution-leaderboard', 1800, 'contributions'),
	async (c) => {
		const contributions = ServicePool.getContributions(c.env);
		const leaderboard = await contributions.getContributionLeaderboard();
		return c.json(leaderboard);
	},
);

/**
 * @openapi
 * /contributions/top-packages:
 *   get:
 *     summary: Get most used packages
 *     tags:
 *       - Contributions
 *     responses:
 *       200:
 *         description: Package stats returned
 */
contributionsApp.get(
	'/top-packages',
	withCache(() => 'contribution-top-packages', 1800, 'contributions'),
	async (c) => {
		const contributions = ServicePool.getContributions(c.env);
		const topPackages = await contributions.getTopPackages();
		return c.json(topPackages);
	},
);

/**
 * @openapi
 * /contributions:
 *   post:
 *     summary: Submit a new contribution
 *     tags:
 *       - Contributions
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [airportIcao, packageName, submittedXml]
 *             properties:
 *               airportIcao: { type: string }
 *               packageName: { type: string }
 *               submittedXml: { type: string }
 *               notes: { type: string }
 *     responses:
 *       201:
 *         description: Contribution created
 */
contributionsApp.post('/', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	try {
		const contributions = ServicePool.getContributions(c.env);
		const payload = (await c.req.json()) as ContributionSubmissionPayload;
		const result = await contributions.createContribution({
			userId: user.vatsim_id,
			airportIcao: payload.airportIcao,
			packageName: payload.packageName,
			submittedXml: payload.submittedXml,
			notes: payload.notes,
		});

		return c.json(result, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'An unknown error occurred';
		return c.json({ error: message }, 400);
	}
});

/**
 * @openapi
 * /contributions/user:
 *   get:
 *     summary: Get current user's contributions
 *     tags:
 *       - Contributions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Contributions returned
 */
contributionsApp.get('/user', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	// Parse query parameters
	const status = (c.req.query('status') as 'pending' | 'approved' | 'rejected' | 'all') || 'all';
	const page = 1; // Default to page 1 for user contributions
	const limit = Number.MAX_SAFE_INTEGER;

	const contributions = ServicePool.getContributions(c.env);
	const result = await contributions.getUserContributions(user.vatsim_id, {
		status,
		page,
		limit,
	});

	return c.json(result);
});

/**
 * @openapi
 * /contributions/{id}:
 *   get:
 *     summary: Get a specific contribution
 *     tags:
 *       - Contributions
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Contribution returned
 *       404:
 *         description: Not found
 */
contributionsApp.get('/:id', async (c) => {
	const contributionId = c.req.param('id');
	const contributions = ServicePool.getContributions(c.env);
	const contribution = await contributions.getContribution(contributionId);

	if (!contribution) {
		return c.text('Contribution not found', 404);
	}

	return c.json(contribution);
});

// POST /contributions/:id/decision - Process a decision (approve/reject)
/**
 * @openapi
 * /contributions/{id}/decision:
 *   post:
 *     x-hidden: true
 *     summary: Approve or reject a contribution
 *     tags:
 *       - Contributions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [approved]
 *             properties:
 *               approved: { type: boolean }
 *               rejectionReason: { type: string }
 *               newPackageName: { type: string }
 *     responses:
 *       200:
 *         description: Decision processed
 *       403:
 *         description: Not authorized
 */
contributionsApp.post('/:id/decision', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	try {
		const contributionId = c.req.param('id');
		const contributions = ServicePool.getContributions(c.env);
		const payload = (await c.req.json()) as ContributionDecisionPayload;
		const result = await contributions.processDecision(contributionId, user.vatsim_id, {
			approved: payload.approved,
			rejectionReason: payload.rejectionReason,
			newPackageName: payload.newPackageName,
		});

		return c.json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'An unknown error occurred';
		const status = error instanceof Error && error.message.includes('Not authorized') ? 403 : 400;
		return c.json({ error: message }, status);
	}
});

// DELETE /contributions/:id - Delete a contribution (admin only)
/**
 * @openapi
 * /contributions/{id}:
 *   delete:
 *     x-hidden: true
 *     summary: Delete a contribution
 *     tags:
 *       - Contributions
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deletion result
 */
contributionsApp.delete('/:id', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	try {
		const contributionId = c.req.param('id');
		const contributions = ServicePool.getContributions(c.env);
		const success = await contributions.deleteContribution(contributionId, user.vatsim_id);

		return c.json({ success });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'An unknown error occurred';
		const status = error instanceof Error && error.message.includes('Not authorized') ? 403 : 400;
		return c.json({ error: message }, status);
	}
});

app.route('/contributions', contributionsApp);

const cdnApp = new Hono<{ Bindings: Env }>();

/**
 * @openapi
 * /maps/{icao}/packages/{package}/latest:
 *   get:
 *     summary: Get latest approved BARS map XML (raw content) for an airport & package
 *     tags:
 *       - Generation
 *     parameters:
 *       - in: path
 *         name: icao
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: package
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: BARS XML document returned inline (application/xml)
 *       404:
 *         description: Not found
 */
app.get('/maps/:icao/packages/:package/latest', withCache(CacheKeys.fromUrl, 900, 'airports'), async (c) => {
	const icao = c.req.param('icao').toUpperCase();
	const pkg = c.req.param('package');
	const contributions = ServicePool.getContributions(c.env);
	const storage = ServicePool.getStorage(c.env);

	const latest = await contributions.getLatestApprovedContributionForAirportPackage(icao, pkg);
	if (!latest) {
		return c.text('No approved map found', 404);
	}

	const safePackageName = latest.packageName.replace(/[^a-zA-Z0-9.-]/g, '-');
	const fileKey = `Maps/${icao}_${safePackageName}_bars.xml`;

	const stored = await storage.getFile(fileKey);
	if (!stored) {
		return c.text('Map file not found', 404);
	}
	if (!stored.headers.get('content-type')) {
		stored.headers.set('content-type', 'application/xml; charset=utf-8');
	}
	return stored;
});

/**
 * @openapi
 * /cdn/files/{fileKey}:
 *   get:
 *     summary: Download a file from CDN
 *     tags:
 *       - CDN
 *     parameters:
 *       - in: path
 *         name: fileKey
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: File stream
 *       404:
 *         description: Not found
 */
cdnApp.get('/files/*', async (c) => {
	// Extract the file key from the URL - everything after /cdn/files/
	const fileKey = c.req.param('*');

	if (!fileKey) {
		return c.text('File not found', 404);
	}

	const storage = ServicePool.getStorage(c.env);

	// Bypass rate limiting for file downloads to ensure fast CDN performance
	const fileResponse = await storage.getFile(fileKey);

	if (!fileResponse) {
		return c.text('File not found', 404);
	}

	// Return the file directly with proper headers for caching
	return fileResponse;
});

/**
 * @openapi
 * /cdn/upload:
 *   post:
 *     x-hidden: true
 *     summary: Upload a file to CDN (staff only)
 *     tags:
 *       - CDN
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               path:
 *                 type: string
 *               key:
 *                 type: string
 *     responses:
 *       201:
 *         description: File uploaded
 */
cdnApp.post('/upload', async (c) => {
	// Require authentication for file uploads
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	// Check if user has permission to upload files
	const isStaff = await roles.isStaff(user.id);
	if (!isStaff) {
		return c.text('Forbidden', 403);
	}

	try {
		const formData = await c.req.formData();
		const file = formData.get('file');
		const path = formData.get('path')?.toString() || '';
		const customKey = formData.get('key')?.toString();

		if (!file || !(file instanceof File)) {
			return c.json(
				{
					error: 'File is required',
				},
				400,
			);
		}

		// Create file path - use custom key if provided, otherwise generate one
		// Path format: [path]/[filename].[ext]
		const fileName = customKey || file.name;
		const fileKey = path ? `${path}/${fileName}` : fileName;

		// Extract file data
		const fileData = await file.arrayBuffer();

		// Upload file to storage
		const storage = ServicePool.getStorage(c.env);
		const result = await storage.uploadFile(fileKey, fileData, file.type, {
			uploadedBy: user.vatsim_id,
			fileName: file.name,
			size: file.size.toString(),
		});

		// Stats tracking removed

		// Return success with download URL
		return c.json(
			{
				success: true,
				file: {
					key: result.key,
					etag: result.etag,
					url: new URL(`/cdn/files/${result.key}`, c.req.url).toString(),
				},
			},
			201,
		);
	} catch (error) {
		console.error('File upload error:', error);
		return c.json(
			{
				error: error instanceof Error ? error.message : 'Failed to upload file',
			},
			500,
		);
	}
});

/**
 * @openapi
 * /cdn/files:
 *   get:
 *     x-hidden: true
 *     summary: List CDN files (staff only)
 *     tags:
 *       - CDN
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: query
 *         name: prefix
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Files listed
 */
cdnApp.get('/files', async (c) => {
	// Require authentication for listing files
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	// Only staff can list all files
	const isStaff = await roles.isStaff(user.id);
	if (!isStaff) {
		return c.text('Forbidden', 403);
	}

	try {
		const prefix = c.req.query('prefix') || undefined;
		const limit = Number.MAX_SAFE_INTEGER;

		// Get list of files
		const storage = ServicePool.getStorage(c.env);
		const result = await storage.listFiles(prefix, limit);

		// Format for easier use by clients
		const files = result.objects.map((obj) => ({
			key: obj.key,
			etag: obj.etag,
			size: obj.size,
			uploaded: obj.uploaded.toISOString(),
			url: new URL(`/cdn/files/${obj.key}`, c.req.url).toString(),
			metadata: obj.customMetadata || {},
		}));

		return c.json({ files });
	} catch (error) {
		console.error('File listing error:', error);
		return c.json(
			{
				error: error instanceof Error ? error.message : 'Failed to list files',
			},
			500,
		);
	}
});

/**
 * @openapi
 * /cdn/files/{fileKey}:
 *   delete:
 *     x-hidden: true
 *     summary: Delete a file (staff only)
 *     tags:
 *       - CDN
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: fileKey
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deletion result
 */
cdnApp.delete('/files/*', async (c) => {
	// Require authentication for file deletion
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	// Only staff can delete files
	const isStaff = await roles.isStaff(user.id);
	if (!isStaff) {
		return c.text('Forbidden', 403);
	}

	try {
		const fileKey = c.req.param('*');

		if (!fileKey) {
			return c.json(
				{
					error: 'File not found',
				},
				404,
			);
		}

		// Delete the file
		const storage = ServicePool.getStorage(c.env);
		const deleted = await storage.deleteFile(fileKey);

		if (!deleted) {
			return c.json(
				{
					error: 'File not found',
				},
				404,
			);
		}

		// Stats tracking removed

		return c.json({ success: true });
	} catch (error) {
		console.error('File deletion error:', error);
		return c.json(
			{
				error: error instanceof Error ? error.message : 'Failed to delete file',
			},
			500,
		);
	}
});

app.route('/cdn', cdnApp);

/**
 * @openapi
 * /euroscope/files/{icao}:
 *   get:
 *     summary: List public EuroScope files for an airport
 *     tags:
 *       - EuroScope
 *     parameters:
 *       - in: path
 *         name: icao
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Files listed
 *       400:
 *         description: Invalid ICAO
 */
app.get('/euroscope/files/:icao', async (c) => {
	const icao = c.req.param('icao').toUpperCase();

	// Validate ICAO format
	if (!icao.match(/^[A-Z0-9]{4}$/)) {
		return c.json(
			{
				error: 'Invalid ICAO format. Must be exactly 4 uppercase letters/numbers.',
			},
			400,
		);
	}

	try {
		// Get list of files for this ICAO
		const storage = ServicePool.getStorage(c.env);
		const result = await storage.listFiles(`EuroScope/${icao}/`, 10);

		// Format for easier use by clients
		const files = result.objects.map((obj) => ({
			fileName: obj.key.split('/').pop() || '',
			size: obj.size,
			uploaded: obj.uploaded.toISOString(),
			url: new URL(`https://dev-cdn.stopbars.com/${obj.key}`, c.req.url).toString(),
		}));

		return c.json({
			icao: icao,
			files: files,
			count: files.length,
		});
	} catch (error) {
		console.error('EuroScope public file listing error:', error);
		return c.json(
			{
				error: error instanceof Error ? error.message : 'Failed to list files',
			},
			500,
		);
	}
});

const euroscopeApp = new Hono<{
	Bindings: Env;
	Variables: {
		vatsimUser?: any;
		user?: any;
	};
}>();

euroscopeApp.use('*', async (c, next) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	c.set('vatsimUser', vatsimUser);
	c.set('user', user);
	await next();
});

/**
 * @openapi
 * /euroscope/upload:
 *   post:
 *     x-hidden: true
 *     summary: Upload EuroScope file for an airport
 *     tags:
 *       - EuroScope
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, icao]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               icao:
 *                 type: string
 *     responses:
 *       201:
 *         description: File uploaded
 */
euroscopeApp.post('/upload', async (c) => {
	const user = c.get('user');
	const vatsimUser = c.get('vatsimUser');

	try {
		const formData = await c.req.formData();
		const file = formData.get('file');
		const icao = formData.get('icao')?.toString()?.toUpperCase();

		if (!file || !(file instanceof File)) {
			return c.json(
				{
					error: 'File is required',
				},
				400,
			);
		}

		if (!icao) {
			return c.json(
				{
					error: 'ICAO code is required',
				},
				400,
			);
		}

		// Validate ICAO format (exactly 4 uppercase letters/numbers)
		if (!icao.match(/^[A-Z0-9]{4}$/)) {
			return c.json(
				{
					error: 'Invalid ICAO format. Must be exactly 4 uppercase letters/numbers.',
				},
				400,
			);
		}

		// Check file size limit (10MB)
		const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes
		if (file.size > MAX_FILE_SIZE) {
			return c.json(
				{
					error: 'File size exceeds 10MB limit',
				},
				400,
			);
		}

		// Check if user has access to upload files for this ICAO
		const divisions = ServicePool.getDivisions(c.env);
		const hasAccess = await divisions.userHasAirportAccess(vatsimUser.id.toString(), icao);

		if (!hasAccess) {
			return c.json(
				{
					error: 'You do not have permission to upload files for this airport. Please ensure your division has approved access to this ICAO.',
				},
				403,
			);
		}

		// Create file path: EuroScope/ICAO/filename
		const fileName = file.name;
		const fileKey = `EuroScope/${icao}/${fileName}`;

		// Check if this would exceed the 2 files per ICAO limit
		const storage = ServicePool.getStorage(c.env);
		const existingFiles = await storage.listFiles(`EuroScope/${icao}/`, 10);

		// Count files that are not the one being replaced
		const otherFiles = existingFiles.objects.filter((obj) => obj.key !== fileKey);
		if (otherFiles.length >= 2) {
			return c.json(
				{
					error: 'Maximum of 2 files per ICAO code allowed. Please delete an existing file before uploading a new one.',
				},
				400,
			);
		}

		// Extract file data
		const fileData = await file.arrayBuffer();

		// Upload file to storage with metadata
		const result = await storage.uploadFile(fileKey, fileData, file.type, {
			uploadedBy: vatsimUser.id.toString(),
			icao: icao,
			fileName: file.name,
			size: file.size.toString(),
		});

		// Return success with download URL
		return c.json(
			{
				success: true,
				file: {
					key: result.key,
					icao: icao,
					fileName: fileName,
					size: file.size,
					url: new URL(`https://dev-cdn.stopbars.com/${result.key}`, c.req.url).toString(),
				},
			},
			201,
		);
	} catch (error) {
		console.error('EuroScope file upload error:', error);
		return c.json(
			{
				error: error instanceof Error ? error.message : 'Failed to upload file',
			},
			500,
		);
	}
});

/**
 * @openapi
 * /euroscope/files/{icao}/{filename}:
 *   delete:
 *     x-hidden: true
 *     summary: Delete EuroScope file
 *     tags:
 *       - EuroScope
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: icao
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: filename
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deletion result
 */
euroscopeApp.delete('/files/:icao/:filename', async (c) => {
	const icao = c.req.param('icao').toUpperCase();
	const filename = c.req.param('filename');
	const user = c.get('user');
	const vatsimUser = c.get('vatsimUser');

	// Validate ICAO format
	if (!icao.match(/^[A-Z0-9]{4}$/)) {
		return c.json(
			{
				error: 'Invalid ICAO format. Must be exactly 4 uppercase letters/numbers.',
			},
			400,
		);
	}

	try {
		// Check if user has access to delete files for this ICAO
		const divisions = ServicePool.getDivisions(c.env);
		const hasAccess = await divisions.userHasAirportAccess(vatsimUser.id.toString(), icao);

		if (!hasAccess) {
			return c.json(
				{
					error: 'You do not have permission to delete files for this airport. Please ensure your division has approved access to this ICAO.',
				},
				403,
			);
		}

		// Construct the file key
		const fileKey = `EuroScope/${icao}/${filename}`;

		// Delete the file
		const storage = ServicePool.getStorage(c.env);
		const deleted = await storage.deleteFile(fileKey);

		if (!deleted) {
			return c.json(
				{
					error: 'File not found',
				},
				404,
			);
		}

		return c.json({
			success: true,
			message: `File ${filename} deleted successfully from ${icao}`,
		});
	} catch (error) {
		console.error('EuroScope file deletion error:', error);
		return c.json(
			{
				error: error instanceof Error ? error.message : 'Failed to delete file',
			},
			500,
		);
	}
});

/**
 * @openapi
 * /euroscope/{icao}/editable:
 *   get:
 *     x-hidden: true
 *     summary: Check if EuroScope files are editable by user
 *     tags:
 *       - EuroScope
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: icao
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Permission status returned
 */
euroscopeApp.get('/:icao/editable', async (c) => {
	const icao = c.req.param('icao').toUpperCase();
	const vatsimUser = c.get('vatsimUser');

	// Validate ICAO format
	if (!icao.match(/^[A-Z0-9]{4}$/)) {
		return c.json(
			{
				error: 'Invalid ICAO format. Must be exactly 4 uppercase letters/numbers.',
			},
			400,
		);
	}

	try {
		// Check if user has access to edit files for this ICAO
		const divisions = ServicePool.getDivisions(c.env);
		const hasAccess = await divisions.userHasAirportAccess(vatsimUser.id.toString(), icao);
		const userRole = await divisions.getUserRoleForAirport(vatsimUser.id.toString(), icao);

		return c.json({
			icao: icao,
			editable: hasAccess,
			role: userRole,
		});
	} catch (error) {
		console.error('EuroScope access check error:', error);
		return c.json(
			{
				error: error instanceof Error ? error.message : 'Failed to check airport access',
			},
			500,
		);
	}
});
app.route('/euroscope', euroscopeApp);

/**
 * @openapi
 * /releases:
 *   get:
 *     summary: List all product releases (optionally filtered)
 *     tags:
 *       - Installer
 *     parameters:
 *       - in: query
 *         name: product
 *         schema: { type: string, enum: [Pilot-Client, vatSys-Plugin, EuroScope-Plugin, Installer, SimConnect.NET] }
 *     responses:
 *       200:
 *         description: Releases listed
 */
app.get(
	'/releases',
	withCache(CacheKeys.fromUrl, 300, 'installer'), // cache 5m
	async (c) => {
		const product = c.req.query('product') as InstallerProduct | undefined;
		const releasesService = ServicePool.getReleases(c.env);
		const releases = await releasesService.listReleases(product);
		return c.json({ releases });
	}
);

/**
 * @openapi
 * /releases/latest:
 *   get:
 *     summary: Get latest release for a product
 *     tags:
 *       - Installer
 *     parameters:
 *       - in: query
 *         name: product
 *         required: true
 *         schema: { type: string, enum: [Pilot-Client, vatSys-Plugin, EuroScope-Plugin, Installer, SimConnect.NET] }
 *     responses:
 *       200:
 *         description: Latest release returned
 *       404:
 *         description: Not found
 */
app.get('/releases/latest', withCache(CacheKeys.fromUrl, 120, 'installer'), async (c) => {
	const product = c.req.query('product') as InstallerProduct | undefined;
	if (!product) return c.text('product required', 400);
	const releasesService = ServicePool.getReleases(c.env);
	const latest = await releasesService.getLatest(product);
	if (!latest) return c.text('Not found', 404);
	const downloadUrl = product === 'SimConnect.NET'
		? `https://www.nuget.org/packages/SimConnect.NET/${latest.version}`
		: new URL(`https://dev-cdn.stopbars.com/${latest.file_key}`, c.req.url).toString();
	const imageUrl = latest.image_url ? new URL(latest.image_url, c.req.url).toString() : undefined;
	const { image_url: _omitImage, ...rest } = latest as any;
	return c.json({ ...rest, downloadUrl, imageUrl });
});

/**
 * @openapi
 * /releases/upload:
 *   post:
 *     x-hidden: true
 *     summary: Create a new product release (lead developer only)
 *     tags:
 *       - Installer
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, product, version]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               product:
 *                 type: string
 *                 enum: [Pilot-Client, vatSys-Plugin, EuroScope-Plugin, Installer, SimConnect.NET]
 *               version:
 *                 type: string
 *               changelog:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *                 description: Optional promotional image (PNG/JPEG, max 5MB)
 *     x-notes:
 *       - Product "Installer" requires an .exe file upload.
 *       - Product "SimConnect.NET" does not require a file upload (metadata + changelog only; version links to NuGet).
 *     responses:
 *       201:
 *         description: Release created
 *       403:
 *         description: Forbidden
 */
app.post('/releases/upload', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) return c.text('Unauthorized', 401);
	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);
	const vatsimUserPromise = vatsim.getUser(vatsimToken);

	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		return c.json({ error: 'Invalid form-data' }, 400);
	}

	const file = formData.get('file');
	const product = formData.get('product')?.toString() as InstallerProduct | undefined;
	const version = formData.get('version')?.toString();
	const changelog = formData.get('changelog')?.toString();
	const image = formData.get('image');
	let vatsimUser;
	try {
		vatsimUser = await vatsimUserPromise;
	} catch (e) {
		return c.text('Failed to validate user', 401);
	}
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) return c.text('User not found', 404);
	const isLeadDev = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
	if (!isLeadDev) return c.text('Forbidden', 403);

	if (!product || !version) return c.json({ error: 'product & version required' }, 400);

	const isSimConnect = product === 'SimConnect.NET';
	const isInstallerExe = product === 'Installer';

	if (!isSimConnect) {
		// For all products except SimConnect.NET a file is required
		if (!file || !(file instanceof File)) return c.json({ error: 'file required' }, 400);
		const MAX = 90 * 1024 * 1024;
		if (file.size > MAX) return c.json({ error: 'File too large (90MB max)' }, 400);
		if (isInstallerExe) {
			// Enforce .exe extension for Installer product
			const lower = file.name.toLowerCase();
			if (!lower.endsWith('.exe')) return c.json({ error: 'Installer product must be a .exe file' }, 400);
		}
	}

	if (isSimConnect && file && file instanceof File) {
		return c.json({ error: 'SimConnect.NET releases do not accept file uploads' }, 400);
	}
	try {
		const storage = ServicePool.getStorage(c.env);
		let fileKey: string;
		let bytes: ArrayBuffer | undefined;
		if (!isSimConnect) {
			// File upload path for normal products
			const uploadFile = file as File; // already validated
			fileKey = `releases/${product}/${version}/${uploadFile.name}`;
			bytes = await uploadFile.arrayBuffer();
		} else {
			// Sentinel key for external NuGet package (no bytes)
			fileKey = `releases/${product}/${version}/EXTERNAL`;
		}
		let imageBytesPromise: Promise<ArrayBuffer> | undefined;
		if (image && image instanceof File) {
			imageBytesPromise = image.arrayBuffer();
		}

		let sha256 = 'external';
		if (bytes) {
			const digest = await crypto.subtle.digest('SHA-256', bytes);
			sha256 = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
		}

		// Validate image (after its bytes read started) before uploads
		let imageUrl: string | undefined;
		let imageUploadPromise: Promise<any> | undefined;
		let imageKey: string | undefined;
		if (image && image instanceof File) {
			const ALLOWED = ['image/png', 'image/jpeg'];
			const MAX_IMAGE = 5 * 1024 * 1024; // 5MB
			if (!ALLOWED.includes(image.type)) return c.json({ error: 'Invalid image type (png or jpeg only)' }, 400);
			if (image.size > MAX_IMAGE) return c.json({ error: 'Image too large (5MB max)' }, 400);
			const imageExt = image.type === 'image/png' ? 'png' : 'jpg';
			imageKey = `releases/${product}/${version}/promo.${imageExt}`;
			// Wait for image bytes only when needed (likely already resolved by now)
			const imgBytes = await imageBytesPromise!;
			imageUploadPromise = storage.uploadFile(imageKey, imgBytes, image.type || 'image/png', {
				uploadedBy: user.vatsim_id,
				product,
				version,
			});
			imageUrl = `https://dev-cdn.stopbars.com/${imageKey}`;
		}
		if (!isSimConnect) {
			const uploadFile = file as File;
			const fileUploadPromise = storage.uploadFile(fileKey, bytes!, uploadFile.type || 'application/octet-stream', {
				uploadedBy: user.vatsim_id,
				product,
				version,
				size: uploadFile.size.toString(),
				sha256
			});
			await Promise.all([fileUploadPromise, imageUploadPromise].filter(Boolean));
		} else {
			// Only image upload (if any) for external product
			if (imageUploadPromise) await imageUploadPromise;
		}
		const releasesService = ServicePool.getReleases(c.env);
		const release = await releasesService.createRelease({
			product,
			version,
			fileKey,
			fileSize: bytes ? (file as File).size : 0,
			fileHash: sha256,
			changelog,
			imageUrl
		});
		const downloadUrl = isSimConnect ? `https://www.nuget.org/packages/SimConnect.NET/${version}` : `https://dev-cdn.stopbars.com/${fileKey}`;
		return c.json({ success: true, release, downloadUrl, imageUrl }, 201);
	} catch (err) {
		console.error('Release upload error', err);
		return c.json({ error: err instanceof Error ? err.message : 'upload failed' }, 500);
	}
});

/**
 * @openapi
 * /releases/{id}/changelog:
 *   put:
 *     x-hidden: true
 *     summary: Update changelog content for a release
 *     description: Update only the changelog text of an existing release record.
 *     tags:
 *       - Installer
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [changelog]
 *             properties:
 *               changelog:
 *                 type: string
 *                 maxLength: 20000
 *     responses:
 *       200:
 *         description: Changelog updated
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Release not found
 */
app.put('/releases/:id/changelog', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) return c.text('Unauthorized', 401);
	const idRaw = c.req.param('id');
	const id = parseInt(idRaw, 10);
	if (Number.isNaN(id) || id <= 0) return c.text('Invalid id', 400);

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);
	const releasesService = ServicePool.getReleases(c.env);

	try {
		const vatsimUser = await vatsim.getUser(vatsimToken);
		const user = await auth.getUserByVatsimId(vatsimUser.id);
		if (!user) return c.text('User not found', 404);
		// Allow Lead Developer or Product Manager
		const canEdit = (await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER)) || (await roles.hasPermission(user.id, StaffRole.PRODUCT_MANAGER));
		if (!canEdit) return c.text('Forbidden', 403);

		let body: any;
		try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
		const changelog = typeof body?.changelog === 'string' ? body.changelog.trim() : '';
		if (!changelog) return c.json({ error: 'changelog required' }, 400);
		if (changelog.length > 20000) return c.json({ error: 'changelog too long (max 20000 chars)' }, 400);

		// Ensure release exists first (so we differentiate 404 vs silent update)
		// Reusing listReleases would be inefficient; perform direct lookup.
		const dbContext = DatabaseContextFactory.createRequestContext(c.env.DB, c.req.raw);
		try {
			const existing = await dbContext.db.executeRead<any>('SELECT * FROM installer_releases WHERE id = ?', [id]);
			if (!existing.results[0]) return dbContext.textResponse('Release not found', { status: 404 });
		} finally {
			// close early; release update uses its own session service
			// (ReleaseService internally manages its session.)
		}

		const updated = await releasesService.updateChangelog(id, changelog);
		if (!updated) return c.text('Release not found', 404);
		return c.json({ success: true, release: updated });
	} catch (err) {
		console.error('Changelog update error', err);
		return c.json({ error: err instanceof Error ? err.message : 'update failed' }, 500);
	}
});

/**
 * @openapi
 * /download:
 *   post:
 *     summary: Record a product download
 *     tags:
 *       - Installer
 *     description: >-
 *       Increments the download counter for the latest release of the given product. A given IP is only counted
 *       once per product+version within a rolling 24 hour window. After 24h the same IP can increment again.
 *     parameters:
 *       - in: query
 *         name: product
 *         required: true
 *         schema:
 *           type: string
 *           enum: [Pilot-Client, vatSys-Plugin, EuroScope-Plugin, Installer, SimConnect.NET]
 *     responses:
 *       200:
 *         description: Download recorded (or already counted for this IP)
 *       400:
 *         description: Missing product or invalid product
 *       404:
 *         description: Latest release not found when version omitted
 */
app.post('/download', async (c) => {
	const product = c.req.query('product') as InstallerProduct | undefined;
	if (!product) return c.json({ error: 'product required' }, 400);
	const VALID: InstallerProduct[] = ['Pilot-Client', 'vatSys-Plugin', 'EuroScope-Plugin', 'Installer', 'SimConnect.NET'];
	if (!VALID.includes(product)) return c.json({ error: 'invalid product' }, 400);
	const releases = ServicePool.getReleases(c.env);
	const latest = await releases.getLatest(product);
	if (!latest) return c.json({ error: 'No release found for product' }, 404);
	const version = latest.version;
	const ip = c.get('clientIp') || '0.0.0.0';
	const downloads = ServicePool.getDownloads(c.env);
	const { versionCount, productTotal } = await downloads.recordDownload(product, version, ip);
	const stats = await downloads.getStats(product);
	return c.json({ product, version, versionCount, productTotal, versions: stats.versions });
});

/**
 * @openapi
 * /staff/bars-packages/upload:
 *   post:
 *     x-hidden: true
 *     summary: Upload BARS installer packages (models/removals)
 *     description: >-
 *       Staff-only endpoint to upload the two MSFS data packages used by the installer. Accepts a multipart form
 *       with a single file and a `type` field designating which package is being uploaded. The file is stored in R2
 *       under a fixed key and previous version overwritten. SHA-256 is computed server-side and stored in metadata.
 *     tags:
 *       - Staff
 *       - Data
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, type]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               type:
 *                 type: string
 *                 enum: [models, models-2020, removals]
 *     responses:
 *       201:
 *         description: Package uploaded successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
app.post('/staff/bars-packages/upload', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) return c.text('Unauthorized', 401);
	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);
	let vatsimUser;
	try { vatsimUser = await vatsim.getUser(vatsimToken); } catch { return c.text('Unauthorized', 401); }
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) return c.text('User not found', 404);
	const allowed = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
	if (!allowed) return c.text('Forbidden', 403);

	let form: FormData;
	try { form = await c.req.formData(); } catch { return c.json({ error: 'Invalid form-data' }, 400); }
	const file = form.get('file');
	const type = form.get('type')?.toString();
	if (!file || !(file instanceof File)) return c.json({ error: 'file required' }, 400);
	if (!type || !['models', 'models-2020', 'removals'].includes(type)) return c.json({ error: 'invalid type' }, 400);
	// Enforce .zip
	const lowerName = file.name.toLowerCase();
	if (!lowerName.endsWith('.zip')) return c.json({ error: 'file must be a .zip archive' }, 400);
	const MAX = 100 * 1024 * 1024; // 100MB
	if (file.size > MAX) return c.json({ error: 'File too large (100MB max)' }, 400);

	try {
		const bytes = await file.arrayBuffer();
		// SHA-256 hash
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		const sha256 = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
		const storage = ServicePool.getStorage(c.env);
		let key: string;
		if (type === 'models') key = 'packages/bars-models-2024.zip';
		else if (type === 'models-2020') key = 'packages/bars-models-2020.zip';
		else key = 'packages/bars-removals.zip';
		const uploadRes = await storage.uploadFile(key, bytes, 'application/zip', {
			uploadedBy: user.vatsim_id,
			type,
			size: file.size.toString(),
			sha256
		});
		const url = new URL(`https://dev-cdn.stopbars.com/${uploadRes.key}`, c.req.url).toString();
		return c.json({
			success: true,
			package: {
				type,
				key: uploadRes.key,
				size: file.size,
				sha256,
				etag: uploadRes.etag,
				url
			}
		}, 201);
	} catch (err) {
		console.error('BARS package upload error', err);
		return c.json({ error: err instanceof Error ? err.message : 'upload failed' }, 500);
	}
});

/**
 * @openapi
 * /bars-packages:
 *   get:
 *     summary: List current BARS data packages
 *     description: Public metadata for installer MSFS data packages (models & removals). Returns size, hash and timestamps.
 *     tags:
 *       - Data
 *     responses:
 *       200:
 *         description: Package metadata returned
 */
app.get('/bars-packages', withCache(CacheKeys.fromUrl, 300, 'data'), async (c) => {
	try {
		const storage = ServicePool.getStorage(c.env);
		const KEYS = [
			'packages/bars-models-2024.zip',
			'packages/bars-models-2020.zip',
			'packages/bars-removals.zip'
		];
		const bucket = (storage as any).bucket as R2Bucket;
		const results = await Promise.all(KEYS.map(async key => {
			try {
				const obj = await bucket.head(key);
				if (!obj) return null;
				let type: string;
				if (key.endsWith('bars-models-2024.zip')) type = 'models';
				else if (key.endsWith('bars-models-2020.zip')) type = 'models-2020';
				else type = 'removals';
				return {
					key,
					size: obj.size,
					etag: obj.etag,
					uploaded: obj.uploaded.toISOString(),
					sha256: obj.customMetadata?.sha256 || null,
					type,
					url: new URL(`https://dev-cdn.stopbars.com/${key}`, c.req.url).toString(),
				};
			} catch { return null; }
		}));
		return c.json({ packages: results.filter(Boolean) });
	} catch (err) {
		console.error('BARS package list error', err);
		return c.json({ error: 'Failed to list packages' }, 500);
	}
});

/**
 * @openapi
 * /downloads/stats:
 *   get:
 *     summary: Get download statistics for a product
 *     tags:
 *       - Installer
 *     parameters:
 *       - in: query
 *         name: product
 *         required: true
 *         schema:
 *           type: string
 *           enum: [Pilot-Client, vatSys-Plugin, EuroScope-Plugin, Installer, SimConnect.NET]
 *     responses:
 *       200:
 *         description: Stats returned
 *       400:
 *         description: Missing/invalid product
 */
app.get('/downloads/stats', withCache(CacheKeys.fromUrl, 300, 'installer'), async (c) => {
	const product = c.req.query('product') as InstallerProduct | undefined;
	if (!product) return c.json({ error: 'product required' }, 400);
	const VALID: InstallerProduct[] = ['Pilot-Client', 'vatSys-Plugin', 'EuroScope-Plugin', 'Installer', 'SimConnect.NET'];
	if (!VALID.includes(product)) return c.json({ error: 'invalid product' }, 400);
	const downloads = ServicePool.getDownloads(c.env);
	const stats = await downloads.getStats(product);
	return c.json(stats);
});

/**
 * @openapi
 * /purge-cache:
 *   post:
 *     x-hidden: true
 *     summary: Purge a cache key (lead developer only)
 *     tags:
 *       - Staff
 *       - Cache
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key]
 *             properties:
 *               key: { type: string }
 *               namespace: { type: string }
 *     responses:
 *       200:
 *         description: Cache purged
 *       403:
 *         description: Forbidden
 */
app.post('/purge-cache', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	// Only lead developers can purge cache
	const isLeadDev = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
	if (!isLeadDev) {
		return c.text('Forbidden', 403);
	}

	try {
		const { key, namespace } = (await c.req.json()) as { key: string; namespace?: string };

		if (!key) {
			return c.json({ error: 'Cache key is required' }, 400);
		}

		const cacheService = ServicePool.getCache(c.env);
		await cacheService.delete(key, namespace || 'default');

		console.log(`Cache purged by user ${user.vatsim_id}: ${key} (namespace: ${namespace || 'default'})`);

		return c.json({
			success: true,
			message: `Cache key "${key}" purged successfully`,
		});
	} catch (error) {
		console.error('Cache purge error:', error);
		return c.json(
			{
				error: error instanceof Error ? error.message : 'Failed to purge cache',
			},
			500,
		);
	}
});

/**
 * @openapi
 * /contributors:
 *   get:
 *     summary: List GitHub contributors
 *     tags:
 *       - GitHub
 *     responses:
 *       200:
 *         description: Contributors returned
 */
app.get(
	'/contributors',
	withCache(() => 'github-contributors', 3600, 'github'), // Cache for 1 hour
	async (c) => {
		try {
			const github = ServicePool.getGitHub(c.env);
			const contributorsData = await github.getAllContributors();
			return c.json(contributorsData);
		} catch (error) {
			console.error('Contributors endpoint error:', error);
			return c.json(
				{
					error: 'Failed to fetch contributors data',
					message: error instanceof Error ? error.message : 'Unknown error',
				},
				500,
			);
		}
	},
);

// FAQs public endpoint
/**
 * @openapi
 * /faqs:
 *   get:
 *     summary: List public FAQs
 *     tags:
 *       - FAQ
 *     responses:
 *       200:
 *         description: FAQs returned
 */
app.get(
	'/faqs',
	withCache(() => 'faqs-public', 900, 'faq'),
	async (c) => {
		const faqService = ServicePool.getFAQs(c.env);
		const data = await faqService.list();
		return c.json(data);
	},
);

// Staff FAQ management endpoints
const faqStaffApp = new Hono<{ Bindings: Env; Variables: { user?: any } }>();

faqStaffApp.use('*', async (c, next) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) return c.text('Unauthorized', 401);
	const vatsim = ServicePool.getVatsim(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);
	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) return c.text('User not found', 404);
	// Require product manager or higher
	const allowed = await roles.hasPermission(user.id, StaffRole.PRODUCT_MANAGER);
	if (!allowed) return c.text('Forbidden', 403);
	c.set('user', user);
	await next();
});

/**
 * @openapi
 * /staff/faqs:
 *   post:
 *     x-hidden: true
 *     summary: Create FAQ
 *     tags:
 *       - Staff
 *       - FAQ
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [question, answer, order_position]
 *             properties:
 *               question: { type: string }
 *               answer: { type: string }
 *               order_position: { type: integer }
 *     responses:
 *       201:
 *         description: Created
 */
faqStaffApp.post('/', async (c) => {
	let body: any;
	try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
	const { question, answer } = body;
	let order_position = Number(body.order_position);
	if (!question || !answer || !Number.isInteger(order_position)) {
		return c.json({ error: 'question, answer, order_position required' }, 400);
	}
	if (order_position < 0) order_position = 0;
	const faqService = ServicePool.getFAQs(c.env);
	const created = await faqService.create({ question, answer, order_position });
	// Purge public cache
	try { await ServicePool.getCache(c.env).delete('faqs-public', 'faq'); } catch { }
	return c.json(created, 201);
});

/**
 * @openapi
 * /staff/faqs/{id}:
 *   put:
 *     x-hidden: true
 *     summary: Update FAQ
 *     tags:
 *       - Staff
 *       - FAQ
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               question: { type: string }
 *               answer: { type: string }
 *               order_position: { type: integer }
 *     responses:
 *       200:
 *         description: Updated
 *       404:
 *         description: Not found
 */
faqStaffApp.put('/:id', async (c) => {
	const id = c.req.param('id');
	let body: any; try { body = await c.req.json(); } catch { body = {}; }
	const faqService = ServicePool.getFAQs(c.env);
	const updated = await faqService.update(id, {
		question: body.question,
		answer: body.answer,
		order_position: Number.isInteger(body.order_position) ? body.order_position : undefined,
	});
	if (!updated) return c.text('Not found', 404);
	try { await ServicePool.getCache(c.env).delete('faqs-public', 'faq'); } catch { }
	return c.json(updated);
});

/**
 * @openapi
 * /staff/faqs/{id}:
 *   delete:
 *     x-hidden: true
 *     summary: Delete FAQ
 *     tags:
 *       - Staff
 *       - FAQ
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deletion result
 */
faqStaffApp.delete('/:id', async (c) => {
	const id = c.req.param('id');
	const faqService = ServicePool.getFAQs(c.env);
	const success = await faqService.delete(id);
	if (success) { try { await ServicePool.getCache(c.env).delete('faqs-public', 'faq'); } catch { } }
	return c.json({ success });
});

/**
 * @openapi
 * /staff/faqs/reorder:
 *   post:
 *     x-hidden: true
 *     summary: Bulk reorder FAQs
 *     tags:
 *       - Staff
 *       - FAQ
 *     security:
 *       - VatsimToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [updates]
 *             properties:
 *               updates:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [id, order_position]
 *                   properties:
 *                     id: { type: string }
 *                     order_position: { type: integer }
 *     responses:
 *       200:
 *         description: Reordered
 */
faqStaffApp.post('/reorder', async (c) => {
	let body: any; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
	if (!Array.isArray(body.updates)) return c.json({ error: 'updates array required' }, 400);
	const updates = body.updates.filter((u: any) => typeof u.id === 'string' && Number.isInteger(u.order_position));
	const faqService = ServicePool.getFAQs(c.env);
	await faqService.reorder(updates);
	try { await ServicePool.getCache(c.env).delete('faqs-public', 'faq'); } catch { }
	return c.json({ success: true });
});

app.route('/staff/faqs', faqStaffApp);

// Health endpoint
/**
 * @openapi
 * /health:
 *   get:
 *     summary: System/service health check
 *     tags:
 *       - System
 *     parameters:
 *       - in: query
 *         name: service
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: All services healthy
 *       503:
 *         description: One or more services degraded
 */
app.get('/health', withCache(CacheKeys.fromUrl, 60, 'health'), async (c) => {
	const requestedService = c.req.query('service');
	const validServices = ['database', 'storage', 'vatsim', 'auth'];

	if (requestedService && !validServices.includes(requestedService)) {
		return c.json(
			{
				error: 'Invalid service',
				validServices: validServices,
			},
			400,
		);
	}

	const healthChecks: Record<string, string> = {};
	const servicesToCheck = requestedService ? [requestedService] : validServices;

	for (const service of servicesToCheck) {
		healthChecks[service] = 'ok';
	}

	try {
		if (servicesToCheck.includes('database')) {
			try {
				await c.env.DB.prepare('SELECT 1').first();
			} catch (error) {
				healthChecks.database = 'outage';
			}
		}

		if (servicesToCheck.includes('storage')) {
			try {
				const storage = ServicePool.getStorage(c.env);
				await storage.listFiles(undefined, 1);
			} catch (error) {
				healthChecks.storage = 'outage';
			}
		}

		if (servicesToCheck.includes('vatsim')) {
			try {
				const response = await fetch('https://auth.vatsim.net/api/user', {
					method: 'GET',
					headers: {
						Accept: 'application/json',
						'User-Agent': 'BARS-Health-Check/1.0',
					},
					signal: AbortSignal.timeout(5000),
				});

				if (!response.ok && response.status !== 401) {
					throw new Error(`VATSIM API returned ${response.status}`);
				}
			} catch (error) {
				console.error('VATSIM health check failed:', error);
				healthChecks.vatsim = 'outage';
			}
		}

		if (servicesToCheck.includes('auth')) {
			try {
				const auth = ServicePool.getAuth(c.env);
				await auth.getUserByVatsimId('1658308');
			} catch (error) {
				healthChecks.auth = 'outage';
			}
		}

		// Stats service removed
	} catch (error) {
		console.error('Health check error:', error);
	}

	const hasOutages = Object.values(healthChecks).some((status) => status === 'outage');
	const statusCode = hasOutages ? 503 : 200;

	return c.json(healthChecks, statusCode);
});

// Serve OpenAPI spec
/**
 * @openapi
 * /openapi.json:
 *   get:
 *     summary: Get OpenAPI specification
 *     tags:
 *       - System
 *     description: Returns the current OpenAPI 3.0 document for the BARS Core API.
 *     responses:
 *       200:
 *         description: OpenAPI document
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 */
app.get('/openapi.json', (c) => {
	return c.json(openapiSpec, 200, {
		'Cache-Control': 'public, max-age=300',
	});
});

// Catch all other routes
app.notFound((c) => {
	return c.text('Not Found', 404);
});

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return app.fetch(request, env);
	},
};
