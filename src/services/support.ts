import { AirportService } from './airport';
import { buildRemovalArtifacts, calculateAirportTestRadius, parseRemovalPolygons } from './msfs-removals';

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

export class SupportService {
	private airportService: AirportService;
	private readonly EARTH_RADIUS = 6378137; // Earth radius in meters at equator
	private readonly cosLatCache = new Map<number, number>();
	private readonly metersToDegreesBase: number;

	constructor(private db: D1Database) {
		this.metersToDegreesBase = 180 / (this.EARTH_RADIUS * Math.PI);
		// Pass the required API token parameter
		this.airportService = new AirportService(db, process.env.AIRPORTDB_API_KEY || '');
	}

	private getCosineLatitude(lat: number): number {
		const precisionKey = Math.round(lat * 1e6);
		const cached = this.cosLatCache.get(precisionKey);
		if (cached !== undefined) {
			return cached;
		}
		const value = Math.cos((lat * Math.PI) / 180);
		this.cosLatCache.set(precisionKey, value);
		return value;
	}

	private metersToDegreesLonFromCos(meters: number, cosLat: number): number {
		return (meters * this.metersToDegreesBase) / cosLat;
	}

	private metersToDegreesLon(meters: number, lat: number): number {
		return this.metersToDegreesLonFromCos(meters, this.getCosineLatitude(lat));
	}

	/**
	 * Parses polygons from XML content that have displayName="remove"
	 */
	parsePolygonsFromXML(xmlContent: string): Polygon[] {
		return parseRemovalPolygons(xmlContent);
	}

