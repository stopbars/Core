import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Point } from './types';
import { VatsimService } from './services/vatsim';
import { AuthService } from './services/auth';
import { StatsService } from './services/stats';
import { RoleService, StaffRole } from './services/roles';
import { Connection } from './network/connection';
import { AirportService } from './services/airport';
import { DivisionService } from './services/divisions';
import { PointsService } from './services/points';
import { IDService } from './services/id';
import { SupportService } from './services/support';
import { PolygonService } from './services/polygons';
import { NotamService } from './services/notam';
import { UserService } from './services/users';
import { ContributionService } from './services/contributions';
import { StorageService } from './services/storage';

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

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Vatsim-Token, Upgrade, X-Client-Type',
};

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
app.get('/connect', async (c) => {
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
app.get('/state', async (c) => {
	const airport = c.req.query('airport');
	if (!airport) {
		return c.json({
			error: 'Airport parameter required',
		}, 400);
	}

	if (airport === 'all') {
		await c.env.DB.prepare("DELETE FROM active_objects WHERE last_updated <= datetime('now', '-2 day')").run();
		const stmt = c.env.DB.prepare("SELECT id, name FROM active_objects WHERE last_updated > datetime('now', '-2 day')");
		const activeObjects = await stmt.all();

		const allStates = await Promise.all(
			activeObjects.results.map(async (obj: any) => {
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

		return c.json({
			states: allStates,
		});
	} else {
		const id = c.env.BARS.idFromName(airport);
		const obj = c.env.BARS.get(id);

		if (airport.length !== 4) {
			return c.json({
				error: 'Invalid airport ICAO',
			}, 400);
		}

		const stateRequest = new Request(`https://internal/state?airport=${airport}`, {
			method: 'GET',
			headers: new Headers({
				'X-Request-Type': 'get_state',
			}),
		});

		return obj.fetch(stateRequest);
	}
});

// VATSIM auth callback
app.get('/auth/vatsim/callback', async (c) => {
	const code = c.req.query('code');
	if (!code) {
		return Response.redirect('https://v2.stopbars.com/auth?error=missing_code', 302);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);

	const { vatsimToken } = await auth.handleCallback(code);
	return Response.redirect(`https://stopbars.com/auth/callback?token=${vatsimToken}`, 302);
});

// Get account info
app.get('/auth/account', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) {
		return c.text('User not found', 404);
	}

	return c.json({
		...user,
		email: vatsimUser.email,
	});
});

// Regenerate API key
app.post('/auth/regenerate-api-key', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	try {
		const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
		const stats = new StatsService(c.env.DB);
		const auth = new AuthService(c.env.DB, vatsim, stats);

		const vatsimUser = await vatsim.getUser(vatsimToken);
		const user = await auth.getUserByVatsimId(vatsimUser.id);

		if (!user) {
			return c.text('User not found', 404);
		}

		// Check when the user last regenerated their API key
		const lastRegeneration = await c.env.DB.prepare('SELECT last_api_key_regen FROM users WHERE id = ?')
			.bind(user.id)
			.first<{ last_api_key_regen: string }>();

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

				return c.json({
					error: 'Rate limited',
					message: `You can only regenerate your API key once every 24 hours. Please try again in ${remainingHours} hour${remainingHours !== 1 ? 's' : ''}${remainingMinutes > 0 ? ` and ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}` : ''}.`,
					retryAfter: Math.ceil(remainingMs / 1000),
				}, 429);
			}
		}

		// Generate new API key
		const newApiKey = await auth.regenerateApiKey(user.id);

		// Update the last regeneration timestamp
		await c.env.DB.prepare("UPDATE users SET last_api_key_regen = datetime('now') WHERE id = ?").bind(user.id).run();

		return c.json({
			success: true,
			apiKey: newApiKey,
		});
	} catch (error) {
		return c.json({
			error: 'Failed to regenerate API key',
			message: error instanceof Error ? error.message : 'Unknown error',
		}, 500);
	}
});

// Delete account
app.delete('/auth/delete', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	try {
		const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
		const stats = new StatsService(c.env.DB);
		const auth = new AuthService(c.env.DB, vatsim, stats);

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
app.get('/auth/is-staff', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader) {
		return c.text('Unauthorized', 401);
	}

	const token = authHeader.replace('Bearer ', '');
	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);
	const roles = new RoleService(c.env.DB);

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
app.get('/airports', async (c) => {
	const airports = new AirportService(c.env.DB, c.env.AIRPORTDB_API_KEY);
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
});

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

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);

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
divisionsApp.get('/', async (c) => {
	const divisions = new DivisionService(c.env.DB);
	const allDivisions = await divisions.getAllDivisions();
	return c.json(allDivisions);
});

