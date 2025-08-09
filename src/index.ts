import { Hono } from 'hono';
import openapiSpec from '../openapi.json';
import { cors } from 'hono/cors';
import { PointChangeset, PointData } from './types';
import { VatsimService } from './services/vatsim';
import { AuthService } from './services/auth';
import { StatsService } from './services/stats';
import { StaffRole } from './services/roles';
import { Connection } from './network/connection';
import { UserService } from './services/users';
import { DatabaseContextFactory } from './services/database-context';
import { withCache, CacheKeys } from './services/cache';
import { ServicePool } from './services/service-pool';

// Shared point regex
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
	userDisplayName?: string;
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
		const stats = new StatsService(env.DB);
		const auth = new AuthService(env.DB, vatsim, stats);
		this.connection = new Connection(env, auth, vatsim, state, stats);
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
	};
}>();

// Add CORS middleware
app.use('*', cors({
	origin: '*',
	allowHeaders: ['Content-Type', 'Authorization', 'X-Vatsim-Token', 'Upgrade', 'X-Client-Type'],
	allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

// Connect endpoint
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
		return c.json({
			message: 'This endpoint is for WebSocket connections only. Use a WebSocket client to test.',
		}, 400);
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
		return c.json({
			error: 'Airport parameter required',
		}, 400);
	}

	// Create database context for this request with bookmark handling
	const dbContext = DatabaseContextFactory.createRequestContext(c.env.DB, c.req.raw);

	try {
		if (airport === 'all') {
			// Use session-aware database operations
			await dbContext.db.executeWrite("DELETE FROM active_objects WHERE last_updated <= datetime('now', '-2 day')");

			const activeObjectsResult = await dbContext.db.executeRead<any>(
				"SELECT id, name FROM active_objects WHERE last_updated > datetime('now', '-2 day')"
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
				return dbContext.jsonResponse({
					error: 'Invalid airport ICAO',
				}, { status: 400 });
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
		const user = await auth.getUserByVatsimId(vatsimUser.id);
		if (!user) {
			return dbContext.textResponse('User not found', { status: 404 });
		}

		return dbContext.jsonResponse({
			...user,
			email: vatsimUser.email,
		});
	} finally {
		dbContext.close();
	}
});

// Regenerate API key
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
			[user.id]
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

				return dbContext.jsonResponse({
					error: 'Rate limited',
					message: `You can only regenerate your API key once every 24 hours. Please try again in ${remainingHours} hour${remainingHours !== 1 ? 's' : ''}${remainingMinutes > 0 ? ` and ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}` : ''}.`,
					retryAfter: Math.ceil(remainingMs / 1000),
				}, { status: 429 });
			}
		}

		// Generate new API key
		const newApiKey = await auth.regenerateApiKey(user.id);

		// Update the last regeneration timestamp using session-aware write
		await dbContext.db.executeWrite(
			"UPDATE users SET last_api_key_regen = datetime('now') WHERE id = ?",
			[user.id]
		);

		return dbContext.jsonResponse({
			success: true,
			apiKey: newApiKey,
		});
	} catch (error) {
		return dbContext.jsonResponse({
			error: 'Failed to regenerate API key',
			message: error instanceof Error ? error.message : 'Unknown error',
		}, { status: 500 });
	} finally {
		dbContext.close();
	}
});

// Delete account
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

// Check if staff
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
app.get('/auth/is-staff',
	withCache(CacheKeys.withUser('is-staff'), 3600, 'auth'),
	async (c) => {
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

// Airports endpoint
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
app.get('/airports',
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
	}
);

// Divisions routes
const divisionsApp = new Hono<{
	Bindings: Env;
	Variables: {
		vatsimUser?: any;
		user?: any;
		auth?: any;
		vatsim?: any;
	};
}>();

// Middleware to get authenticated user for divisions
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

// GET /divisions - List all divisions
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

// POST /divisions - Create new division (requires lead_developer role)
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

	const { name, headVatsimId } = await c.req.json() as CreateDivisionPayload;
	const division = await divisions.createDivision(name, headVatsimId);
	return c.json(division);
});