	/**
	 * Calculates light supports for a polygon, maximizes coverage first, then minimizes count.
	 */
	private calculateLightSupports(polygon: Polygon): LightSupport[] {
		const EPS = 1e-12;
		const vertices = polygon.vertices;
		const vertexCount = vertices.length;
		if (!vertexCount) {
			return [];
		}

		// Precompute polygon data for point-in-polygon checks.
		const xs = new Float64Array(vertexCount);
		const ys = new Float64Array(vertexCount);
		const edgeDx = new Float64Array(vertexCount);
		const edgeDy = new Float64Array(vertexCount);
		const edgeInvDy = new Float64Array(vertexCount);
		for (let i = 0; i < vertexCount; i++) {
			const v = vertices[i];
			xs[i] = v.lon;
			ys[i] = v.lat;
		}
		for (let i = 0; i < vertexCount; i++) {
			const next = i + 1 === vertexCount ? 0 : i + 1;
			const dx = xs[next] - xs[i];
			const dy = ys[next] - ys[i];
			edgeDx[i] = dx;
			edgeDy[i] = dy;
			edgeInvDy[i] = dy !== 0 ? 1 / dy : 0;
		}

		const onSeg = (lat: number, lon: number, ax: number, ay: number, bx: number, by: number): boolean => {
			const cross = (bx - ax) * (lat - ay) - (by - ay) * (lon - ax);
			if (Math.abs(cross) > EPS) return false;
			const minx = Math.min(ax, bx) - EPS,
				maxx = Math.max(ax, bx) + EPS;
			const miny = Math.min(ay, by) - EPS,
				maxy = Math.max(ay, by) + EPS;
			return lon >= minx && lon <= maxx && lat >= miny && lat <= maxy;
		};

		const pointInPoly = (lat: number, lon: number): boolean => {
			for (let i = 0; i < vertexCount; i++) {
				const next = i + 1 === vertexCount ? 0 : i + 1;
				if (onSeg(lat, lon, xs[i], ys[i], xs[next], ys[next])) {
					return true;
				}
			}
			let inside = false;
			for (let i = 0; i < vertexCount; i++) {
				const yi = ys[i];
				const yj = yi + edgeDy[i];
				if (yi > lat !== yj > lat) {
					const xi = xs[i];
					const candidateLon = xi + edgeDx[i] * (lat - yi) * edgeInvDy[i];
					if (lon < candidateLon) {
						inside = !inside;
					}
				}
			}
			return inside;
		};

		let minLat = ys[0],
			minLon = xs[0],
			maxLat = ys[0],
			maxLon = xs[0];
		for (let i = 1; i < vertexCount; i++) {
			const lat = ys[i];
			const lon = xs[i];
			if (lat < minLat) minLat = lat;
			if (lon < minLon) minLon = lon;
			if (lat > maxLat) maxLat = lat;
			if (lon > maxLon) maxLon = lon;
		}

		const gridM = 1;
		const midLat = (minLat + maxLat) * 0.5;
		const midLatCos = this.getCosineLatitude(midLat);
		const degPerMeterLat = this.metersToDegreesBase;
		const degPerMeterLonMid = this.metersToDegreesBase / midLatCos;
		const dLat = gridM * degPerMeterLat;
		const dLon = gridM * degPerMeterLonMid;

		// pad by half a cell so edges get sampled
		minLat -= 0.5 * dLat;
		minLon -= 0.5 * dLon;
		maxLat += 0.5 * dLat;
		maxLon += 0.5 * dLon;

		const rows = Math.max(1, Math.ceil((maxLat - minLat) / dLat));
		const cols = Math.max(1, Math.ceil((maxLon - minLon) / dLon));

		// inside mask at cell centers
		const inside: Uint8Array[] = Array.from({ length: rows }, () => new Uint8Array(cols));
		for (let i = 0; i < rows; i++) {
			const latC = minLat + (i + 0.5) * dLat;
			for (let j = 0; j < cols; j++) {
				const lonC = minLon + (j + 0.5) * dLon;
				inside[i][j] = pointInPoly(latC, lonC) ? 1 : 0;
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
			const i1 = i0 + h,
				j1 = j0 + w;
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
			const latCenter = sw.latC + meters * degPerMeterLat * 0.5;
			const lonCenter = sw.lonC + meters * degPerMeterLonMid * 0.5;
			out.push({ latitude: latCenter, longitude: lonCenter, width: meters, length: meters, heading: 0 });
		};

		const supports: LightSupport[] = [];
		const covered: Uint8Array[] = Array.from({ length: rows }, () => new Uint8Array(cols));
		const scratch: Uint8Array[] = Array.from({ length: rows }, () => new Uint8Array(cols));
		const candidateCache = new Map<number, Array<{ i0: number; j0: number }>>();

		// allowed sizes in meters, big to small
		const sizes = [12, 8, 5, 4, 3, 2, 1];

		// compute a simple score, coverage minus a penalty per placed square
		const scoreOf = (covCells: number, count: number) => {
			// penalty balances toward fewer larger tiles, tweakable
			const penalty = 0.35; // cells per tile
			return covCells - penalty * count;
		};

		const getCandidatesForSize = (s: number) => {
			let cached = candidateCache.get(s);
			if (!cached) {
				const list: Array<{ i0: number; j0: number }> = [];
				for (let i0 = 0; i0 + s <= rows; i0++) {
					for (let j0 = 0; j0 + s <= cols; j0++) {
						if (sumRect(i0, j0, s, s) === s * s) {
							list.push({ i0, j0 });
						}
					}
				}
				candidateCache.set(s, list);
				cached = list;
			}
			return cached;
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

		const markBlock = (grid: Uint8Array[], i0: number, j0: number, s: number) => {
			for (let i = i0; i < i0 + s; i++) {
				for (let j = j0; j < j0 + s; j++) {
					grid[i][j] = 1;
				}
			}
		};

		// Greedy placement for a fixed size and fixed phase offsets, returns placements and coverage gain
		const placeForSizePhase = (
			s: number,
			offI: number,
			offJ: number,
			covIn: Uint8Array[],
			baseCandidates: Array<{ i0: number; j0: number }>,
		) => {
			for (let i = 0; i < rows; i++) {
				scratch[i].set(covIn[i]);
			}

			const candidates: Array<{ i0: number; j0: number }> = [];
			for (const candidate of baseCandidates) {
				if (candidate.i0 < offI || candidate.j0 < offJ) {
					continue;
				}
				candidates.push(candidate);
			}

			const placed: Array<{ i0: number; j0: number }> = [];
			let totalGain = 0;

			while (true) {
				let bestIdx = -1;
				let bestGain = 0;
				for (let idx = 0; idx < candidates.length; idx++) {
					const { i0, j0 } = candidates[idx];
					const g = gainAt(i0, j0, s, scratch);
					if (g > bestGain) {
						bestGain = g;
						bestIdx = idx;
					}
				}
				if (bestIdx < 0 || bestGain === 0) {
					break;
				}

				const { i0, j0 } = candidates[bestIdx];
				markBlock(scratch, i0, j0, s);
				placed.push({ i0, j0 });
				totalGain += bestGain;

				for (let k = candidates.length - 1; k >= 0; k--) {
					const c = candidates[k];
					if (c.i0 < i0 + s && c.i0 + s > i0 && c.j0 < j0 + s && c.j0 + s > j0) {
						if (gainAt(c.i0, c.j0, s, scratch) === 0) {
							candidates.splice(k, 1);
						}
					}
				}
			}

			return {
				placed,
				newlyCovered: totalGain,
				score: scoreOf(totalGain, placed.length),
			};
		};

		// Multi phase per size, try a small set of offsets to break aliasing with the boundary
		const phaseSet = (s: number) => {
			// try four phases, 0, floor(s/2), and two quarter positions, keeps compute modest
			const p = new Set<number>([0, Math.floor(s / 2), Math.floor(s / 4), Math.floor((3 * s) / 4)]);
			// clamp into range
			return Array.from(p).map((v) => Math.min(Math.max(v, 0), Math.max(s - 1, 0)));
		};

		// main loop, largest to smallest
		for (const sizeM of sizes) {
			const s = sizeM; // 1 m per cell, so s cells
			if (s > rows || s > cols) continue;

			const baseCandidates = getCandidatesForSize(s);
			if (baseCandidates.length === 0) continue;

			const offsI = phaseSet(s);
			const offsJ = phaseSet(s);

			let best: null | { placed: Array<{ i0: number; j0: number }>; score: number } = null;

			for (const oi of offsI) {
				for (const oj of offsJ) {
					const trial = placeForSizePhase(s, oi, oj, covered, baseCandidates);
					if (!trial.placed.length) continue;
					if (!best || trial.score > best.score) {
						best = { placed: trial.placed.slice(), score: trial.score };
					}
				}
			}

			if (best && best.placed.length) {
				for (const placement of best.placed) {
					markBlock(covered, placement.i0, placement.j0, s);
					pushSupportFromBlock(placement.i0, placement.j0, s, supports);
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
							if (!covered[i][j]) {
								allCovered = false;
								break;
							}
						}
					}
					if (!allCovered) continue;

					// unmark the area and re mark with the larger block, and adjust supports list
					// to keep it simple, we will remove any supports that lie wholly inside the big window,
					// then add a single big support
					const latMinDeg = minLat + i0 * dLat;
					const lonMinDeg = minLon + j0 * dLon;
					const latMaxDeg = minLat + (i0 + big) * dLat;
					const lonMaxDeg = minLon + (j0 + big) * dLon;

					const beforeCount = supports.length;
					const kept: LightSupport[] = [];
					for (const spt of supports) {
						// compute if the rectangle is inside this big window in degrees
						const halfW = spt.width * degPerMeterLat * 0.5;
						const halfL = spt.length * degPerMeterLonMid * 0.5;
						const lat0 = spt.latitude - halfW,
							lat1 = spt.latitude + halfW;
						const lon0 = spt.longitude - halfL,
							lon1 = spt.longitude + halfL;
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
					const latCenter = sw.latC + meters * degPerMeterLat * 0.5;
					const lonCenter = sw.lonC + meters * degPerMeterLonMid * 0.5;

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
		if (!/^\s*<\?xml\b/i.test(xmlContent)) {
			throw new Error('Invalid XML: Missing XML declaration');
		}

		if (!/<FSData\b/i.test(xmlContent)) {
			throw new Error('Invalid XML: Missing FSData root element');
		}

		if (/<!(?:ENTITY|DOCTYPE|ELEMENT)\b/i.test(xmlContent)) {
			throw new Error('Invalid XML: External entities are not allowed');
		}

		const hasRemovePolygon = /<Polygon\b[^>]*displayName\s*=\s*(["'])remove\1[^>]*>/i.test(xmlContent);
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
			this.validateXMLContent(inputXml);
			const airportData = await this.airportService.getAirport(icao);
			if (!airportData) throw new Error(`Airport with ICAO ${icao} not found`);
			const polygons = parseRemovalPolygons(inputXml);
			if (polygons.length === 0) throw new Error('No valid remove polygons found in input XML');
			const { supports, exclusions } = buildRemovalArtifacts(polygons);
			const airportLatitude = Number(airportData.latitude) || 0;
			const airportLongitude = Number(airportData.longitude) || 0;
			const airportTestRadius = calculateAirportTestRadius({ lat: airportLatitude, lon: airportLongitude }, supports, exclusions);
			let xml = '<?xml version="1.0"?>\n<FSData version="9.0">\n';
			xml += `\t<Airport displayName="BARS ${icao}" groupIndex="1" groupID="2" name="BARS ${icao}" ident="${icao}" lat="${airportLatitude}" lon="${airportLongitude}" alt="0.00000000000000" magvar="0.000000" trafficScalar="1.000000" airportTestRadius="${airportTestRadius.toFixed(6)}" applyFlatten="FALSE" isOnTIN="FALSE" tinColorCorrection="FALSE" closed="FALSE">\n`;
			for (const [index, support] of supports.entries()) {
				xml += `\t\t<LightSupport displayName="BARS-${index + 1}" parentGroupID="2" groupIndex="1" latitude="${support.latitude}" longitude="${support.longitude}" altitude="${support.altitude}" altitude2="${support.altitude}" heading="${support.heading}" width="${support.width}" length="${support.length}" excludeLights="TRUE" excludeLightObjects="TRUE"/>\n`;
			}
			xml += '\t\t<Aprons/>\n\t\t<PaintedElements/>\n\t\t<ApronEdgeLights/>\n\t</Airport>\n';
			for (const exclusion of exclusions) {
				xml += `\t<ExclusionRectangle latitudeMinimum="${exclusion.latitudeMinimum}" latitudeMaximum="${exclusion.latitudeMaximum}" longitudeMinimum="${exclusion.longitudeMinimum}" longitudeMaximum="${exclusion.longitudeMaximum}"${exclusion.flags.excludeLibraryObjects ? ' excludeLibraryObjects="TRUE"' : ''}${exclusion.flags.excludeVFX ? ' excludeVFX="TRUE"' : ''}${exclusion.flags.excludeSimPropContainers ? ' excludeSimPropContainer="TRUE"' : ''}/>\n`;
			}
			return `${xml}</FSData>`;
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			throw new Error(`Failed to generate light supports: ${errorMessage}`);
		}
	}
}