// POST /divisions - Create new division (requires lead_developer role)
divisionsApp.post('/', async (c) => {
	const user = c.get('user');
	const roles = new RoleService(c.env.DB);
	const divisions = new DivisionService(c.env.DB);

	const isLeadDev = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
	if (!isLeadDev) {
		return c.text('Forbidden', 403);
	}

	const { name, headVatsimId } = await c.req.json() as CreateDivisionPayload;
	const division = await divisions.createDivision(name, headVatsimId);
	return c.json(division);
});

// GET /divisions/user - Get user's divisions
divisionsApp.get('/user', async (c) => {
	const vatsimUser = c.get('vatsimUser');
	const divisions = new DivisionService(c.env.DB);

	const userDivisions = await divisions.getUserDivisions(vatsimUser.id);
	return c.json(userDivisions);
});

// GET /divisions/:id - Get division details
divisionsApp.get('/:id', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const divisions = new DivisionService(c.env.DB);

	const division = await divisions.getDivision(divisionId);
	if (!division) {
		return c.text('Division not found', 404);
	}

	return c.json(division);
});

// GET /divisions/:id/members - List division members
divisionsApp.get('/:id/members', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const divisions = new DivisionService(c.env.DB);

	// Verify division exists
	const division = await divisions.getDivision(divisionId);
	if (!division) {
		return c.text('Division not found', 404);
	}

	const members = await divisions.getDivisionMembers(divisionId);
	return c.json(members);
});

// POST /divisions/:id/members - Add member (requires nav_head role)
divisionsApp.post('/:id/members', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const vatsimUser = c.get('vatsimUser');
	const divisions = new DivisionService(c.env.DB);

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
divisionsApp.delete('/:id/members/:vatsimId', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const targetVatsimId = c.req.param('vatsimId');
	const vatsimUser = c.get('vatsimUser');
	const divisions = new DivisionService(c.env.DB);

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
divisionsApp.get('/:id/airports', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const divisions = new DivisionService(c.env.DB);

	// Verify division exists
	const division = await divisions.getDivision(divisionId);
	if (!division) {
		return c.text('Division not found', 404);
	}

	const airports = await divisions.getDivisionAirports(divisionId);
	return c.json(airports);
});

// POST /divisions/:id/airports - Request airport addition (requires division membership)
divisionsApp.post('/:id/airports', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const vatsimUser = c.get('vatsimUser');
	const divisions = new DivisionService(c.env.DB);

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
divisionsApp.post('/:id/airports/:airportId/approve', async (c) => {
	const divisionId = parseInt(c.req.param('id'));
	const airportId = parseInt(c.req.param('airportId'));
	const user = c.get('user');
	const vatsimUser = c.get('vatsimUser');
	const roles = new RoleService(c.env.DB);
	const divisions = new DivisionService(c.env.DB);

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
app.get('/airports/:icao/points', async (c) => {
	const airportId = c.req.param('icao');

	// Validate ICAO format (exactly 4 uppercase letters/numbers)
	if (!airportId.match(/^[A-Z0-9]{4}$/)) {
		return c.text('Invalid airport ICAO format', 400);
	}

	const idService = new IDService(c.env.DB);
	const divisions = new DivisionService(c.env.DB);
	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);
	const points = new PointsService(c.env.DB, idService, divisions, auth);

	const airportPoints = await points.getAirportPoints(airportId);
	return c.json(airportPoints);
});

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

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);
	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) {
		return c.text('Unauthorized', 401);
	}

	const idService = new IDService(c.env.DB);
	const divisions = new DivisionService(c.env.DB);
	const points = new PointsService(c.env.DB, idService, divisions, auth);

	const pointData = await c.req.json() as Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>;
	const newPoint = await points.createPoint(airportId, user.vatsim_id, pointData);
	return c.json(newPoint, 201);
});