// GET /divisions/user - Get user's divisions
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
divisionsApp.get('/user',
	withCache(CacheKeys.withUser('divisions'), 3600, 'divisions'),
	async (c) => {
		const vatsimUser = c.get('vatsimUser');
		const divisions = ServicePool.getDivisions(c.env);

		const userDivisions = await divisions.getUserDivisions(vatsimUser.id);
		return c.json(userDivisions);
	});

// GET /divisions/:id - Get division details
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
divisionsApp.get('/:id',
	withCache(CacheKeys.fromParams('id'), 2592000, 'divisions'),
	async (c) => {
		const divisionId = parseInt(c.req.param('id'));
		const divisions = ServicePool.getDivisions(c.env);

		const division = await divisions.getDivision(divisionId);
		if (!division) {
			return c.text('Division not found', 404);
		}

		return c.json(division);
	});

// GET /divisions/:id/members - List division members
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

// POST /divisions/:id/members - Add member (requires nav_head role)
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

	const { vatsimId, role } = await c.req.json() as AddMemberPayload;
	const member = await divisions.addMember(divisionId, vatsimId, role);
	return c.json(member);
});

// DELETE /divisions/:id/members/:vatsimId - Remove member (requires nav_head role)
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

// GET /divisions/:id/airports - List division airports
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
divisionsApp.get('/:id/airports',
	withCache(CacheKeys.fromParams('id'), 600, 'divisions'),
	async (c) => {
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

// POST /divisions/:id/airports - Request airport addition (requires division membership)
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

	const { icao } = await c.req.json() as RequestAirportPayload;
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

	const { approved } = await c.req.json() as ApproveAirportPayload;
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
app.get('/airports/:icao/points',
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
	});

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

	const pointData = await c.req.json() as PointData;
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

	const changeset = await c.req.json() as PointChangeset;
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

	const updates = await c.req.json() as Partial<PointData>;
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

// Get single point by ID
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
app.get('/points/:id',
	withCache(CacheKeys.fromUrl, 3600, 'points'),
	async (c) => {
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
app.get('/points',
	withCache(CacheKeys.fromUrl, 3600, 'points'),
	async (c) => {
		const ids = c.req.query('ids');

		if (!ids) {
			return c.json({
				error: 'Missing ids query parameter',
				message: 'Provide comma-separated point IDs: /points?ids=id1,id2,id3'
			}, 400);
		}

		// Parse and validate point IDs
		const pointIds = ids.split(',')
			.map(id => id.trim())
			.filter(id => id.length > 0);

		if (pointIds.length === 0) {
			return c.json({
				error: 'No valid point IDs provided'
			}, 400);
		}

		if (pointIds.length > 100) {
			return c.json({
				error: 'Too many point IDs requested',
				message: 'Maximum 100 points can be requested at once'
			}, 400);
		}


		const invalidIds = pointIds.filter(id => !id.match(POINT_ID_REGEX));
		if (invalidIds.length > 0) {
			return c.json({
				error: 'Invalid point ID format',
				invalidIds
			}, 400);
		}

		const points = ServicePool.getPoints(c.env);

		// Fetch all points in parallel
		const pointPromises = pointIds.map(id => points.getPoint(id));
		const pointResults = await Promise.all(pointPromises);

		// Filter out null results and create response
		const foundPoints = pointResults.filter(point => point !== null);
		const foundIds = foundPoints.map(point => point!.id);
		const notFoundIds = pointIds.filter(id => !foundIds.includes(id));

		return c.json({
			points: foundPoints,
			requested: pointIds.length,
			found: foundPoints.length,
			notFound: notFoundIds.length > 0 ? notFoundIds : undefined
		});
	});

// Light Support endpoints
/**
 * @openapi
 * /supports/generate:
 *   post:
 *     summary: Generate Light Supports and BARS XML
 *     tags:
 *       - Support
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
			return c.json({
				error: 'XML file is required',
			}, 400);
		}

		if (!icao) {
			return c.json({
				error: 'ICAO code is required',
			}, 400);
		}

		const xmlContent = await xmlFile.text();
		const supportService = ServicePool.getSupport(c.env);
		const polygonService = ServicePool.getPolygons(c.env);

		// Generate both XML files in parallel
		const [supportsXml, barsXml] = await Promise.all([
			supportService.generateLightSupportsXML(xmlContent, icao),
			polygonService.processBarsXML(xmlContent, icao),
		]);

		// Return both XMLs as a JSON response
		return c.json({
			supportsXml,
			barsXml,
		});
	} catch (error) {
		console.error('Error generating XMLs:', error);
		return c.json({
			error: error instanceof Error ? error.message : 'Unknown error generating XMLs',
		}, 500);
	}
});

// NOTAM endpoints
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
app.get('/notam',
	withCache(() => 'global-notam', 900, 'notam'),
	async (c) => {
		const notamService = ServicePool.getNotam(c.env);
		const notamData = await notamService.getGlobalNotam();
		return c.json({
			notam: notamData?.content || null,
			type: notamData?.type || 'warning',
		});
	}
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
	const { content, type } = await c.req.json() as { content: string; type?: string };
	const notamService = ServicePool.getNotam(c.env);
	const updated = await notamService.updateGlobalNotam(content, type, user.vatsim_id);

	if (!updated) {
		return c.json({ error: 'Failed to update NOTAM' }, 500);
	}

	return c.json({ success: true });
});

// Public stats
/**
 * @openapi
 * /public-stats:
 *   get:
 *     summary: Get public usage statistics
 *     tags:
 *       - Stats
 *     responses:
 *       200:
 *         description: Public stats returned
 */
app.get('/public-stats',
	withCache(() => 'public-stats', 60, 'stats'),
	async (c) => {
		const stats = ServicePool.getStats(c.env);
		const publicStats = await stats.getPublicStats();
		return c.json(publicStats);
	}
);

// User management endpoints
const staffUsersApp = new Hono<{
	Bindings: Env;
	Variables: {
		user?: any;
		userService?: any;
	};
}>();

// Middleware to authenticate staff users
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

// GET /staff/users - Get all users with pagination
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

// GET /staff/users/search - Search for users
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
			return c.json({
				error: 'Search query must be at least 3 characters',
			}, 400);
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

// POST /staff/users/refresh-api-token - Refresh a user's API token by VATSIM ID
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
		const { vatsimId } = await c.req.json() as { vatsimId: string };

		if (!vatsimId) {
			return c.json({
				error: 'VATSIM ID is required',
			}, 400);
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
contributionsApp.get('/',
	withCache(CacheKeys.fromUrl, 7200, 'contributions'),
	async (c) => {
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

// GET /contributions/stats - Get contribution statistics
/**
 * @openapi
 * /contributions/stats:
 *   get:
 *     summary: Get contribution statistics
 *     tags:
 *       - Contributions
 *     responses:
 *       200:
 *         description: Stats returned
 */
contributionsApp.get('/stats',
	withCache(() => 'contribution-stats', 1800, 'contributions'),
	async (c) => {
		const contributions = ServicePool.getContributions(c.env);
		const stats = await contributions.getContributionStats();
		return c.json(stats);
	});

// GET /contributions/leaderboard - Get top contributors
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
contributionsApp.get('/leaderboard',
	withCache(() => 'contribution-leaderboard', 1800, 'contributions'),
	async (c) => {
		const contributions = ServicePool.getContributions(c.env);
		const leaderboard = await contributions.getContributionLeaderboard();
		return c.json(leaderboard);
	});

// GET /contributions/top-packages - Get a list of most used packages
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
contributionsApp.get('/top-packages',
	withCache(() => 'contribution-top-packages', 1800, 'contributions'),
	async (c) => {
		const contributions = ServicePool.getContributions(c.env);
		const topPackages = await contributions.getTopPackages();
		return c.json(topPackages);
	});

// POST /contributions - Create a new contribution
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
 *               userDisplayName: { type: string }
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
	const stats = ServicePool.getStats(c.env);
	const auth = ServicePool.getAuth(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	try {
		const contributions = ServicePool.getContributions(c.env);
		const payload = await c.req.json() as ContributionSubmissionPayload;
		const result = await contributions.createContribution({
			userId: user.vatsim_id,
			userDisplayName: payload.userDisplayName,
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

// GET /contributions/user - Get user's contributions
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

// GET /contributions/:id - Get specific contribution
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
	const stats = ServicePool.getStats(c.env);
	const auth = ServicePool.getAuth(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	try {
		const contributionId = c.req.param('id');
		const contributions = ServicePool.getContributions(c.env);
		const payload = await c.req.json() as ContributionDecisionPayload;
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

// GET /contributions/user/display-name - Get user's display name
/**
 * @openapi
 * /contributions/user/display-name:
 *   get:
 *     summary: Get display name for authenticated user
 *     tags:
 *       - Contributions
 *     security:
 *       - VatsimToken: []
 *     responses:
 *       200:
 *         description: Display name returned
 */
contributionsApp.get('/user/display-name', async (c) => {
	const token = c.req.header('X-Vatsim-Token');
	if (!token) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const vatsimUser = await vatsim.getUser(token);
	const contributions = ServicePool.getContributions(c.env);
	const displayName = await contributions.getUserDisplayName(vatsimUser.id);

	if (!displayName) {
		return c.text('User not found', 404);
	}

	return c.json({ displayName });
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

// Staff stats
/**
 * @openapi
 * /staff-stats:
 *   get:
 *     x-hidden: true
 *     summary: Get internal staff statistics (restricted)
 *     tags:
 *       - Staff
 *       - Stats
 *     security:
 *       - VatsimToken: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer }
 *       - in: query
 *         name: stat
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Stats returned
 *       403:
 *         description: Forbidden
 */
app.get('/staff-stats', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = ServicePool.getVatsim(c.env);
	const stats = ServicePool.getStats(c.env);
	const auth = ServicePool.getAuth(c.env);
	const roles = ServicePool.getRoles(c.env);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	const isStaff = await roles.hasPermission(user.id, StaffRole.PRODUCT_MANAGER);
	if (!isStaff) {
		return c.text('Forbidden', 403);
	}

	// Check for daily stats query parameters
	const days = c.req.query('days');
	const statKey = c.req.query('stat');

	// If both days and stat parameters are provided, return daily stats
	if (days && statKey) {
		const daysNum = parseInt(days);
		if (isNaN(daysNum) || daysNum <= 0) {
			return c.json({ error: 'Invalid days parameter' }, 400);
		}

		const dailyStats = await stats.getDailyStats(statKey, daysNum);

		// Calculate the total count across all days
		const totalCount = dailyStats.reduce((sum, day) => sum + day.value, 0);

		return c.json({
			dailyStats,
			totalCount,
		});
	}

	// Get count of active accounts
	const activeAccountsResult = await c.env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
	const activeAccounts = activeAccountsResult?.count || 0;

	const [publicStats, sensitiveStats] = await Promise.all([stats.getPublicStats(), stats.getSensitiveStats()]);

	return c.json({
		...publicStats,
		...sensitiveStats,
		activeAccounts,
	});
});

// CDN Endpoints
const cdnApp = new Hono<{ Bindings: Env }>();

// Special case for direct file downloads
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
	const stats = ServicePool.getStats(c.env);

	// Bypass rate limiting for file downloads to ensure fast CDN performance
	const fileResponse = await storage.getFile(fileKey);

	if (!fileResponse) {
		return c.text('File not found', 404);
	}

	stats.incrementStat('cdn_downloads');

	// Return the file directly with proper headers for caching
	return fileResponse;
});

// Handle file management endpoints
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
	const stats = ServicePool.getStats(c.env);
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
			return c.json({
				error: 'File is required',
			}, 400);
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

		// Track uploads in stats
		await stats.incrementStat('cdn_uploads');

		// Return success with download URL
		return c.json({
			success: true,
			file: {
				key: result.key,
				etag: result.etag,
				url: new URL(`/cdn/files/${result.key}`, c.req.url).toString(),
			},
		}, 201);
	} catch (error) {
		console.error('File upload error:', error);
		return c.json({
			error: error instanceof Error ? error.message : 'Failed to upload file',
		}, 500);
	}
});

// List files
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
		return c.json({
			error: error instanceof Error ? error.message : 'Failed to list files',
		}, 500);
	}
});

// Delete a file
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
	const stats = ServicePool.getStats(c.env);
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
			return c.json({
				error: 'File not found',
			}, 404);
		}

		// Delete the file
		const storage = ServicePool.getStorage(c.env);
		const deleted = await storage.deleteFile(fileKey);

		if (!deleted) {
			return c.json({
				error: 'File not found',
			}, 404);
		}

		// Track deletions in stats
		await stats.incrementStat('cdn_deletions');

		return c.json({ success: true });
	} catch (error) {
		console.error('File deletion error:', error);
		return c.json({
			error: error instanceof Error ? error.message : 'Failed to delete file',
		}, 500);
	}
});

app.route('/cdn', cdnApp);

// EuroScope public file listing endpoint
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
		return c.json({
			error: 'Invalid ICAO format. Must be exactly 4 uppercase letters/numbers.',
		}, 400);
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
		return c.json({
			error: error instanceof Error ? error.message : 'Failed to list files',
		}, 500);
	}
});

