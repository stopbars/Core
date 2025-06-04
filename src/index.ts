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
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			const url = new URL(request.url);
			const vatsim = new VatsimService(env.VATSIM_CLIENT_ID, env.VATSIM_CLIENT_SECRET);
			const stats = new StatsService(env.DB);
			const roles = new RoleService(env.DB);
			const auth = new AuthService(env.DB, vatsim, stats);
			const divisions = new DivisionService(env.DB);

			if (url.pathname === '/connect') {
				const airportId = url.searchParams.get('airport');
				const apiKey = url.searchParams.get('key');

				if (!apiKey) {
					return new Response('Missing API key', { status: 400 });
				}

				if (!airportId) {
					return new Response('Missing airport ID', { status: 400 });
				}

				const newHeaders = new Headers(request.headers);
				newHeaders.set('Authorization', `Bearer ${apiKey}`);

				const modifiedRequest = new Request(request.url, {
					method: request.method,
					headers: newHeaders,
					body: request.body,
				});

				const id = env.BARS.idFromName(airportId);
				const obj = env.BARS.get(id);
				return obj.fetch(modifiedRequest);
			}
			if (url.pathname === '/state') {
				if (request.method !== 'GET') {
					return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
				}

				const airport = url.searchParams.get('airport');
				if (!airport) {
					return new Response(
						JSON.stringify({
							error: 'Airport parameter required',
						}),
						{
							status: 400,
							headers: {
								'Content-Type': 'application/json',
								'Access-Control-Allow-Origin': '*',
							},
						},
					);
				}
				if (airport === 'all') {
					await env.DB.prepare("DELETE FROM active_objects WHERE last_updated <= datetime('now', '-2 day')").run();
					const stmt = env.DB.prepare("SELECT id, name FROM active_objects WHERE last_updated > datetime('now', '-2 day')");
					const activeObjects = await stmt.all();

					const allStates = await Promise.all(
						activeObjects.results.map(async (obj: any) => {
							const id = env.BARS.idFromString(obj.id);
							const durableObj = env.BARS.get(id);

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

					return new Response(
						JSON.stringify({
							states: allStates,
						}),
						{
							headers: {
								'Content-Type': 'application/json',
								'Access-Control-Allow-Origin': '*',
							},
						},
					);
				} else {
					const id = env.BARS.idFromName(airport);
					const obj = env.BARS.get(id);

					if (airport.length !== 4) {
						return new Response(
							JSON.stringify({
								error: 'Invalid airport ICAO',
							}),
							{
								status: 400,
								headers: {
									'Content-Type': 'application/json',
									'Access-Control-Allow-Origin': '*',
								},
							},
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
			}

			if (url.pathname === '/auth/vatsim/callback') {
				if (request.method !== 'GET') {
					return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
				}
				const code = url.searchParams.get('code');
				if (!code) {
					return Response.redirect('https://v2.stopbars.com/auth?error=missing_code', 302);
				}
				const { vatsimToken } = await auth.handleCallback(code);
				return Response.redirect(`https://stopbars.com/auth/callback?token=${vatsimToken}`, 302); // < -- Change this to your frontend Dev URL eg. http://localhost:5173/auth/callback?token=${vatsimToken}
			}

			if (url.pathname === '/auth/account') {
				if (request.method !== 'GET') {
					return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
				}
				const vatsimToken = request.headers.get('X-Vatsim-Token');
				if (!vatsimToken) {
					return new Response('Unauthorized', { status: 401, headers: corsHeaders });
				}
				const vatsimUser = await vatsim.getUser(vatsimToken);
				const user = await auth.getUserByVatsimId(vatsimUser.id);
				if (!user) {
					return new Response('User not found', { status: 404, headers: corsHeaders });
				}
				return new Response(
					JSON.stringify({
						...user,
						email: vatsimUser.email,
					}),
					{
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					},
				);
			}
			if (url.pathname === '/auth/regenerate-api-key') {
				if (request.method !== 'POST') {
					return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
				}
				const vatsimToken = request.headers.get('X-Vatsim-Token');
				if (!vatsimToken) {
					return new Response('Unauthorized', { status: 401, headers: corsHeaders });
				}

				try {
					const vatsimUser = await vatsim.getUser(vatsimToken);
					const user = await auth.getUserByVatsimId(vatsimUser.id);

					if (!user) {
						return new Response('User not found', { status: 404, headers: corsHeaders });
					}

					// Check when the user last regenerated their API key
					const lastRegeneration = await env.DB.prepare('SELECT last_api_key_regen FROM users WHERE id = ?')
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

							return new Response(
								JSON.stringify({
									error: 'Rate limited',
									message: `You can only regenerate your API key once every 24 hours. Please try again in ${remainingHours} hour${remainingHours !== 1 ? 's' : ''}${remainingMinutes > 0 ? ` and ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}` : ''}.`,
									retryAfter: Math.ceil(remainingMs / 1000),
								}),
								{
									status: 429,
									headers: {
										...corsHeaders,
										'Content-Type': 'application/json',
										'Retry-After': Math.ceil(remainingMs / 1000).toString(),
									},
								},
							);
						}
					}

					// Generate new API key
					const newApiKey = await auth.regenerateApiKey(user.id);

					// Update the last regeneration timestamp
					await env.DB.prepare("UPDATE users SET last_api_key_regen = datetime('now') WHERE id = ?").bind(user.id).run();

					return new Response(
						JSON.stringify({
							success: true,
							apiKey: newApiKey,
						}),
						{
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						},
					);
				} catch (error) {
					return new Response(
						JSON.stringify({
							error: 'Failed to regenerate API key',
							message: error instanceof Error ? error.message : 'Unknown error',
						}),
						{
							status: 500,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						},
					);
				}
			}

			if (url.pathname === '/auth/delete') {
				if (request.method !== 'DELETE') {
					return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
				}
				const vatsimToken = request.headers.get('X-Vatsim-Token');
				if (!vatsimToken) {
					return new Response('Unauthorized', { status: 401, headers: corsHeaders });
				}
				try {
					const vatsimUser = await vatsim.getUser(vatsimToken);
					const success = await auth.deleteUserAccount(vatsimUser.id);
					if (!success) {
						return new Response('User not found', { status: 404, headers: corsHeaders });
					}
					return new Response(null, { status: 204, headers: corsHeaders });
				} catch (error) {
					return new Response('Failed to delete account', {
						status: 500,
						headers: corsHeaders,
					});
				}
			}

			if (url.pathname === '/auth/is-staff') {
				if (request.method !== 'GET') {
					return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
				}
				const authHeader = request.headers.get('Authorization');
				if (!authHeader) {
					return new Response('Unauthorized', { status: 401, headers: corsHeaders });
				}
				const token = authHeader.replace('Bearer ', '');
				const vatsimUser = await vatsim.getUser(token);
				const user = await auth.getUserByVatsimId(vatsimUser.id);

				if (!user) {
					return new Response('Unauthorized', { status: 401, headers: corsHeaders });
				}

				const isStaff = await roles.isStaff(user.id);
				const role = await roles.getUserRole(user.id);
				return new Response(JSON.stringify({ isStaff, role }), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				});
			}

			if (url.pathname === '/airports') {
				if (request.method !== 'GET') {
					return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
				}

				const airports = new AirportService(env.DB, env.AIRPORTDB_API_KEY);
				const icao = url.searchParams.get('icao');
				const continent = url.searchParams.get('continent');

				try {
					let data;
					if (icao) {
						// Handle batch requests
						if (icao.includes(',')) {
							const icaos = icao.split(',').map((code) => code.trim());
							if (icaos.some((code) => !code.match(/^[A-Z0-9]{4}$/i))) {
								return new Response('Invalid ICAO format', {
									status: 400,
									headers: corsHeaders,
								});
							}
							data = await airports.getAirports(icaos);
						} else {
							// Single airport request
							data = await airports.getAirport(icao);
							if (!data) {
								return new Response('Airport not found', {
									status: 404,
									headers: corsHeaders,
								});
							}
						}
					} else if (continent) {
						data = await airports.getAirportsByContinent(continent);
					} else {
						return new Response('Missing query parameter', {
							status: 400,
							headers: corsHeaders,
						});
					}

					return new Response(JSON.stringify(data), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				} catch (error) {
					return new Response(JSON.stringify({ error: 'Failed to fetch airport data' }), {
						status: 500,
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}
			}

			if (url.pathname.startsWith('/divisions')) {
				const vatsimToken = request.headers.get('X-Vatsim-Token');
				if (!vatsimToken) {
					return new Response('Unauthorized', { status: 401, headers: corsHeaders });
				}

				const vatsimUser = await vatsim.getUser(vatsimToken);
				const user = await auth.getUserByVatsimId(vatsimUser.id);

				if (!user) {
					return new Response('User not found', { status: 404, headers: corsHeaders });
				}

				// GET /divisions - List all divisions
				if (url.pathname === '/divisions' && request.method === 'GET') {
					const allDivisions = await divisions.getAllDivisions();
					return new Response(JSON.stringify(allDivisions), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// POST /divisions - Create new division (requires lead_developer role)
				if (url.pathname === '/divisions' && request.method === 'POST') {
					const isLeadDev = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
					if (!isLeadDev) {
						return new Response('Forbidden', { status: 403, headers: corsHeaders });
					}

					const { name, headVatsimId } = (await request.json()) as CreateDivisionPayload;
					const division = await divisions.createDivision(name, headVatsimId);
					return new Response(JSON.stringify(division), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// GET /divisions/user - Get user's divisions
				if (url.pathname === '/divisions/user' && request.method === 'GET') {
					const userDivisions = await divisions.getUserDivisions(vatsimUser.id);
					return new Response(JSON.stringify(userDivisions), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// Division-specific routes
				const divisionMatch = url.pathname.match(/^\/divisions\/(\d+)/);
				if (divisionMatch) {
					const divisionId = parseInt(divisionMatch[1]);

					// GET /divisions/:id - Get division details
					if (url.pathname === `/divisions/${divisionId}` && request.method === 'GET') {
						const division = await divisions.getDivision(divisionId);

						if (!division) {
							return new Response('Division not found', {
								status: 404,
								headers: corsHeaders,
							});
						}

						return new Response(JSON.stringify(division), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}

					// Verify division exists for other routes
					const division = await divisions.getDivision(divisionId);
					if (!division) {
						return new Response('Division not found', { status: 404, headers: corsHeaders });
					}

					// GET /divisions/:id/members - List division members
					if (url.pathname.endsWith('/members') && request.method === 'GET') {
						const members = await divisions.getDivisionMembers(divisionId);
						return new Response(JSON.stringify(members), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}

					// POST /divisions/:id/members - Add member (requires nav_head role)
					if (url.pathname.endsWith('/members') && request.method === 'POST') {
						const userRole = await divisions.getMemberRole(divisionId, vatsimUser.id);
						if (userRole !== 'nav_head') {
							return new Response('Forbidden', { status: 403, headers: corsHeaders });
						}

						const { vatsimId, role } = (await request.json()) as AddMemberPayload;
						const member = await divisions.addMember(divisionId, vatsimId, role);
						return new Response(JSON.stringify(member), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}

					// DELETE /divisions/:id/members/:vatsimId - Remove member (requires nav_head role)
					const memberMatch = url.pathname.match(/^\/divisions\/\d+\/members\/(\d+)$/);
					if (memberMatch && request.method === 'DELETE') {
						const userRole = await divisions.getMemberRole(divisionId, vatsimUser.id);
						if (userRole !== 'nav_head') {
							return new Response('Forbidden', { status: 403, headers: corsHeaders });
						}

						const targetVatsimId = memberMatch[1];

						// Prevent removing yourself
						if (targetVatsimId === vatsimUser.id.toString()) {
							return new Response('Cannot remove yourself from the division', {
								status: 400,
								headers: corsHeaders,
							});
						}

						await divisions.removeMember(divisionId, targetVatsimId);
						return new Response(null, { status: 204, headers: corsHeaders });
					}

					// GET /divisions/:id/airports - List division airports
					if (url.pathname.endsWith('/airports') && request.method === 'GET') {
						const airports = await divisions.getDivisionAirports(divisionId);
						return new Response(JSON.stringify(airports), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}

					// POST /divisions/:id/airports - Request airport addition (requires division membership)
					if (url.pathname.endsWith('/airports') && request.method === 'POST') {
						const { icao } = (await request.json()) as RequestAirportPayload;
						const airport = await divisions.requestAirport(divisionId, icao, vatsimUser.id);
						return new Response(JSON.stringify(airport), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}

					// POST /divisions/:id/airports/:airportId/approve - Approve/reject airport (requires lead_developer role)
					const airportMatch = url.pathname.match(/^\/divisions\/\d+\/airports\/(\d+)\/approve$/);
					if (airportMatch && request.method === 'POST') {
						const isLeadDev = await roles.hasPermission(user.id, StaffRole.LEAD_DEVELOPER);
						if (!isLeadDev) {
							return new Response('Forbidden', { status: 403, headers: corsHeaders });
						}

						const airportId = parseInt(airportMatch[1]);
						const { approved } = (await request.json()) as ApproveAirportPayload;
						const airport = await divisions.approveAirport(airportId, vatsimUser.id, approved);
						return new Response(JSON.stringify(airport), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}
				}
			}

			// Points endpoints
			const pointsMatch = url.pathname.match(/^\/airports\/([A-Z]{4})\/points(\/.*)?$/);
			if (pointsMatch) {
				const airportId = pointsMatch[1];
				const subPath = pointsMatch[2] || '';

				// Initialize services
				const idService = new IDService(env.DB);
				const divisions = new DivisionService(env.DB);
				const points = new PointsService(env.DB, idService, divisions, auth);

				// GET /airports/:icao/points - List airport points
				if (request.method === 'GET' && !subPath) {
					const airportPoints = await points.getAirportPoints(airportId);
					return new Response(JSON.stringify(airportPoints), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// Need authentication for mutations
				const vatsimToken = request.headers.get('X-Vatsim-Token');
				if (!vatsimToken) {
					return new Response('Unauthorized', { status: 401, headers: corsHeaders });
				}
				const vatsimUser = await vatsim.getUser(vatsimToken);
				const user = await auth.getUserByVatsimId(vatsimUser.id);
				if (!user) {
					return new Response('Unauthorized', { status: 401, headers: corsHeaders });
				}

				// POST /airports/:icao/points - Create point
				if (request.method === 'POST' && !subPath) {
					const pointData = (await request.json()) as Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>;
					const newPoint = await points.createPoint(airportId, user.vatsim_id, pointData);
					return new Response(JSON.stringify(newPoint), {
						status: 201,
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// Point-specific operations need a point ID
				const pointIdMatch = subPath.match(/^\/([A-Z0-9-_]+)$/);
				if (!pointIdMatch) {
					return new Response('Invalid point ID format', { status: 400, headers: corsHeaders });
				}
				const pointId = pointIdMatch[1];

				// PUT /airports/:icao/points/:id - Update point
				if (request.method === 'PUT' && pointId) {
					const updates = (await request.json()) as Partial<Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>>;
					const updatedPoint = await points.updatePoint(pointId, vatsimUser.id, updates);
					return new Response(JSON.stringify(updatedPoint), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// DELETE /airports/:icao/points/:id - Delete point
				if (request.method === 'DELETE' && pointId) {
					try {
						await points.deletePoint(pointId, vatsimUser.id);
						return new Response(null, { status: 204, headers: corsHeaders });
					} catch (error) {
						const message = error instanceof Error ? error.message : 'An unknown error occurred';
						return new Response(JSON.stringify({ error: message }), {
							status: 403,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}
				}
			}

			// Light Support endpoints
			if (url.pathname === '/supports/generate') {
				if (request.method !== 'POST') {
					return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
				}

				try {
					const formData = await request.formData();
					const xmlFile = formData.get('xmlFile');
					const icao = formData.get('icao')?.toString();

					if (!xmlFile || !(xmlFile instanceof File)) {
						return new Response(
							JSON.stringify({
								error: 'XML file is required',
							}),
							{
								status: 400,
								headers: { ...corsHeaders, 'Content-Type': 'application/json' },
							},
						);
					}

					if (!icao) {
						return new Response(
							JSON.stringify({
								error: 'ICAO code is required',
							}),
							{
								status: 400,
								headers: { ...corsHeaders, 'Content-Type': 'application/json' },
							},
						);
					}

					const xmlContent = await xmlFile.text();
					const supportService = new SupportService(env.DB);
					const polygonService = new PolygonService(env.DB); // Generate both XML files in parallel
					const [supportsXml, barsXml] = await Promise.all([
						supportService.generateLightSupportsXML(xmlContent, icao),
						polygonService.processBarsXML(xmlContent, icao),
					]);

					// Return both XMLs as a JSON response
					return new Response(
						JSON.stringify({
							supportsXml,
							barsXml,
						}),
						{
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						},
					);
				} catch (error) {
					console.error('Error generating XMLs:', error);
					return new Response(
						JSON.stringify({
							error: error instanceof Error ? error.message : 'Unknown error generating XMLs',
						}),
						{
							status: 500,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						},
					);
				}
			}

			if (url.pathname === '/notam') {
				const notamService = new NotamService(env.DB);

				if (request.method === 'GET') {
					const notamData = await notamService.getGlobalNotam();
					return new Response(
						JSON.stringify({
							notam: notamData?.content || null,
							type: notamData?.type || 'warning',
						}),
						{
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						},
					);
				}

				if (request.method === 'PUT') {
					// For updates, require authentication
					const vatsimToken = request.headers.get('X-Vatsim-Token');
					if (!vatsimToken) {
						return new Response('Unauthorized', { status: 401, headers: corsHeaders });
					}

					const vatsimUser = await vatsim.getUser(vatsimToken);
					const user = await auth.getUserByVatsimId(vatsimUser.id);

					if (!user) {
						return new Response('User not found', { status: 404, headers: corsHeaders });
					}

					// Check if user has staff permissions
					const isStaff = await roles.isStaff(user.id);
					if (!isStaff) {
						return new Response('Forbidden', { status: 403, headers: corsHeaders });
					}

					// Update the NOTAM
					const { content, type } = (await request.json()) as { content: string; type?: string };
					const updated = await notamService.updateGlobalNotam(content, type, user.vatsim_id);

					if (!updated) {
						return new Response(JSON.stringify({ error: 'Failed to update NOTAM' }), {
							status: 500,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}

					return new Response(JSON.stringify({ success: true }), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
			}

			if (url.pathname === '/public-stats') {
				if (request.method !== 'GET') {
					return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
				}

				const publicStats = await stats.getPublicStats();
				return new Response(JSON.stringify(publicStats), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				});
			}

			// User Management endpoints
			if (url.pathname.startsWith('/staff/users')) {
				// Initialize UserService
				const userService = new UserService(env.DB, roles, auth);

				// All endpoints require authentication with vatsimToken
				const vatsimToken = request.headers.get('X-Vatsim-Token');
				if (!vatsimToken) {
					return new Response('Unauthorized', { status: 401, headers: corsHeaders });
				}

				const vatsimUser = await vatsim.getUser(vatsimToken);
				const user = await auth.getUserByVatsimId(vatsimUser.id);

				if (!user) {
					return new Response('User not found', { status: 404, headers: corsHeaders });
				}

				// GET /staff/users - Get all users with pagination
				if (url.pathname === '/staff/users' && request.method === 'GET') {
					try {
						const page = 1; // Default to page 1 for user contributions
						const limit = Number.MAX_SAFE_INTEGER; // Default to max limit for user contributions

						const result = await userService.getAllUsers(page, limit, user.id);

						return new Response(JSON.stringify(result), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : 'An unknown error occurred';
						return new Response(JSON.stringify({ error: message }), {
							status: error instanceof Error && error.message.includes('Unauthorized') ? 403 : 500,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}
				}

				// GET /staff/users/search - Search for users
				if (url.pathname === '/staff/users/search' && request.method === 'GET') {
					try {
						const query = url.searchParams.get('q') || '';
						if (query.length < 3) {
							return new Response(
								JSON.stringify({
									error: 'Search query must be at least 3 characters',
								}),
								{
									status: 400,
									headers: { ...corsHeaders, 'Content-Type': 'application/json' },
								},
							);
						}

						const results = await userService.searchUsers(query, user.id);

						return new Response(JSON.stringify({ users: results }), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : 'An unknown error occurred';
						return new Response(JSON.stringify({ error: message }), {
							status: error instanceof Error && error.message.includes('Unauthorized') ? 403 : 500,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}
				}

				// DELETE /staff/users/:id - Delete a user
				const deleteMatch = url.pathname.match(/^\/staff\/users\/(\d+)$/);
				if (deleteMatch && request.method === 'DELETE') {
					try {
						const userId = parseInt(deleteMatch[1]);

						const success = await userService.deleteUser(userId, user.id);

						return new Response(JSON.stringify({ success }), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : 'An unknown error occurred';
						return new Response(JSON.stringify({ error: message }), {
							status: error instanceof Error && error.message.includes('Unauthorized') ? 403 : 500,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}
				}
			} // Contribution endpoints
			if (url.pathname.startsWith('/contributions')) {
				// Initialize the contributions service
				const contributions = new ContributionService(env.DB, roles, env.AIRPORTDB_API_KEY, env.BARS_STORAGE);

				// GET /contributions - List all contributions with filters
				if (url.pathname === '/contributions' && request.method === 'GET') {
					// Parse query parameters for filtering
					const status = (url.searchParams.get('status') as 'pending' | 'approved' | 'rejected' | 'outdated' | 'all') || 'all';
					const airportIcao = url.searchParams.get('airport') || undefined;
					const userId = url.searchParams.get('user') || undefined;
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

					return new Response(JSON.stringify(result), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// GET /contributions/stats - Get contribution statistics
				if (url.pathname === '/contributions/stats' && request.method === 'GET') {
					const stats = await contributions.getContributionStats();
					return new Response(JSON.stringify(stats), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// GET /contributions/leaderboard - Get top contributors
				if (url.pathname === '/contributions/leaderboard' && request.method === 'GET') {
					const leaderboard = await contributions.getContributionLeaderboard();
					return new Response(JSON.stringify(leaderboard), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// GET /contributions/top-packages - Get a list of most used packages
				if (url.pathname === '/contributions/top-packages' && request.method === 'GET') {
					const topPackages = await contributions.getTopPackages();
					return new Response(JSON.stringify(topPackages), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// POST /contributions - Create a new contribution
				if (url.pathname === '/contributions' && request.method === 'POST') {
					// Require authentication for submissions
					const vatsimToken = request.headers.get('X-Vatsim-Token');
					if (!vatsimToken) {
						return new Response('Unauthorized', { status: 401, headers: corsHeaders });
					}

					const vatsimUser = await vatsim.getUser(vatsimToken);
					const user = await auth.getUserByVatsimId(vatsimUser.id);

					if (!user) {
						return new Response('User not found', { status: 404, headers: corsHeaders });
					}

					try {
						const payload = (await request.json()) as ContributionSubmissionPayload;
						const result = await contributions.createContribution({
							userId: user.vatsim_id,
							userDisplayName: payload.userDisplayName,
							airportIcao: payload.airportIcao,
							packageName: payload.packageName,
							submittedXml: payload.submittedXml,
							notes: payload.notes,
						});

						return new Response(JSON.stringify(result), {
							status: 201,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : 'An unknown error occurred';
						return new Response(JSON.stringify({ error: message }), {
							status: 400,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}
				}

				// GET /contributions/user - Get user's contributions
				if (url.pathname === '/contributions/user' && request.method === 'GET') {
					const vatsimToken = request.headers.get('X-Vatsim-Token');
					if (!vatsimToken) {
						return new Response('Unauthorized', { status: 401, headers: corsHeaders });
					}

					const vatsimUser = await vatsim.getUser(vatsimToken);
					const user = await auth.getUserByVatsimId(vatsimUser.id);

					if (!user) {
						return new Response('User not found', { status: 404, headers: corsHeaders });
					}

					// Parse query parameters
					const status = (url.searchParams.get('status') as 'pending' | 'approved' | 'rejected' | 'all') || 'all';
					const page = 1; // Default to page 1 for user contributions
					const limit = Number.MAX_SAFE_INTEGER;

					const result = await contributions.getUserContributions(user.vatsim_id, {
						status,
						page,
						limit,
					});

					return new Response(JSON.stringify(result), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// GET /contributions/:id - Get specific contribution
				const contributionMatch = url.pathname.match(/^\/contributions\/([^/]+)$/);
				if (contributionMatch && request.method === 'GET') {
					const contributionId = contributionMatch[1];
					const contribution = await contributions.getContribution(contributionId);

					if (!contribution) {
						return new Response('Contribution not found', { status: 404, headers: corsHeaders });
					}

					return new Response(JSON.stringify(contribution), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// POST /contributions/:id/decision - Process a decision (approve/reject)
				const decisionMatch = url.pathname.match(/^\/contributions\/([^/]+)\/decision$/);
				if (decisionMatch && request.method === 'POST') {
					// Require authentication for decisions
					const vatsimToken = request.headers.get('X-Vatsim-Token');
					if (!vatsimToken) {
						return new Response('Unauthorized', { status: 401, headers: corsHeaders });
					}

					const vatsimUser = await vatsim.getUser(vatsimToken);
					const user = await auth.getUserByVatsimId(vatsimUser.id);

					if (!user) {
						return new Response('User not found', { status: 404, headers: corsHeaders });
					}

					try {
						const contributionId = decisionMatch[1];
						const payload = (await request.json()) as ContributionDecisionPayload;
						const result = await contributions.processDecision(contributionId, user.vatsim_id, {
							approved: payload.approved,
							rejectionReason: payload.rejectionReason,
							newPackageName: payload.newPackageName,
						});

						return new Response(JSON.stringify(result), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : 'An unknown error occurred';
						return new Response(JSON.stringify({ error: message }), {
							status: error instanceof Error && error.message.includes('Not authorized') ? 403 : 400,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}
				}

				// GET /contributions/user/display-name - Get user's display name
				const displayNameMatch = url.pathname.match(/^\/contributions\/user\/display-name$/);
				// Require authentication for display name retrieval
				if (displayNameMatch && request.method === 'GET') {
					const token = request.headers.get('X-Vatsim-Token');

					if (!token) {
						return new Response('Unauthorized', { status: 401, headers: corsHeaders });
					}

					const vatsimUser = await vatsim.getUser(token);
					const displayName = await contributions.getUserDisplayName(vatsimUser.id);

					if (!displayName) {
						return new Response('User not found', { status: 404, headers: corsHeaders });
					}

					return new Response(JSON.stringify({ displayName }), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}

				// DELETE /contributions/:id - Delete a contribution (admin only)
				const deleteMatch = url.pathname.match(/^\/contributions\/([^/]+)$/);
				if (deleteMatch && request.method === 'DELETE') {
					// Require authentication for deletion
					const vatsimToken = request.headers.get('X-Vatsim-Token');
					if (!vatsimToken) {
						return new Response('Unauthorized', { status: 401, headers: corsHeaders });
					}

					const vatsimUser = await vatsim.getUser(vatsimToken);
					const user = await auth.getUserByVatsimId(vatsimUser.id);

					if (!user) {
						return new Response('User not found', { status: 404, headers: corsHeaders });
					}

					try {
						const contributionId = deleteMatch[1];
						const success = await contributions.deleteContribution(contributionId, user.vatsim_id);

						return new Response(JSON.stringify({ success }), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : 'An unknown error occurred';
						return new Response(JSON.stringify({ error: message }), {
							status: error instanceof Error && error.message.includes('Not authorized') ? 403 : 400,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}
				}
			}

			if (url.pathname === '/staff-stats') {
				if (request.method !== 'GET') {
					return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
				}

				const vatsimToken = request.headers.get('X-Vatsim-Token');
				if (!vatsimToken) {
					return new Response('Unauthorized', { status: 401, headers: corsHeaders });
				}

				const vatsimUser = await vatsim.getUser(vatsimToken);
				const user = await auth.getUserByVatsimId(vatsimUser.id);

				if (!user) {
					return new Response('User not found', { status: 404, headers: corsHeaders });
				}

				const isStaff = await roles.hasPermission(user.id, StaffRole.PRODUCT_MANAGER);
				if (!isStaff) {
					return new Response('Forbidden', { status: 403, headers: corsHeaders });
				}

				// Check for daily stats query parameters
				const days = url.searchParams.get('days');
				const statKey = url.searchParams.get('stat');

				// If both days and stat parameters are provided, return daily stats
				if (days && statKey) {
					const daysNum = parseInt(days);
					if (isNaN(daysNum) || daysNum <= 0) {
						return new Response(JSON.stringify({ error: 'Invalid days parameter' }), {
							status: 400,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					}

					const dailyStats = await stats.getDailyStats(statKey, daysNum);

					// Calculate the total count across all days
					const totalCount = dailyStats.reduce((sum, day) => sum + day.value, 0);

					return new Response(
						JSON.stringify({
							dailyStats,
							totalCount,
						}),
						{
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						},
					);
				}

				// Get count of active accounts
				const activeAccountsResult = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
				const activeAccounts = activeAccountsResult?.count || 0;

				const [publicStats, sensitiveStats] = await Promise.all([stats.getPublicStats(), stats.getSensitiveStats()]);

				return new Response(
					JSON.stringify({
						...publicStats,
						...sensitiveStats,
						activeAccounts,
					}),
					{
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					},
				);
			}

			// CDN Endpoints
			if (url.pathname.startsWith('/cdn')) {
				// Initialize the storage service
				const storage = new StorageService(env.BARS_STORAGE);

				// Special case for direct file downloads
				if (url.pathname.startsWith('/cdn/files/') && request.method === 'GET') {
					// Extract the file key from the URL - everything after /cdn/files/
					const fileKey = url.pathname.replace('/cdn/files/', '');

					if (!fileKey) {
						return new Response('File not found', { status: 404, headers: corsHeaders });
					}

					// Bypass rate limiting for file downloads to ensure fast CDN performance
					const fileResponse = await storage.getFile(fileKey);

					if (!fileResponse) {
						return new Response('File not found', { status: 404, headers: corsHeaders });
					}

					stats.incrementStat('cdn_downloads');

					// Return the file directly with proper headers for caching
					return fileResponse;
				}

				// Handle file management endpoints
				if (url.pathname === '/cdn/upload' && request.method === 'POST') {
					// Require authentication for file uploads
					const vatsimToken = request.headers.get('X-Vatsim-Token');
					if (!vatsimToken) {
						return new Response('Unauthorized', { status: 401, headers: corsHeaders });
					}

					const vatsimUser = await vatsim.getUser(vatsimToken);
					const user = await auth.getUserByVatsimId(vatsimUser.id);

					if (!user) {
						return new Response('User not found', { status: 404, headers: corsHeaders });
					}

					// Check if user has permission to upload files
					const isStaff = await roles.isStaff(user.id);
					if (!isStaff) {
						return new Response('Forbidden', { status: 403, headers: corsHeaders });
					}

					try {
						const formData = await request.formData();
						const file = formData.get('file');
						const path = formData.get('path')?.toString() || '';
						const customKey = formData.get('key')?.toString();

						if (!file || !(file instanceof File)) {
							return new Response(
								JSON.stringify({
									error: 'File is required',
								}),
								{
									status: 400,
									headers: { ...corsHeaders, 'Content-Type': 'application/json' },
								},
							);
						}

						// Create file path - use custom key if provided, otherwise generate one
						// Path format: [path]/[filename].[ext]
						const fileName = customKey || file.name;
						const fileKey = path ? `${path}/${fileName}` : fileName;

						// Extract file data
						const fileData = await file.arrayBuffer();

						// Upload file to storage
						const result = await storage.uploadFile(fileKey, fileData, file.type, {
							uploadedBy: user.vatsim_id,
							fileName: file.name,
							size: file.size.toString(),
						});

						// Track uploads in stats
						await stats.incrementStat('cdn_uploads');

						// Return success with download URL
						return new Response(
							JSON.stringify({
								success: true,
								file: {
									key: result.key,
									etag: result.etag,
									url: new URL(`/cdn/files/${result.key}`, request.url).toString(),
								},
							}),
							{
								status: 201,
								headers: { ...corsHeaders, 'Content-Type': 'application/json' },
							},
						);
					} catch (error) {
						console.error('File upload error:', error);
						return new Response(
							JSON.stringify({
								error: error instanceof Error ? error.message : 'Failed to upload file',
							}),
							{
								status: 500,
								headers: { ...corsHeaders, 'Content-Type': 'application/json' },
							},
						);
					}
				}

				// List files
				if (url.pathname === '/cdn/files' && request.method === 'GET') {
					// Require authentication for listing files
					const vatsimToken = request.headers.get('X-Vatsim-Token');
					if (!vatsimToken) {
						return new Response('Unauthorized', { status: 401, headers: corsHeaders });
					}

					const vatsimUser = await vatsim.getUser(vatsimToken);
					const user = await auth.getUserByVatsimId(vatsimUser.id);

					if (!user) {
						return new Response('User not found', { status: 404, headers: corsHeaders });
					}

					// Only staff can list all files
					const isStaff = await roles.isStaff(user.id);
					if (!isStaff) {
						return new Response('Forbidden', { status: 403, headers: corsHeaders });
					}

					try {
						const prefix = url.searchParams.get('prefix') || undefined;
						const limit = Number.MAX_SAFE_INTEGER;

						// Get list of files
						const result = await storage.listFiles(prefix, limit);

						// Format for easier use by clients
						const files = result.objects.map((obj) => ({
							key: obj.key,
							etag: obj.etag,
							size: obj.size,
							uploaded: obj.uploaded.toISOString(),
							url: new URL(`/cdn/files/${obj.key}`, request.url).toString(),
							metadata: obj.customMetadata || {},
						}));

						return new Response(JSON.stringify({ files }), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					} catch (error) {
						console.error('File listing error:', error);
						return new Response(
							JSON.stringify({
								error: error instanceof Error ? error.message : 'Failed to list files',
							}),
							{
								status: 500,
								headers: { ...corsHeaders, 'Content-Type': 'application/json' },
							},
						);
					}
				}

				// Delete a file
				if (url.pathname.match(/^\/cdn\/files\/(.+)$/) && request.method === 'DELETE') {
					// Require authentication for file deletion
					const vatsimToken = request.headers.get('X-Vatsim-Token');
					if (!vatsimToken) {
						return new Response('Unauthorized', { status: 401, headers: corsHeaders });
					}

					const vatsimUser = await vatsim.getUser(vatsimToken);
					const user = await auth.getUserByVatsimId(vatsimUser.id);

					if (!user) {
						return new Response('User not found', { status: 404, headers: corsHeaders });
					}

					// Only staff can delete files
					const isStaff = await roles.isStaff(user.id);
					if (!isStaff) {
						return new Response('Forbidden', { status: 403, headers: corsHeaders });
					}

					try {
						const fileKey = url.pathname.replace('/cdn/files/', '');

						// Delete the file
						const deleted = await storage.deleteFile(fileKey);

						if (!deleted) {
							return new Response(
								JSON.stringify({
									error: 'File not found',
								}),
								{
									status: 404,
									headers: { ...corsHeaders, 'Content-Type': 'application/json' },
								},
							);
						}

						// Track deletions in stats
						await stats.incrementStat('cdn_deletions');

						return new Response(JSON.stringify({ success: true }), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					} catch (error) {
						console.error('File deletion error:', error);
						return new Response(
							JSON.stringify({
								error: error instanceof Error ? error.message : 'Failed to delete file',
							}),
							{
								status: 500,
								headers: { ...corsHeaders, 'Content-Type': 'application/json' },
							},
						);
					}
				}
			}

			// Original catch-all 404 response
			return new Response('Not Found', { status: 404 });
		} catch (error) {
			console.error(error);
			return new Response('Server Error', { status: 500 });
		}
	},
};
