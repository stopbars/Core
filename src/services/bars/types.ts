export interface GeoPoint {
	lat: number;
	lon: number;
}

export interface BarsPolygon {
	id: string;
	points: GeoPoint[];
}

export interface BarsLightPoint extends GeoPoint {
	heading: number;
	properties?: LightProperties;
}

export interface LightProperties {
	type: string;
	elevated?: boolean;
	color?: string;
	directionality?: 'uni-directional' | 'bi-directional';
	intensity?: number;
	ihp?: boolean;
}

export interface BarsDBRecord {
	id: string;
	type: 'stopbar' | 'lead_on' | 'stand' | 'taxiway' | 'other';
	elevated?: boolean; // Whether the point should have elevated lights
	color?: string;
	intensity?: number;
	directionality?: 'uni-directional' | 'bi-directional';
	ihp?: boolean; // Whether this is an Intermediate Holding Point or not
}

export interface ProcessedBarsObject {
	id: string;
	type: string;
	points: BarsLightPoint[];
	properties: LightProperties;
}