// EuroScope file management endpoints
const euroscopeApp = new Hono<{
	Bindings: Env;
	Variables: {
		vatsimUser?: any;
		user?: any;
	};
}>();

// Middleware for EuroScope endpoints to authenticate users
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

// POST /euroscope/upload - Upload files to ICAO-specific folders
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
			return c.json({
				error: 'File is required',
			}, 400);
		}

		if (!icao) {
			return c.json({
				error: 'ICAO code is required',
			}, 400);
		}

		// Validate ICAO format (exactly 4 uppercase letters/numbers)
		if (!icao.match(/^[A-Z0-9]{4}$/)) {
			return c.json({
				error: 'Invalid ICAO format. Must be exactly 4 uppercase letters/numbers.',
			}, 400);
		}

		// Check file size limit (10MB)
		const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes
		if (file.size > MAX_FILE_SIZE) {
			return c.json({
				error: 'File size exceeds 10MB limit',
			}, 400);
		}

		// Check if user has access to upload files for this ICAO
		const divisions = ServicePool.getDivisions(c.env);
		const hasAccess = await divisions.userHasAirportAccess(vatsimUser.id.toString(), icao);

		if (!hasAccess) {
			return c.json({
				error: 'You do not have permission to upload files for this airport. Please ensure your division has approved access to this ICAO.',
			}, 403);
		}

		// Create file path: EuroScope/ICAO/filename
		const fileName = file.name;
		const fileKey = `EuroScope/${icao}/${fileName}`;

		// Check if this would exceed the 2 files per ICAO limit
		const storage = ServicePool.getStorage(c.env);
		const existingFiles = await storage.listFiles(`EuroScope/${icao}/`, 10);

		// Count files that are not the one being replaced
		const otherFiles = existingFiles.objects.filter(obj => obj.key !== fileKey);
		if (otherFiles.length >= 2) {
			return c.json({
				error: 'Maximum of 2 files per ICAO code allowed. Please delete an existing file before uploading a new one.',
			}, 400);
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
		return c.json({
			success: true,
			file: {
				key: result.key,
				icao: icao,
				fileName: fileName,
				size: file.size,
				url: new URL(`https://dev-cdn.stopbars.com/${result.key}`, c.req.url).toString(),
			},
		}, 201);
	} catch (error) {
		console.error('EuroScope file upload error:', error);
		return c.json({
			error: error instanceof Error ? error.message : 'Failed to upload file',
		}, 500);
	}
});

