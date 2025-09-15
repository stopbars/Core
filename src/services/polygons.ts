import { AirportService } from './airport';
import { processBarsPolygon, deduplicateTaxiwayPoints } from './bars/handlers';
import { BarsPolygon, BarsDBRecord, ProcessedBarsObject, BarsLightPoint, LightProperties } from './bars/types';
import { calculateDistance } from './bars/geoUtils';

import { DatabaseSessionService } from './database-session';

type PointRow = {
	id: string;
	type: string;
	airport_id: string;
	directionality: string | null;
	orientation: string | null;
	color: string | null;
	elevated: number | boolean | null;
	ihp: number | boolean | null;
	name: string;
	coordinates: string;
};

export class PolygonService {
	private airportService: AirportService;
	private dbSession: DatabaseSessionService;

	constructor(
		private db: D1Database,
		private airportApiKey?: string,
	) {
		this.airportService = new AirportService(db, airportApiKey || '');
		this.dbSession = new DatabaseSessionService(db);
	}

	/**
	 * Parses BARS polygons (ones with displayName starting with "BARS_") from XML content
	 */
	parseBarsPolygonsFromXML(xmlContent: string): BarsPolygon[] {
		const polygons: BarsPolygon[] = [];
		const regex = {
			polygon: /<Polygon([^>]*)>([\s\S]*?)<\/Polygon>/g,
			vertex: /<Vertex\s+lat="([^"]+)"\s+lon="([^"]+)"/g,
			displayName: /displayName="(BARS_[^"]+)"/,
		};

		let polygonMatch;
		while ((polygonMatch = regex.polygon.exec(xmlContent)) !== null) {
			const polygonContent = polygonMatch[0];
			const polygonAttributes = polygonMatch[1];

			// Check if this polygon has displayName starting with "BARS_"
			const displayNameMatch = polygonAttributes.match(regex.displayName);
			if (!displayNameMatch) {
				continue; // Skip if not a BARS polygon
			}

			const id = displayNameMatch[1]; // This is the BARS_XXXX id
			const points: Array<{ lat: number; lon: number }> = [];

			let vertexMatch;
			while ((vertexMatch = regex.vertex.exec(polygonContent)) !== null) {
				points.push({
					lat: parseFloat(vertexMatch[1]),
					lon: parseFloat(vertexMatch[2]),
				});
			}

			if (points.length > 0) {
				polygons.push({ id, points });
			}
		}

		return polygons;
	}

	/**
	 * Gets a BARS record from the database by ID
	 */ async getBarsRecordFromDB(id: string): Promise<BarsDBRecord | null> {
		try {
			const barsId = id.startsWith('BARS_') ? id : `BARS_${id}`;
			const result = await this.dbSession.executeRead<PointRow>(
				`
		SELECT id, type, airport_id, directionality, orientation, color, elevated, ihp, name, coordinates
		FROM points 
		WHERE id = ?
	  `,
				[barsId],
			);
			if (!result.results[0]) {
				return null;
			}
			return this.mapBarsRecordFromDb(result.results[0]);
		} catch {
			return null;
		}
	}
	/**
	 * Maps database result to BarsDBRecord
	 */
	private mapBarsRecordFromDb(dbResult: PointRow): BarsDBRecord {
		// Extract type from database fields - handle both column structures
		const dbType = dbResult.type || '';
		const dbDirectionality = dbResult.directionality || '';

		let type: 'stopbar' | 'leadon' | 'stand' | 'taxiway' | 'other';
		if (dbType === 'stopbar') {
			type = 'stopbar';
		} else if (dbType === 'leadon' || dbType === 'lead_on' || dbDirectionality === 'lead-on' || dbDirectionality === 'lead_on') {
			type = 'leadon';
		} else if (dbType === 'stand') {
			type = 'stand';
		} else if (dbType === 'taxiway') {
			type = 'taxiway';
		} else {
			type = 'other';
		}

		// Orientation removed; use directionality only

		// Parse color based on type
		let color: string;

		if (type === 'stopbar') {
			color = 'red';
		} else if (type === 'stand') {
			color = 'yellow'; // Stand lead-in lights are amber
		} else if (type === 'taxiway') {
			// For taxiway segments, respect the stored color or default to green
			color = dbResult.color || 'green';
		} else {
			// Default for other types
			color = dbResult.color || 'yellow';
		}
		return {
			id: dbResult.id,
			type,
			elevated: dbResult.elevated === 1 || dbResult.elevated === true,
			color,
			intensity: 1.0,
			directionality:
				dbResult.directionality === 'bi-directional' || dbResult.directionality === 'uni-directional'
					? dbResult.directionality
					: undefined, // normalized
			ihp: dbResult.ihp === 1 || dbResult.ihp === true, // Add IHP flag
		};
	}

	/**
	 * Maps directionality to BARS type
	 */
	private mapTypeFromDirectionality(type: string, directionality: string): 'stopbar' | 'leadon' | 'stand' | 'other' {
		if (type === 'stopbar') return 'stopbar';
		if (type === 'taxiway' && directionality === 'lead-on') return 'leadon';
		if (type === 'leadon') return 'leadon';
		if (type === 'stand') return 'stand';
		return 'other';
	}

	/**
	 * Maps orientation string to expected format
	 */
	/**

  /**
   * Generates BARS light locations XML from processed objects
   */
	generateBarsLightsXML(processedObjects: ProcessedBarsObject[]): string {
		if (processedObjects.length === 0) {
			throw new Error('No BARS objects to generate XML');
		}

		const out: string[] = [];
		out.push('<?xml version="1.0" encoding="utf-8"?>');
		out.push('<BarsLights>');

		// Add each object
		for (const obj of processedObjects) {
			// stateId moved to per-light level (previously on BarsObject)
			out.push(`\t<BarsObject id="${obj.id}" type="${obj.type}">`);

			// Add properties
			const props = obj.properties;
			out.push('\t\t<Properties>');
			if (props.color) out.push(`\t\t\t<Color>${props.color}</Color>`);
			if (props.directionality) out.push(`\t\t\t<Directionality>${props.directionality}</Directionality>`);

			if (props.intensity !== undefined) out.push(`\t\t\t<Intensity>${props.intensity}</Intensity>`);
			out.push('\t\t</Properties>');

			// Add light points
			for (const point of obj.points) {
				// Determine per-light color only (orientation removed)
				const lightColor = (point.properties?.color || obj.properties.color || '').toLowerCase();
				const isElevatedStopbar = obj.type === 'stopbar' && point.properties?.elevated === true;
				const lightStateId = this.mapLightStateId(
					obj.properties.directionality === 'bi-directional' ? 'both' : 'right',
					lightColor,
					isElevatedStopbar,
				);
				const offStateId = this.mapOffLightStateId(
					obj.type,
					obj.properties.directionality === 'bi-directional' ? 'both' : 'right',
					lightColor,
					isElevatedStopbar,
				);
				const lightStateAttr = lightStateId !== undefined ? ` stateId="${lightStateId}"` : '';
				const offStateAttr = ` offStateId="${offStateId}"`;
				out.push(`\t\t<Light${lightStateAttr}${offStateAttr}>`);
				out.push(`\t\t\t<Position>${point.lat},${point.lon}</Position>`);
				out.push(`\t\t\t<Heading>${point.heading.toFixed(2)}</Heading>`);

				// Add point-specific properties if they exist and are needed
				if (point.properties) {
					// Only output properties if they differ from the object defaults and need to be included
					const needsPropertiesTag = this.lightsNeedsPropertiesTag(point, props, obj.type);

					if (needsPropertiesTag) {
						const lightPropsLines: string[] = [];
						if (point.properties.color && point.properties.color !== props.color) {
							lightPropsLines.push(`\t\t\t\t<Color>${point.properties.color}</Color>`);
						}
						if (point.properties.ihp === true && obj.type === 'stopbar' && point.properties.color === 'yellow') {
							lightPropsLines.push(`\t\t\t\t<IHP>${point.properties.ihp}</IHP>`);
						}
						if (point.properties.elevated === true) {
							lightPropsLines.push(`\t\t\t\t<Elevated>true</Elevated>`);
						}
						// orientation removed

						if (lightPropsLines.length > 0) {
							out.push('\t\t\t<Properties>');
							for (const line of lightPropsLines) out.push(line);
							out.push('\t\t\t</Properties>');
						}
					}
				}

				out.push('\t\t</Light>');
			}

			out.push('\t</BarsObject>');
		}

		out.push('</BarsLights>');

		return out.join('\n');
	}

	/**
	 * Map an OFF state for a light. Default is 0 for all lights.
	 * Special handling for lead-on lights so that the lead-off side remains lit when "off":
	 *  - mixed yellow-green (any order) -> uni yellow (3)
	 *  - pure green -> uni green (2)
	 *  - elevated stopbars -> 7; all others -> 0 (off)
	 */
	private mapOffLightStateId(
		objectType: string,
		orientation: 'left' | 'right' | 'both',
		rawColor: string,
		elevatedStopbar?: boolean,
	): number {
		if (elevatedStopbar) return 7;
		if (!rawColor) return 0;

		if (objectType === 'leadon' || objectType === 'lead_on') {
			const normalized = rawColor
				.toLowerCase()
				.split('-')
				.map((seg) => seg.replace(/uni$/i, ''))
				.join('-')
				.replace(/--+/g, '-');

			if (/(green-yellow|yellow-green)/.test(normalized)) return 3;
			if (normalized === 'green') return 2;
		}

		// Default for all other cases
		return 0;
	}
	/**
	 * Map a processed BARS object to a light stateId used by pilot client.
	 * Mapping provided:
	 * Uni (orientation !== 'both'):
	 *  red=1, green=2, yellow=3, blue=4, orange=5
	 * Bi (orientation === 'both') same color both dirs:
	 *  red=20, green=21, yellow=22, blue=23, orange=24
	 * Bi mixed (Dir2 green, Dir1 other):
	 *  green-yellow=25, green-blue=26, green-orange=27
	 */
	private mapLightStateId(orientation: 'left' | 'right' | 'both', rawColor: string, elevatedStopbar?: boolean): number | undefined {
		// Elevated stopbar special state
		if (elevatedStopbar) return 6;
		if (!rawColor) return undefined;
		// Normalize color string(s)
		const color = rawColor.toLowerCase();
		// For mapping, strip trailing -uni markers on entire string and on segments
		const normalized = color
			.split('-')
			.map((seg) => seg.replace(/uni$/i, ''))
			.join('-')
			.replace(/--+/g, '-');

		if (orientation === 'both') {
			// Mixed combos first (order-insensitive)
			if (/(green-yellow|yellow-green)/.test(normalized)) return 25;
			if (/(green-blue|blue-green)/.test(normalized)) return 26;
			if (/(green-orange|orange-green)/.test(normalized)) return 27;
			// Same color both directions
			switch (normalized) {
				case 'red':
					return 20;
				case 'green':
					return 21;
				case 'yellow':
					return 22;
				case 'blue':
					return 23;
				case 'orange':
					return 24;
			}
			return undefined;
		}

		// Uni-directional: take first segment (after normalization)
		const base = normalized.split('-')[0];
		switch (base) {
			case 'red':
				return 1;
			case 'green':
				return 2;
			case 'yellow':
				return 3;
			case 'blue':
				return 4;
			case 'orange':
				return 5;
			default:
				return undefined;
		}
	}
	/**
	 * Helper method to determine if a light needs properties in its XML output
	 */
	private lightsNeedsPropertiesTag(point: BarsLightPoint, objectProps: LightProperties, objectType: string): boolean {
		const props = point.properties;
		if (!props) return false;

		// Check if color differs from object default
		const hasDifferentColor = Boolean(props.color && props.color !== objectProps.color);

		// Check if elevated status needs inclusion
		const needsElevated =
			props.elevated === true || (props.elevated !== undefined && objectType !== 'stand' && props.elevated !== objectProps.elevated);

		// Check if IHP property needs inclusion (differs from object default)
		const needsIhp = props.ihp !== undefined && props.ihp !== objectProps.ihp;

		return hasDifferentColor || needsElevated || needsIhp;
	}
	/**
	 * Process an input XML file and generate BARS light locations XML
	 * @param inputXml The XML content to process
	 * @param icao Optional ICAO code of the airport to validate point proximity
	 */
	async processBarsXML(inputXml: string, icao?: string): Promise<string> {
		try {
			// Parse BARS polygons from input XML
			const polygons = this.parseBarsPolygonsFromXML(inputXml);

			if (polygons.length === 0) {
				throw new Error('No BARS polygons found in input XML');
			}

			// If ICAO is provided, validate that at least one point is within 10km of the airport
			if (icao) {
				const airportData = await this.airportService.getAirport(icao);

				if (!airportData) {
					throw new Error(`Airport with ICAO ${icao} not found`);
				}
				// Check if latitude and longitude properties exist on airportData
				if ('latitude' in airportData && 'longitude' in airportData) {
					const airportLat = airportData.latitude;
					const airportLon = airportData.longitude;

					if (typeof airportLat === 'number' && typeof airportLon === 'number') {
						let hasNearbyPoint = false;

						for (const polygon of polygons) {
							for (const point of polygon.points) {
								const distance = calculateDistance(
									{ lat: airportLat, lon: airportLon },
									{ lat: point.lat, lon: point.lon },
								);

								if (distance <= 10000) {
									hasNearbyPoint = true;
									break;
								}
							}
							if (hasNearbyPoint) break;
						}

						if (!hasNearbyPoint) {
							throw new Error(
								'No BARS points found within 10km of the airport. Please ensure your XML contains points near the specified airport.',
							);
						}
					}
				}
			}

			// Process each polygon to generate BARS light locations
			const processedObjects: ProcessedBarsObject[] = [];

			for (const polygon of polygons) {
				// Extract BARS ID from the displayName (format: "BARS_XXXX")
				const barsId = polygon.id.replace('BARS_', '');

				// Look up the BARS ID in the database
				const dbRecord = await this.getBarsRecordFromDB(barsId);
				if (!dbRecord) {
					continue;
				}

				// Process the polygon based on its type
				const processedObject = await processBarsPolygon(polygon, dbRecord);

				if (processedObject) {
					processedObjects.push(processedObject);
				}
			}

			if (processedObjects.length === 0) {
				throw new Error('No valid BARS objects found after processing');
			}

			// Apply point deduplication to merge taxiway points that are very close together
			// This prevents overlapping lights where taxiway segments join
			const deduplicatedObjects = deduplicateTaxiwayPoints(processedObjects);

			// Generate BARS XML with light locations using the deduplicated points
			return this.generateBarsLightsXML(deduplicatedObjects);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			throw new Error(`Failed to generate BARS lights XML: ${errorMessage}`);
		}
	}

	/**
	 * Legacy method for backwards compatibility
	 * @deprecated Use processBarsXML instead
	 */
	async generateBarsXML(polygons: BarsPolygon[]): Promise<string> {
		if (polygons.length === 0) {
			throw new Error('No BARS polygons found in input XML');
		}

		let xml = '<?xml version="1.0" encoding="utf-8"?>\n<Bars>\n';

		// Add each polygon as an Object
		for (const polygon of polygons) {
			xml += '\t<Object>\n';
			xml += `\t\t<ID>${polygon.id}</ID>\n`;

			// Add each point
			for (const point of polygon.points) {
				xml += `\t\t<Point>${point.lat},${point.lon}</Point>\n`;
			}

			xml += '\t</Object>\n';
		}

		xml += '</Bars>';

		return xml;
	}
}
