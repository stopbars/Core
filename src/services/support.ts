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
	 * Calculates light supports for a polygon, maximizes coverage first, then minimizes count.
	 */
	private calculateLightSupports(polygon: Polygon): LightSupport[] {
		const EPS = 1e-12;

		const onSeg = (p: PolygonVertex, a: PolygonVertex, b: PolygonVertex): boolean => {
			const cross = (b.lon - a.lon) * (p.lat - a.lat) - (b.lat - a.lat) * (p.lon - a.lon);
			if (Math.abs(cross) > 1e-12) return false;
			const minx = Math.min(a.lon, b.lon) - EPS, maxx = Math.max(a.lon, b.lon) + EPS;
			const miny = Math.min(a.lat, b.lat) - EPS, maxy = Math.max(a.lat, b.lat) + EPS;
			return p.lon >= minx && p.lon <= maxx && p.lat >= miny && p.lat <= maxy;
		};

		const pointInPoly = (pt: PolygonVertex, vs: PolygonVertex[]): boolean => {
			for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
				if (onSeg(pt, vs[j], vs[i])) return true;
			}
			let inside = false;
			for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
				const xi = vs[i].lon, yi = vs[i].lat;
				const xj = vs[j].lon, yj = vs[j].lat;
				const hit = (yi > pt.lat) !== (yj > pt.lat)
					&& pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi + 0.0) + xi;
				if (hit) inside = !inside;
			}
			return inside;
		};

		// bounds
		let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
		for (const v of polygon.vertices) {
			if (v.lat < minLat) minLat = v.lat;
			if (v.lon < minLon) minLon = v.lon;
			if (v.lat > maxLat) maxLat = v.lat;
			if (v.lon > maxLon) maxLon = v.lon;
		}

		const gridM = 1;
		const midLat = (minLat + maxLat) * 0.5;
		const dLat = this.metersToDegreesLat(gridM);
		const dLon = this.metersToDegreesLon(gridM, midLat);

		// pad by half a cell so edges get sampled
		minLat -= 0.5 * dLat; minLon -= 0.5 * dLon;
		maxLat += 0.5 * dLat; maxLon += 0.5 * dLon;

		const rows = Math.max(1, Math.ceil((maxLat - minLat) / dLat));
		const cols = Math.max(1, Math.ceil((maxLon - minLon) / dLon));

		// inside mask at cell centers
		const inside: Uint8Array[] = Array.from({ length: rows }, () => new Uint8Array(cols));
		for (let i = 0; i < rows; i++) {
			const latC = minLat + (i + 0.5) * dLat;
			for (let j = 0; j < cols; j++) {
				const lonC = minLon + (j + 0.5) * dLon;
				inside[i][j] = pointInPoly({ lat: latC, lon: lonC }, polygon.vertices) ? 1 : 0;
			}
		}

		// summed area table of inside
		const sat = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
		for (let i = 1; i <= rows; i++) {
			let run = 0;
			for (let j = 1; j <= cols; j++) {
				run += inside[i - 1][j - 1];
				sat[i][j] = sat[i - 1][j] + run;
			}
		}
		const sumRect = (i0: number, j0: number, h: number, w: number) => {
			const i1 = i0 + h, j1 = j0 + w;
			return sat[i1][j1] - sat[i0][j1] - sat[i1][j0] + sat[i0][j0];
		};

		// helpers for geodesy conversion
		const cellCenterToDeg = (i: number, j: number) => {
			const latC = minLat + (i + 0.5) * dLat;
			const lonC = minLon + (j + 0.5) * dLon;
			return { latC, lonC };
		};
		const pushSupportFromBlock = (i0: number, j0: number, s: number, out: LightSupport[]) => {
			const meters = s * gridM;
			const sw = cellCenterToDeg(i0, j0);
			const latCenter = sw.latC + this.metersToDegreesLat(meters) * 0.5;
			const lonCenter = sw.lonC + this.metersToDegreesLon(meters, midLat) * 0.5;
			out.push({ latitude: latCenter, longitude: lonCenter, width: meters, length: meters, heading: 0 });
		};

		// state
		const supports: LightSupport[] = [];
		const covered: Uint8Array[] = Array.from({ length: rows }, () => new Uint8Array(cols));

		// allowed sizes in meters, big to small
		const sizes = [12, 8, 5, 4, 3, 2, 1];

		// compute a simple score, coverage minus a penalty per placed square
		const scoreOf = (covCells: number, count: number) => {
			// penalty balances toward fewer larger tiles, tweakable
			const penalty = 0.35; // cells per tile
			return covCells - penalty * count;
		};

		// Compute newly covered cells if we place an s by s window at i0, j0
		const gainAt = (i0: number, j0: number, s: number, cov: Uint8Array[]) => {
			let g = 0;
			for (let i = i0; i < i0 + s; i++) {
				for (let j = j0; j < j0 + s; j++) {
					if (!cov[i][j]) g++;
				}
			}
			return g;
		};

		// Greedy placement for a fixed size and fixed phase offsets, returns placements and coverage gain
		const placeForSizePhase = (s: number, offI: number, offJ: number, covIn: Uint8Array[]) => {
			// work copies
			const cov = covIn.map(row => row.slice());
			const placed: Array<{ i0: number, j0: number }> = [];

			// limit candidate set to positions matching the phase, this reduces overlap and speeds selection
			const candidates: Array<{ i0: number, j0: number }> = [];
			for (let i0 = offI; i0 + s <= rows; i0++) {
				if ((i0 - offI) % 1 !== 0) continue;
				for (let j0 = offJ; j0 + s <= cols; j0++) {
					if ((j0 - offJ) % 1 !== 0) continue;
					if (sumRect(i0, j0, s, s) === s * s) candidates.push({ i0, j0 });
				}
			}

			// greedy loop
			while (true) {
				let bestIdx = -1;
				let bestGain = 0;
				for (let idx = 0; idx < candidates.length; idx++) {
					const { i0, j0 } = candidates[idx];
					// quick reject if any already covered equals s by s then gain cannot beat current best, still we need exact
					const g = gainAt(i0, j0, s, cov);
					if (g > bestGain) {
						bestGain = g;
						bestIdx = idx;
					}
				}
				if (bestIdx < 0 || bestGain === 0) break;

				const { i0, j0 } = candidates[bestIdx];
				// mark
				for (let i = i0; i < i0 + s; i++) {
					for (let j = j0; j < j0 + s; j++) {
						cov[i][j] = 1;
					}
				}
				placed.push({ i0, j0 });

				// optional pruning, drop any candidate that can no longer add anything
				// this keeps the loop quick on large masks
				for (let k = candidates.length - 1; k >= 0; k--) {
					const c = candidates[k];
					// fast overlap check, if rectangles overlap and candidate is now fully covered, remove it
					if (c.i0 < i0 + s && c.i0 + s > i0 && c.j0 < j0 + s && c.j0 + s > j0) {
						if (gainAt(c.i0, c.j0, s, cov) === 0) {
							candidates.splice(k, 1);
						}
					}
				}
			}

			// compute coverage and score contribution for this phase
			let newlyCovered = 0;
			for (let i = 0; i < rows; i++) {
				for (let j = 0; j < cols; j++) {
					if (!covIn[i][j] && cov[i][j]) newlyCovered++;
				}
			}
			const sc = scoreOf(newlyCovered, placed.length);
			return { cov, placed, newlyCovered, score: sc };
		};

		// Multi phase per size, try a small set of offsets to break aliasing with the boundary
		const phaseSet = (s: number) => {
			// try four phases, 0, floor(s/2), and two quarter positions, keeps compute modest
			const p = new Set<number>([0, Math.floor(s / 2), Math.floor(s / 4), Math.floor((3 * s) / 4)]);
			// clamp into range
			return Array.from(p).map(v => Math.min(Math.max(v, 0), Math.max(s - 1, 0)));
		};

		// main loop, largest to smallest
		for (const sizeM of sizes) {
			const s = sizeM; // 1 m per cell, so s cells
			if (s > rows || s > cols) continue;

			// quick skip if no fully inside window exists at this size
			let anyInside = false;
			for (let i0 = 0; i0 + s <= rows && !anyInside; i0++) {
				for (let j0 = 0; j0 + s <= cols; j0++) {
					if (sumRect(i0, j0, s, s) === s * s) { anyInside = true; break; }
				}
			}
			if (!anyInside) continue;

			const offsI = phaseSet(s);
			const offsJ = phaseSet(s);

			let best: null | { cov: Uint8Array[], placed: Array<{ i0: number, j0: number }>, score: number } = null;

			for (const oi of offsI) {
				for (const oj of offsJ) {
					const trial = placeForSizePhase(s, oi, oj, covered);
					if (!best || trial.score > best.score) {
						best = { cov: trial.cov, placed: trial.placed, score: trial.score };
					}
				}
			}

			if (best && best.placed.length) {
				// commit the best phase placements
				for (let i = 0; i < rows; i++) covered[i] = best.cov[i];

				for (const p of best.placed) {
					pushSupportFromBlock(p.i0, p.j0, s, supports);
				}
			}
		}

		// Merge pass, try to replace four s by s with one 2s by 2s, largest first
		for (const sizeM of sizes) {
			const s = sizeM;
			const big = s * 2;
			if (big > rows || big > cols) continue;

			// only attempt merges where a big window is fully inside
			for (let i0 = 0; i0 + big <= rows; i0++) {
				for (let j0 = 0; j0 + big <= cols; j0++) {
					if (sumRect(i0, j0, big, big) !== big * big) continue;

					// check if all cells are covered
					let allCovered = true;
					for (let i = i0; i < i0 + big && allCovered; i++) {
						for (let j = j0; j < j0 + big; j++) {
							if (!covered[i][j]) { allCovered = false; break; }
						}
					}
					if (!allCovered) continue;

					// unmark the area and re mark with the larger block, and adjust supports list
					// to keep it simple, we will remove any supports that lie wholly inside the big window,
					// then add a single big support
					const latMinDeg = minLat + (i0) * dLat;
					const lonMinDeg = minLon + (j0) * dLon;
					const latMaxDeg = minLat + (i0 + big) * dLat;
					const lonMaxDeg = minLon + (j0 + big) * dLon;

					const beforeCount = supports.length;
					const kept: LightSupport[] = [];
					for (const spt of supports) {
						// compute if the rectangle is inside this big window in degrees
						const halfW = this.metersToDegreesLat(spt.width / 2);
						const halfL = this.metersToDegreesLon(spt.length / 2, midLat);
						const lat0 = spt.latitude - halfW, lat1 = spt.latitude + halfW;
						const lon0 = spt.longitude - halfL, lon1 = spt.longitude + halfL;
						if (!(lat0 >= latMinDeg && lat1 <= latMaxDeg && lon0 >= lonMinDeg && lon1 <= lonMaxDeg)) {
							kept.push(spt);
						}
					}
					// if we did not remove at least four s by s, skip, we only want to merge true 2 by 2 packs
					if (beforeCount - kept.length < 4) {
						continue;
					}
					// mark covered again for the big block, though it was already fully covered, we keep the mask as is
					// place the big one
					const meters = big * gridM;
					const sw = cellCenterToDeg(i0, j0);
					const latCenter = sw.latC + this.metersToDegreesLat(meters) * 0.5;
					const lonCenter = sw.lonC + this.metersToDegreesLon(meters, midLat) * 0.5;

					kept.push({ latitude: latCenter, longitude: lonCenter, width: meters, length: meters, heading: 0 });
					supports.length = 0;
					supports.push(...kept);
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

				// Count intentionally unused for now; metrics removed
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
