import { D1Database } from '@cloudflare/workers-types';
import { StatsService } from './stats';
import { AirportService } from './airport';
import { processBarsPolygon, deduplicateTaxiwayPoints } from './bars/handlers';
import { BarsPolygon, BarsDBRecord, ProcessedBarsObject, BarsLightPoint, LightProperties } from './bars/types';
import { calculateDistance } from './bars/geoUtils';

export class PolygonService {
	private statsService?: StatsService;
	private airportService: AirportService;

	constructor(
		private db: D1Database,
		private airportApiKey?: string,
	) {
		this.statsService = new StatsService(db);
		this.airportService = new AirportService(db, airportApiKey || '');
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

			const statement = this.db
				.prepare(
					`
        SELECT id, type, airport_id, directionality, orientation, color, elevated, ihp, name, coordinates
        FROM points 
        WHERE id = ?
      `,
				)
				.bind(barsId);

			const result = await statement.first();

			if (!result) {
				return null;
			}

			return this.mapBarsRecordFromDb(result);
		} catch (error) {
			return null;
		}
	}
	/**
	 * Maps database result to BarsDBRecord
	 */
	private mapBarsRecordFromDb(dbResult: any): BarsDBRecord {
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

		// Get orientation (left, right, both)
		let orientation: 'left' | 'right' | 'both' = 'both';
		if (dbResult.orientation) {
			const orientationStr = dbResult.orientation.toLowerCase();
			if (orientationStr.includes('left')) {
				orientation = 'left';
			} else if (orientationStr.includes('right')) {
				orientation = 'right';
			}
		} else if (dbResult.directionality === 'uni-directional' || dbResult.directionality === 'uni_directional') {
			// Default to 'right' orientation for uni-directional without specified orientation
			orientation = 'right';
		}

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
			elevated: Boolean(dbResult.elevated),
			color,
			orientation,
			intensity: 1.0,
			directionality: dbResult.directionality, // Add directionality from database record
			ihp: Boolean(dbResult.ihp), // Add IHP (Intermediate Holding Point) flag
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
	private mapOrientation(orientation: string | null): 'left' | 'right' | 'both' {
		if (!orientation) return 'both';

		const lowerOrientation = orientation.toLowerCase();
		if (lowerOrientation.includes('left')) return 'left';
		if (lowerOrientation.includes('right')) return 'right';
		return 'both';
	} /**

  /**
   * Generates BARS light locations XML from processed objects
   */
	generateBarsLightsXML(processedObjects: ProcessedBarsObject[]): string {
		if (processedObjects.length === 0) {
			throw new Error('No BARS objects to generate XML');
		}

		let xml = '<?xml version="1.0" encoding="utf-8"?>\n<BarsLights>\n';

		// Add each object
		for (const obj of processedObjects) {
			xml += `\t<BarsObject id="${obj.id}" type="${obj.type}">\n`;

			// Add properties
			const props = obj.properties;
			xml += '\t\t<Properties>\n';
			if (props.color) xml += `\t\t\t<Color>${props.color}</Color>\n`;

			// Only include orientation property for stopbars
			if (props.orientation && obj.type === 'stopbar') {
				xml += `\t\t\t<Orientation>${props.orientation}</Orientation>\n`;
			}

			if (props.intensity !== undefined) xml += `\t\t\t<Intensity>${props.intensity}</Intensity>\n`;
			xml += '\t\t</Properties>\n';

			// Add light points
			for (const point of obj.points) {
				xml += '\t\t<Light>\n';
				xml += `\t\t\t<Position>${point.lat},${point.lon}</Position>\n`;
				xml += `\t\t\t<Heading>${point.heading.toFixed(2)}</Heading>\n`;

				// Add point-specific properties if they exist and are needed
				if (point.properties) {
					// Only output properties if they differ from the object defaults and need to be included
					const needsPropertiesTag = this.lightsNeedsPropertiesTag(point, props, obj.type);

					if (needsPropertiesTag) {
						xml += '\t\t\t<Properties>\n';

						// Include color if it differs from the object-level defaults
						if (point.properties.color && point.properties.color !== props.color) {
							xml += `\t\t\t\t<Color>${point.properties.color}</Color>\n`;
						}

						if (point.properties.ihp === true && obj.type === 'stopbar' && point.properties.color === 'yellow') {
							xml += `\t\t\t\t<IHP>${point.properties.ihp}</IHP>\n`;
						}

						// Only include elevated property when it's explicitly true
						if (point.properties.elevated === true) {
							xml += `\t\t\t\t<Elevated>true</Elevated>\n`;
						}

						// For orientation, only output for stopbar type
						if (
							point.properties.orientation &&
							obj.type === 'stopbar' &&
							// Don't include "both" for elevated stopbar lights
							!(point.properties.elevated === true && point.properties.orientation === 'both') &&
							// Only include if it differs from the object's orientation
							point.properties.orientation !== props.orientation
						) {
							xml += `\t\t\t\t<Orientation>${point.properties.orientation}</Orientation>\n`;
						}

						xml += '\t\t\t</Properties>\n';
					}
				}

				xml += '\t\t</Light>\n';
			}

			xml += '\t</BarsObject>\n';
		}

		xml += '</BarsLights>';

		// Track stats
		if (this.statsService) {
			this.statsService.incrementStat('bars_xml_generations');
		}

		return xml;
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

		// Check if orientation needs inclusion
		// For elevated stopbars with "both" orientation, don't include it
		const isElevatedStopbarWithBoth = objectType === 'stopbar' && props.elevated === true && props.orientation === 'both';

		const needsOrientation = Boolean(
			props.orientation &&
				!isElevatedStopbarWithBoth &&
				((objectType !== 'stand' && props.orientation !== objectProps.orientation) ||
					(objectType === 'stand' && props.orientation !== 'right')),
		);

		// Check if IHP property needs inclusion (differs from object default)
		const needsIhp = props.ihp !== undefined && props.ihp !== objectProps.ihp;

		return hasDifferentColor || needsElevated || needsOrientation || needsIhp;
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

					if (airportLat !== undefined && airportLon !== undefined) {
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

		// Track stats :P
		if (this.statsService) {
			this.statsService.incrementStat('bars_xml_generations');
		}

		return xml;
	}
}
