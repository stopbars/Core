export interface AuthResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
}

export interface VatsimUser {
	id: string;
	email: string;
	first_name?: string;
	last_name?: string;
	region?: { id: string; name: string } | null;
	division?: { id: string; name: string } | null;
	subdivision?: { id: string; name: string } | null;
}

export interface UserRecord {
	id: number;
	vatsim_id: string;
	api_key: string;
	email: string;
	full_name?: string | null;
	display_mode?: number; // 0=First,1=First LastInitial,2=CID
	display_name?: string | null; // cached display name
	region_id?: string | null;
	region_name?: string | null;
	division_id?: string | null;
	division_name?: string | null;
	subdivision_id?: string | null;
	subdivision_name?: string | null;
	created_at: string;
	last_login: string;
	vatsimToken: string;
}

export interface VatsimUserResponse {
	data: {
		cid: string;
		personal: {
			email: string;
			name_first?: string;
			name_last?: string;
			name_full?: string;
		};
		vatsim?: {
			region?: { id?: string | null; name?: string | null } | null;
			division?: { id?: string | null; name?: string | null } | null;
			subdivision?: { id?: string | null; name?: string | null } | null;
			rating?: { id?: number; long?: string; short?: string } | null;
			pilotrating?: { id?: number; long?: string; short?: string } | null;
		} | null;
		oauth?: { token_valid?: string } | null;
	};
}

import { Role } from './services/roles';

export interface StaffResponse {
	isStaff: boolean;
	role?: Role;
}

export interface StaffRecord {
	id: number;
	user_id: number;
	role: Role;
	created_at: string;
}

export type LightType = 'STOPBAR' | 'LEAD_ON';
export type MessageType = LightType;
export type ClientType = 'controller' | 'pilot' | 'observer';

export interface LightState {
	barsId: string;
	type: LightType;
	state: boolean;
	controllerId: string;
	timestamp: number;
}

export interface StateUpdate {
	type: MessageType;
	action: 'UPDATE' | 'HEARTBEAT';
	data: UpdateData;
}

export interface UpdateData {
	barsId: string;
	state: boolean;
}

export interface ControllerState {
	lastUpdate: number;
	lights: Map<string, LightState>;
}

export interface AirportObject {
	id: string; // BARS Global ID
	state: boolean | Record<string, unknown>;
	controllerId?: string; // ID of controller who last modified
	timestamp: number;
}

export interface AirportState {
	airport: string;
	objects: Map<string, AirportObject>;
	lastUpdate: number;
	controllers: Set<string>;
}

export interface Packet {
	type:
		| 'STATE_UPDATE'
		| 'INITIAL_STATE'
		| 'CONTROLLER_CONNECT'
		| 'CONTROLLER_DISCONNECT'
		| 'SHARED_STATE_UPDATE'
		| 'ERROR'
		| 'HEARTBEAT'
		| 'HEARTBEAT_ACK'
		| 'CLOSE'
		| 'GET_STATE'
		| 'STATE_SNAPSHOT'
		| 'STOPBAR_CROSSING';
	airport?: string;
	data?: {
		objectId?: string;
		state?: boolean;
		patch?: Record<string, unknown>; // New field for patch-based updates
		sharedStatePatch?: Record<string, unknown>; // New field for shared state patches
		sharedState?: Record<string, unknown>; // Full shared state (for initial state)
		objects?: AirportObject[];
		controllerId?: string;
		message?: string; // For error messages
		connectionType?: ClientType; // Add connection type to data
		offline?: boolean; // Flag to indicate if state is offline (no controllers)
		requestedAt?: number; // For STATE_SNAPSHOT - when request was made
	};
	timestamp?: number; // Optional since server will set it
}

export const HEARTBEAT_INTERVAL = 60000; // 60 seconds
export const HEARTBEAT_TIMEOUT = 70000; // 70 seconds

export type HeartbeatPacket = {
	type: 'HEARTBEAT' | 'HEARTBEAT_ACK';
	timestamp?: number; // Optional - server will set this
};

