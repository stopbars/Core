import { AirportService } from './airport';

interface PolygonVertex {
	lat: number;
	lon: number;
}

interface Polygon {
	id: string;
	vertices: PolygonVertex[];
	altitude?: number;
}

interface LightSupport {
	latitude: number;
	longitude: number;
	width: number;
	length: number;
	heading: number;
}

// Define an interface for airport data to help TypeScript
interface AirportData {
	latitude?: number;
	longitude?: number;
	icao?: string;
	name?: string;
	continent?: string;
	runways?: Record<string, unknown>[];
}

export class SupportService {
	private airportService: AirportService;
	private readonly EARTH_RADIUS = 6378137; // Earth radius in meters at equator

	constructor(private db: D1Database) {
		// Pass the required API token parameter
		this.airportService = new AirportService(db, process.env.AIRPORTDB_API_KEY || '');
	}

	private metersToDegreesLat(meters: number): number {
		return meters / ((this.EARTH_RADIUS * Math.PI) / 180);
	}

	private metersToDegreesLon(meters: number, lat: number): number {
		return meters / ((this.EARTH_RADIUS * Math.cos((lat * Math.PI) / 180) * Math.PI) / 180);
	}

	/**
	 * Parses polygons from XML content that have displayName="remove"
	 */
	parsePolygonsFromXML(xmlContent: string): Polygon[] {
		const polygons: Polygon[] = [];
		const regex = {
			polygon: /<Polygon([^>]*)>([\s\S]*?)<\/Polygon>/g,
			vertex: /<Vertex\s+lat="([^"]+)"\s+lon="([^"]+)"/g,
			altitude: /altitude="([^"]+)"/,
			displayName: /displayName="([^"]+)"/,
		};

		let polygonMatch;
		while ((polygonMatch = regex.polygon.exec(xmlContent)) !== null) {
			const polygonContent = polygonMatch[0];
			const polygonAttributes = polygonMatch[1];

			// Check if this polygon has displayName="remove" (case insensitive)
			const displayNameMatch = polygonAttributes.match(regex.displayName);
			if (!displayNameMatch || displayNameMatch[1].toLowerCase() !== 'remove') {
				continue; // Skip if not a remove polygon
			}

			const altitudeMatch = polygonAttributes.match(regex.altitude);
			const altitude = altitudeMatch ? parseFloat(altitudeMatch[1]) : 0;

			const vertices: PolygonVertex[] = [];
			let vertexMatch;
			while ((vertexMatch = regex.vertex.exec(polygonContent)) !== null) {
				vertices.push({
					lat: parseFloat(vertexMatch[1]),
					lon: parseFloat(vertexMatch[2]),
				});
			}

			if (vertices.length > 0) {
				polygons.push({
					id: crypto.randomUUID(),
					vertices,
					altitude,
				});
			}
		}

		return polygons;
	}

	/**
	 * Calculates light supports for a polygon
	 */
	private calculateLightSupports(polygon: Polygon): LightSupport[] {
		// Helper function to check if a point is inside polygon
		const isPointInPolygon = (point: PolygonVertex, polygonVertices: PolygonVertex[]): boolean => {
			let inside = false;
			for (let i = 0, j = polygonVertices.length - 1; i < polygonVertices.length; j = i++) {
				const xi = polygonVertices[i].lon,
					yi = polygonVertices[i].lat;
				const xj = polygonVertices[j].lon,
					yj = polygonVertices[j].lat;

				const intersect = yi > point.lat !== yj > point.lat && point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
				if (intersect) inside = !inside;
			}
			return inside;
		};

		// Get polygon bounds
		const getBounds = () => {
			let minLat = Infinity,
				minLon = Infinity;
			let maxLat = -Infinity,
				maxLon = -Infinity;

			for (const vertex of polygon.vertices) {
				minLat = Math.min(minLat, vertex.lat);
				minLon = Math.min(minLon, vertex.lon);
				maxLat = Math.max(maxLat, vertex.lat);
				maxLon = Math.max(maxLon, vertex.lon);
			}

			return { minLat, minLon, maxLat, maxLon };
		};

		// Grid cell class to track occupied spaces
		class GridCell {
			constructor(
				public size: number,
				public lat: number,
				public lon: number,
				public used: boolean = false,
			) { }
		}

		const bounds = getBounds();
		const grid: GridCell[][] = [];
		const gridSize = 1; // 1 meter base grid size

		// Calculate grid dimensions
		const latStep = this.metersToDegreesLat(gridSize);
		const lonStep = this.metersToDegreesLon(gridSize, (bounds.minLat + bounds.maxLat) / 2);

		const rows = Math.ceil((bounds.maxLat - bounds.minLat) / latStep);
		const cols = Math.ceil((bounds.maxLon - bounds.minLon) / lonStep);

		// Initialize grid
		for (let i = 0; i < rows; i++) {
			grid[i] = [];
			for (let j = 0; j < cols; j++) {
				const lat = bounds.minLat + i * latStep;
				const lon = bounds.minLon + j * lonStep;
				grid[i][j] = new GridCell(1, lat, lon);
			}
		}

		// Mark cells inside polygon
		for (let i = 0; i < rows; i++) {
			for (let j = 0; j < cols; j++) {
				const cell = grid[i][j];
				const point = { lat: cell.lat, lon: cell.lon };
				if (isPointInPolygon(point, polygon.vertices)) {
					cell.used = true;
				}
			}
		}

		// Helper to check if we can merge a square of cells
		const canMergeSquare = (startRow: number, startCol: number, size: number): boolean => {
			if (startRow + size > rows || startCol + size > cols) return false;

			for (let i = 0; i < size; i++) {
				for (let j = 0; j < size; j++) {
					if (!grid[startRow + i][startCol + j].used) return false;
				}
			}
			return true;
		};

		// Helper to mark cells as merged
		const markMerged = (startRow: number, startCol: number, size: number) => {
			for (let i = 0; i < size; i++) {
				for (let j = 0; j < size; j++) {
					grid[startRow + i][startCol + j].used = false;
				}
			}
		};

		const supports: LightSupport[] = [];
		const sizes = [12, 8, 5, 4, 3, 2, 1];

		for (const size of sizes) {
			for (let i = 0; i < rows; i += 1) {
				for (let j = 0; j < cols; j += 1) {
					if (canMergeSquare(i, j, size)) {
						const lat = bounds.minLat + i * latStep;
						const lon = bounds.minLon + j * lonStep;

						supports.push({
							latitude: lat + this.metersToDegreesLat(size) / 2,
							longitude: lon + this.metersToDegreesLon(size, lat) / 2,
							width: size,
							length: size,
							heading: 0,
						});

						markMerged(i, j, size);
					}
				}
			}
		}

		return supports;
	}
	/**
	 * Validates XML content before processing with protection against XXE attacks
	 */
	private validateXMLContent(xmlContent: string): boolean {
		// Basic XML validation
		if (!xmlContent.trim().startsWith('<?xml')) {
			throw new Error('Invalid XML: Missing XML declaration');
		}

		if (!xmlContent.includes('<FSData')) {
			throw new Error('Invalid XML: Missing FSData root element');
		}

		// Check for XXE attack patterns
		if (xmlContent.includes('<!ENTITY') || xmlContent.includes('<!DOCTYPE') || xmlContent.includes('<!ELEMENT')) {
			throw new Error('Invalid XML: External entities are not allowed');
		}

		// Check for at least one remove polygon
		const hasRemovePolygon = /<Polygon[^>]*displayName="remove"[^>]*>/i.test(xmlContent);
		if (!hasRemovePolygon) {
			throw new Error('No remove polygons found in XML');
		}

		return true;
	}

	/**
	 * Generates light supports XML from input XML containing polygons
	 */
	async generateLightSupportsXML(inputXml: string, icao: string): Promise<string> {
		try {
			// Validate XML content
			this.validateXMLContent(inputXml);

			// Get airport data to get coordinates
			const airportData = (await this.airportService.getAirport(icao)) as AirportData;
			if (!airportData) {
				throw new Error(`Airport with ICAO ${icao} not found`);
			}

			// Parse polygons from input XML
			const polygons = this.parsePolygonsFromXML(inputXml);

			if (polygons.length === 0) {
				throw new Error('No valid remove polygons found in input XML');
			}

			let xml = '<?xml version="1.0"?>\n<FSData version="9.0">\n';

			// Start airport tag with coordinates from airport data
			// Add explicit nullish coalescing to handle potentially undefined values
			xml += `\t<Airport displayName="BARS ${icao}" groupIndex="1" groupID="2" name="BARS ${icao}" ident="${icao}" lat="${airportData.latitude ?? 0}" lon="${airportData.longitude ?? 0}" alt="0.00000000000000" magvar="0.000000" trafficScalar="1.000000" airportTestRadius="5000.00000000000000" applyFlatten="FALSE" isOnTIN="FALSE" tinColorCorrection="FALSE" closed="FALSE">\n`;

			// Add light supports
			let supportCount = 1;
			let totalSupports = 0;
			let exclusionRectangles = ''; // Store exclusion rectangles separately

			// Helper function to calculate exclusion rectangle coordinates
			const calculateExclusionCoords = (center: { latitude: number; longitude: number }, width: number, length: number) => {
				// Add a small buffer (35%) to make exclusion rectangle slightly larger
				const bufferFactor = 1.35;
				const bufferedWidth = width * bufferFactor;
				const bufferedLength = length * bufferFactor;

				// Convert width/length from meters to degrees
				const halfWidthDeg = this.metersToDegreesLat(bufferedWidth / 2);
				const halfLengthDeg = this.metersToDegreesLon(bufferedLength / 2, center.latitude);

				return {
					latMin: center.latitude - halfWidthDeg,
					latMax: center.latitude + halfWidthDeg,
					lonMin: center.longitude - halfLengthDeg,
					lonMax: center.longitude + halfLengthDeg,
				};
			};

			// Process each polygon
			for (let i = 0; i < polygons.length; i++) {
				const polygon = polygons[i];

				// Get the supports for this polygon
				const supports = this.calculateLightSupports(polygon);

				// Add each support and store exclusion rectangle
				supports.forEach((support) => {
					// Add light support inside Airport tag
					xml += `\t\t<LightSupport displayName="BARS-${supportCount}" parentGroupID="2" groupIndex="1" latitude="${support.latitude}" longitude="${support.longitude}" altitude="${polygon.altitude || 0}" altitude2="${polygon.altitude || 0}" heading="${support.heading}" width="${support.width}" length="${support.length}" excludeLights="TRUE" excludeLightObjects="TRUE"/>\n`;

					// Calculate and store exclusion rectangle to add later outside Airport tag
					const exclusionCoords = calculateExclusionCoords(
						{ latitude: support.latitude, longitude: support.longitude },
						support.width,
						support.length,
					);

					exclusionRectangles += `\t<ExclusionRectangle latitudeMinimum="${exclusionCoords.latMin}" latitudeMaximum="${exclusionCoords.latMax}" longitudeMinimum="${exclusionCoords.lonMin}" longitudeMaximum="${exclusionCoords.lonMax}" excludeLibraryObjects="TRUE"/>\n`;

					supportCount++;
				});

				totalSupports += supports.length;
			}

			// Close airport tag
			xml += '\t\t<Aprons/>\n';
			xml += '\t\t<PaintedElements/>\n';
			xml += '\t\t<ApronEdgeLights/>\n';
			xml += '\t</Airport>\n';

			// Add exclusion rectangles after Airport tag
			xml += exclusionRectangles;

			// Close FSData
			xml += '</FSData>';

			// Stats tracking removed

			return xml;
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			throw new Error(`Failed to generate light supports: ${errorMessage}`);
		}
	}
}