app.put('/airports/:icao/points/:id', async (c) => {
	const airportId = c.req.param('icao');
	const pointId = c.req.param('id');

	// Validate ICAO format (exactly 4 uppercase letters/numbers)
	if (!airportId.match(/^[A-Z0-9]{4}$/)) {
		return c.text('Invalid airport ICAO format', 400);
	}

	// Validate point ID format (alphanumeric, dash, underscore)
	if (!pointId.match(/^[A-Z0-9-_]+$/)) {
		return c.text('Invalid point ID format', 400);
	}

	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);
	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) {
		return c.text('Unauthorized', 401);
	}

	const idService = new IDService(c.env.DB);
	const divisions = new DivisionService(c.env.DB);
	const points = new PointsService(c.env.DB, idService, divisions, auth);

	const updates = await c.req.json() as Partial<Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>>;
	const updatedPoint = await points.updatePoint(pointId, vatsimUser.id, updates);
	return c.json(updatedPoint);
});

app.delete('/airports/:icao/points/:id', async (c) => {
	const airportId = c.req.param('icao');
	const pointId = c.req.param('id');

	// Validate ICAO format (exactly 4 uppercase letters/numbers)
	if (!airportId.match(/^[A-Z0-9]{4}$/)) {
		return c.text('Invalid airport ICAO format', 400);
	}

	// Validate point ID format (alphanumeric, dash, underscore)
	if (!pointId.match(/^[A-Z0-9-_]+$/)) {
		return c.text('Invalid point ID format', 400);
	}

	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);
	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);
	if (!user) {
		return c.text('Unauthorized', 401);
	}

	const idService = new IDService(c.env.DB);
	const divisions = new DivisionService(c.env.DB);
	const points = new PointsService(c.env.DB, idService, divisions, auth);

	try {
		await points.deletePoint(pointId, vatsimUser.id);
		return c.body(null, 204);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'An unknown error occurred';
		return c.json({ error: message }, 403);
	}
});

// Light Support endpoints
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
		const supportService = new SupportService(c.env.DB);
		const polygonService = new PolygonService(c.env.DB);

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
app.get('/notam', async (c) => {
	const notamService = new NotamService(c.env.DB);
	const notamData = await notamService.getGlobalNotam();
	return c.json({
		notam: notamData?.content || null,
		type: notamData?.type || 'warning',
	});
});

app.put('/notam', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);
	const roles = new RoleService(c.env.DB);

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
	const notamService = new NotamService(c.env.DB);
	const updated = await notamService.updateGlobalNotam(content, type, user.vatsim_id);

	if (!updated) {
		return c.json({ error: 'Failed to update NOTAM' }, 500);
	}

	return c.json({ success: true });
});

// Public stats
app.get('/public-stats', async (c) => {
	const stats = new StatsService(c.env.DB);
	const publicStats = await stats.getPublicStats();
	return c.json(publicStats);
});

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

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);
	const roles = new RoleService(c.env.DB);

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

// DELETE /staff/users/:id - Delete a user
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