export interface Point {
	id: string;
	airportId: string;
	type: 'stopbar' | 'lead_on' | 'taxiway' | 'stand';
	name: string;
	coordinates: Array<{
		lat: number;
		lng: number;
	}>;
	directionality?: 'bi-directional' | 'uni-directional';
	color?: 'yellow' | 'green' | 'green-yellow' | 'green-orange' | 'green-blue';
	elevated?: boolean;
	ihp?: boolean;
	createdAt: string;
	updatedAt: string;
	createdBy: string;
}

export type PointData = Omit<Point, 'id' | 'airportId' | 'createdAt' | 'updatedAt' | 'createdBy'>;

// Transaction containing multiple updates to points data
export type PointChangeset = {
	create?: PointData[];
	modify?: Record<string, Partial<PointData>>; // Keyed by ID
	delete?: string[]; // IDs
};

/**
 * @openapi
 * components:
 *   securitySchemes:
 *     VatsimToken:
 *       type: apiKey
 *       in: header
 *       name: X-Vatsim-Token
 *       description: VATSIM authentication token obtained via OAuth callback.
 *     ApiKeyAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: API Key
 *       description: User API key passed as Bearer token in Authorization header.
 *   schemas:
 *     Coordinate:
 *       type: object
 *       required: [lat, lng]
 *       properties:
 *         lat:
 *           type: number
 *           description: Latitude in decimal degrees.
 *         lng:
 *           type: number
 *           description: Longitude in decimal degrees.
 *     Coordinates:
 *       type: array
 *       minItems: 2
 *       items:
 *         $ref: '#/components/schemas/Coordinate'
 *     PointData:
 *       type: object
 *       required: [type, name, coordinates]
 *       properties:
 *         type:
 *           type: string
 *           enum: [stopbar, lead_on, taxiway, stand]
 *           description: Point category.
 *         name:
 *           type: string
 *           description: Human readable point name / identifier.
 *         coordinates:
 *           $ref: '#/components/schemas/Coordinates'
 *         directionality:
 *           type: string
 *           enum: [bi-directional, uni-directional]
 *         color:
 *           type: string
 *           enum: [yellow, green, green-yellow, green-orange, green-blue]
 *         elevated:
 *           type: boolean
 *         ihp:
 *           type: boolean
 *           description: In pavement (false) vs elevated (true) for some systems.
 *       description: Point creation object. Server assigns id, airportId, created/updated timestamps & createdBy.
 *     Point:
 *       allOf:
 *         - $ref: '#/components/schemas/PointData'
 *         - type: object
 *           required: [id, airportId, createdAt, updatedAt, createdBy]
 *           properties:
 *             id: { type: string }
 *             airportId: { type: string }
 *             createdAt: { type: string, format: date-time }
 *             updatedAt: { type: string, format: date-time }
 *             createdBy: { type: string, description: 'VATSIM ID of creator' }
 *           description: Persisted point including server-managed fields.
 *     PointDataPartial:
 *       type: object
 *       description: Partial PointData used for updates. All properties optional.
 *       properties:
 *         type: { type: string, enum: [stopbar, lead_on, taxiway, stand] }
 *         name: { type: string }
 *         coordinates:
 *           type: array
 *           minItems: 2
 *           items:
 *             $ref: '#/components/schemas/Coordinate'
 *         directionality: { type: string, enum: [bi-directional, uni-directional] }
 *         color: { type: string, enum: [yellow, green, green-yellow, green-orange, green-blue] }
 *         elevated: { type: boolean }
 *         ihp: { type: boolean }
 *     PointChangeset:
 *       type: object
 *       description: Transactional batch of point operations. Operations are applied atomically where possible.
 *       properties:
 *         create:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/PointData'
 *           description: List of new points to create.
 *         modify:
 *           type: object
 *           additionalProperties:
 *             $ref: '#/components/schemas/PointDataPartial'
 *           description: Map of point ID -> partial point data to update.
 *         delete:
 *           type: array
 *           items: { type: string }
 *           description: List of point IDs to delete.
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         error: { type: string }
 *         message: { type: string }
 *         code: { type: string, description: 'Optional machine-readable error code' }
 *       required: [error]
 *       description: Standard error envelope.
 */