// DELETE /euroscope/files/:icao/:filename - Delete a specific file
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
		return c.json({
			error: 'Invalid ICAO format. Must be exactly 4 uppercase letters/numbers.',
		}, 400);
	}

	try {
		// Check if user has access to delete files for this ICAO
		const divisions = ServicePool.getDivisions(c.env);
		const hasAccess = await divisions.userHasAirportAccess(vatsimUser.id.toString(), icao);

		if (!hasAccess) {
			return c.json({
				error: 'You do not have permission to delete files for this airport. Please ensure your division has approved access to this ICAO.',
			}, 403);
		}

		// Construct the file key
		const fileKey = `EuroScope/${icao}/${filename}`;

		// Delete the file
		const storage = ServicePool.getStorage(c.env);
		const deleted = await storage.deleteFile(fileKey);

		if (!deleted) {
			return c.json({
				error: 'File not found',
			}, 404);
		}

		return c.json({
			success: true,
			message: `File ${filename} deleted successfully from ${icao}`,
		});
	} catch (error) {
		console.error('EuroScope file deletion error:', error);
		return c.json({
			error: error instanceof Error ? error.message : 'Failed to delete file',
		}, 500);
	}
});

// GET /euroscope/:icao/editable - Check if user has permission to edit files for an airport
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
		return c.json({
			error: 'Invalid ICAO format. Must be exactly 4 uppercase letters/numbers.',
		}, 400);
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
		return c.json({
			error: error instanceof Error ? error.message : 'Failed to check airport access',
		}, 500);
	}
});
app.route('/euroscope', euroscopeApp);

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
		const { key, namespace } = await c.req.json() as { key: string; namespace?: string };

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
		return c.json({
			error: error instanceof Error ? error.message : 'Failed to purge cache',
		}, 500);
	}
});