// GET /contributions - List all contributions with filters
contributionsApp.get('/', async (c) => {
	const contributions = new ContributionService(c.env.DB, new RoleService(c.env.DB), c.env.AIRPORTDB_API_KEY, c.env.BARS_STORAGE);

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
contributionsApp.get('/stats', async (c) => {
	const contributions = new ContributionService(c.env.DB, new RoleService(c.env.DB), c.env.AIRPORTDB_API_KEY, c.env.BARS_STORAGE);
	const stats = await contributions.getContributionStats();
	return c.json(stats);
});

// GET /contributions/leaderboard - Get top contributors
contributionsApp.get('/leaderboard', async (c) => {
	const contributions = new ContributionService(c.env.DB, new RoleService(c.env.DB), c.env.AIRPORTDB_API_KEY, c.env.BARS_STORAGE);
	const leaderboard = await contributions.getContributionLeaderboard();
	return c.json(leaderboard);
});

// GET /contributions/top-packages - Get a list of most used packages
contributionsApp.get('/top-packages', async (c) => {
	const contributions = new ContributionService(c.env.DB, new RoleService(c.env.DB), c.env.AIRPORTDB_API_KEY, c.env.BARS_STORAGE);
	const topPackages = await contributions.getTopPackages();
	return c.json(topPackages);
});

// POST /contributions - Create a new contribution
contributionsApp.post('/', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	try {
		const contributions = new ContributionService(c.env.DB, new RoleService(c.env.DB), c.env.AIRPORTDB_API_KEY, c.env.BARS_STORAGE);
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
contributionsApp.get('/user', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	// Parse query parameters
	const status = (c.req.query('status') as 'pending' | 'approved' | 'rejected' | 'all') || 'all';
	const page = 1; // Default to page 1 for user contributions
	const limit = Number.MAX_SAFE_INTEGER;

	const contributions = new ContributionService(c.env.DB, new RoleService(c.env.DB), c.env.AIRPORTDB_API_KEY, c.env.BARS_STORAGE);
	const result = await contributions.getUserContributions(user.vatsim_id, {
		status,
		page,
		limit,
	});

	return c.json(result);
});

// GET /contributions/:id - Get specific contribution
contributionsApp.get('/:id', async (c) => {
	const contributionId = c.req.param('id');
	const contributions = new ContributionService(c.env.DB, new RoleService(c.env.DB), c.env.AIRPORTDB_API_KEY, c.env.BARS_STORAGE);
	const contribution = await contributions.getContribution(contributionId);

	if (!contribution) {
		return c.text('Contribution not found', 404);
	}

	return c.json(contribution);
});

// POST /contributions/:id/decision - Process a decision (approve/reject)
contributionsApp.post('/:id/decision', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	try {
		const contributionId = c.req.param('id');
		const contributions = new ContributionService(c.env.DB, new RoleService(c.env.DB), c.env.AIRPORTDB_API_KEY, c.env.BARS_STORAGE);
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
contributionsApp.get('/user/display-name', async (c) => {
	const token = c.req.header('X-Vatsim-Token');
	if (!token) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const vatsimUser = await vatsim.getUser(token);
	const contributions = new ContributionService(c.env.DB, new RoleService(c.env.DB), c.env.AIRPORTDB_API_KEY, c.env.BARS_STORAGE);
	const displayName = await contributions.getUserDisplayName(vatsimUser.id);

	if (!displayName) {
		return c.text('User not found', 404);
	}

	return c.json({ displayName });
});

// DELETE /contributions/:id - Delete a contribution (admin only)
contributionsApp.delete('/:id', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);

	const vatsimUser = await vatsim.getUser(vatsimToken);
	const user = await auth.getUserByVatsimId(vatsimUser.id);

	if (!user) {
		return c.text('User not found', 404);
	}

	try {
		const contributionId = c.req.param('id');
		const contributions = new ContributionService(c.env.DB, new RoleService(c.env.DB), c.env.AIRPORTDB_API_KEY, c.env.BARS_STORAGE);
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
app.get('/staff-stats', async (c) => {
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);
	const roles = new RoleService(c.env.DB);

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
cdnApp.get('/files/*', async (c) => {
	// Extract the file key from the URL - everything after /cdn/files/
	const fileKey = c.req.param('*');

	if (!fileKey) {
		return c.text('File not found', 404);
	}

	const storage = new StorageService(c.env.BARS_STORAGE);
	const stats = new StatsService(c.env.DB);

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
cdnApp.post('/upload', async (c) => {
	// Require authentication for file uploads
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);
	const roles = new RoleService(c.env.DB);

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
		const storage = new StorageService(c.env.BARS_STORAGE);
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
cdnApp.get('/files', async (c) => {
	// Require authentication for listing files
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);
	const roles = new RoleService(c.env.DB);

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
		const storage = new StorageService(c.env.BARS_STORAGE);
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
cdnApp.delete('/files/*', async (c) => {
	// Require authentication for file deletion
	const vatsimToken = c.req.header('X-Vatsim-Token');
	if (!vatsimToken) {
		return c.text('Unauthorized', 401);
	}

	const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
	const stats = new StatsService(c.env.DB);
	const auth = new AuthService(c.env.DB, vatsim, stats);
	const roles = new RoleService(c.env.DB);

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
		const storage = new StorageService(c.env.BARS_STORAGE);
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

// Health endpoint
app.get('/health', async (c) => {
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
				const storage = new StorageService(c.env.BARS_STORAGE);
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
				const vatsim = new VatsimService(c.env.VATSIM_CLIENT_ID, c.env.VATSIM_CLIENT_SECRET);
				const stats = new StatsService(c.env.DB);
				const auth = new AuthService(c.env.DB, vatsim, stats);
				// Auth service depends on database, so if DB is down, this might fail too :P
			} catch (error) {
				healthChecks.auth = 'outage';
			}
		}

		if (servicesToCheck.includes('stats')) {
			try {
				const stats = new StatsService(c.env.DB);
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

// Catch all other routes
app.notFound((c) => {
	return c.text('Not Found', 404);
});

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return app.fetch(request, env);
	},
};
