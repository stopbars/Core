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
}

export interface UserRecord {
	id: number;
	vatsim_id: string;
	api_key: string;
	email: string;
	full_name?: string | null;
	display_mode?: number; // 0=First,1=First LastInitial,2=CID
	display_name?: string | null; // cached display name
	created_at: string;
	last_login: string;
	vatsimToken: string;
}

export interface VatsimUserResponse {
	data: {
		cid: string;
		personal: {
			email: string;
		};
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

export type LightType = 'STOPBAR' | 'LEADON';
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
	state: boolean | Record<string, any>;
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
	| 'CLOSE';
	airport?: string; data?: {
		objectId?: string;
		state?: boolean;
		patch?: Record<string, any>; // New field for patch-based updates
		sharedStatePatch?: Record<string, any>; // New field for shared state patches
		sharedState?: Record<string, any>; // Full shared state (for initial state)
		objects?: AirportObject[];
		controllerId?: string;
		message?: string; // For error messages
		connectionType?: ClientType; // Add connection type to data
		offline?: boolean; // Flag to indicate if state is offline (no controllers)
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
	coordinates: {
		lat: number;
		lng: number;
	};
	directionality?: 'bi-directional' | 'uni-directional';
	orientation?: 'left' | 'right';
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
	create?: PointData[],
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
 *     Coordinates:
 *       type: object
 *       required: [lat, lng]
 *       properties:
 *         lat:
 *           type: number
 *           description: Latitude in decimal degrees.
 *         lng:
 *           type: number
 *           description: Longitude in decimal degrees.
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
 *         orientation:
 *           type: string
 *           enum: [left, right]
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
 *           type: object
 *           properties:
 *             lat: { type: number }
 *             lng: { type: number }
 *         directionality: { type: string, enum: [bi-directional, uni-directional] }
 *         orientation: { type: string, enum: [left, right] }
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