// Contributors endpoint
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
app.get('/contributors',
	withCache(() => 'github-contributors', 3600, 'github'), // Cache for 1 hour
	async (c) => {
		try {
			const github = ServicePool.getGitHub(c.env);
			const contributorsData = await github.getAllContributors();
			return c.json(contributorsData);
		} catch (error) {
			console.error('Contributors endpoint error:', error);
			return c.json({
				error: 'Failed to fetch contributors data',
				message: error instanceof Error ? error.message : 'Unknown error'
			}, 500);
		}
	}
);

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
app.get('/health',
	withCache(CacheKeys.fromUrl, 60, 'health'),
	async (c) => {
		const requestedService = c.req.query('service');
		const validServices = ['database', 'storage', 'vatsim', 'auth', 'stats'];

		if (requestedService && !validServices.includes(requestedService)) {
			return c.json({
				error: 'Invalid service',
				validServices: validServices,
			}, 400);
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
							'Accept': 'application/json',
							'User-Agent': 'BARS-Health-Check/1.0'
						},
						signal: AbortSignal.timeout(5000)
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

			if (servicesToCheck.includes('stats')) {
				try {
					const stats = ServicePool.getStats(c.env);
					await stats.getPublicStats();
				} catch (error) {
					healthChecks.stats = 'outage';
				}
			}

		} catch (error) {
			console.error('Health check error:', error);
		}

		const hasOutages = Object.values(healthChecks).some(status => status === 'outage');
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
