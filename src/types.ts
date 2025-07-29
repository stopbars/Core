export interface AuthResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
}

export interface VatsimUser {
	id: string;
	email: string;
}

export interface UserRecord {
	id: number;
	vatsim_id: string;
	api_key: string;
	email: string;
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

export interface StatsRecord {
	id: number;
	stat_key: string;
	value: number;
	day_key: string;
	last_updated: string;
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
