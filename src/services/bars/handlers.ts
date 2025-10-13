import { BarsDBRecord, BarsLightPoint, BarsPolygon, GeoPoint, ProcessedBarsObject } from './types';
import { calculateDestinationPoint, calculateHeading, generateEquidistantPoints, calculateDistance, smoothLine } from './geoUtils';

const STOPBAR_SPACING = 3;
const LEAD_ON_SPACING = 12;
const STAND_SPACING = 15;
const TAXIWAY_SPACING = 11.25;
const ELEVATED_LIGHT_INWARD_ANGLE = 140;
const ELEVATED_LIGHT_INWARD_OFFSET = 0.3;
const ELEVATED_LIGHT_DISTANCE = 1.5;

export abstract class BarsTypeHandler {
	abstract generateLightPoints(polygon: BarsPolygon, dbRecord: BarsDBRecord): BarsLightPoint[];

	// Keep for non-stopbar handlers that still need along-line adjustments.
	protected getHeadingAdjustmentForRightFacing(): number {
		return 180;
	}

	protected addHeadingToPoints(points: GeoPoint[], headingAdjustment: number = 0): BarsLightPoint[] {
		if (points.length < 2) return [];

		const result: BarsLightPoint[] = [];

		// Precompute segment headings to avoid repeated geodesic calculations
		const segmentHeadings: number[] = new Array(points.length - 1);
		for (let i = 0; i < points.length - 1; i++) {
			segmentHeadings[i] = calculateHeading(points[i], points[i + 1]);
		}

		for (let i = 0; i < points.length; i++) {
			let heading: number;

			if (i === 0) {
				heading = segmentHeadings[0];
			} else if (i === points.length - 1) {
				heading = segmentHeadings[points.length - 2];
			} else {
				const headingFrom = segmentHeadings[i - 1];
				const headingTo = segmentHeadings[i];

				const diff = Math.abs(headingFrom - headingTo);
				if (diff >= 180) {
					const adjustedHeadingTo = headingTo < headingFrom ? headingTo + 360 : headingTo;
					const adjustedHeadingFrom = headingFrom < headingTo ? headingFrom + 360 : headingFrom;
					heading = ((adjustedHeadingFrom + adjustedHeadingTo) / 2) % 360;
				} else {
					heading = (headingFrom + headingTo) / 2;
				}
			}

			heading = (heading + headingAdjustment) % 360;
			if (heading < 0) heading += 360;

			result.push({
				...points[i],
				heading,
			});
		}

		if (result.length >= 2) {
			result[0].heading = result[1].heading;
		}

		return result;
	}
}

/**
 * Handler for stopbar type BARS
 */
export class StopbarHandler extends BarsTypeHandler {
	generateLightPoints(polygon: BarsPolygon, dbRecord: BarsDBRecord): BarsLightPoint[] {
		const points = polygon.points;
		if (points.length < 2) return [];
		const lightPoints = generateEquidistantPoints(points, STOPBAR_SPACING);

		// First derive along-line headings without any adjustment
		const alongHeadings = this.addHeadingToPoints(lightPoints, 0);

		const isBiDirectional = dbRecord.directionality === 'bi-directional' || !dbRecord.directionality;

		const lightsWithHeading: BarsLightPoint[] = alongHeadings.map((p) => {
			const seg = ((p.heading % 360) + 360) % 360; // along-line heading
			const perpRight = (seg + 90) % 360; // geometrical right of line
			const perpLeft = (seg + 270) % 360; // geometrical left of line
			// uni -> face right edge always
			// bi  -> keep previous deterministic choice (south/west half) for stability
			let chosen: number;
			if (!isBiDirectional) {
				chosen = perpRight;
			} else {
				const candidateSouthWest = perpRight >= 180 ? perpRight : perpLeft >= 180 ? perpLeft : perpRight;
				chosen = candidateSouthWest;
			}
			return { ...p, heading: chosen };
		});

		// Add properties to base stopbar lights
		const lightsWithProperties: BarsLightPoint[] = lightsWithHeading.map(
			(light): BarsLightPoint => ({
				...light,
				properties: {
					type: 'stopbar',
					color: dbRecord.color || 'red',
					directionality: dbRecord.directionality || 'bi-directional',
					elevated: false,
					ihp: dbRecord.ihp,
				},
			}),
		);

		let allLights: BarsLightPoint[] = [...lightsWithProperties];

		// IHP lights (inherit chosen heading at center)
		if (dbRecord.ihp) {
			const ihpLights = this.generateIHPLights(lightPoints, lightsWithHeading, 0, dbRecord);
			allLights = [...allLights, ...ihpLights];
		}

		// Elevated lights (need baseline line direction). Compute baseline from first segment.
		if (dbRecord.elevated && lightPoints.length >= 2) {
			const baseLineHeading = calculateHeading(lightPoints[0], lightPoints[1]);
			const elevatedLights = this.generateElevatedLights(lightPoints, lightsWithHeading, baseLineHeading);
			allLights = [...allLights, ...elevatedLights];
		}

		return allLights;
	}

	/**
	 * Generate IHP (Intermediate Holding Point) lights
	 * These are 3 yellow lights spaced 1.4 meters apart arranged PARALLEL to the stopbar line
	 * The center light is aligned with the center of the stopbar
	 * The entire row is offset 0.4m to one side of the stopbar
	 */
	private generateIHPLights(
		points: GeoPoint[],
		lightsWithHeading: BarsLightPoint[],
		headingAdjustment: number,
		dbRecord: BarsDBRecord,
	): BarsLightPoint[] {
		if (points.length < 2 || lightsWithHeading.length < 2) return [];

		const ihpLights: BarsLightPoint[] = [];

		// Constants for IHP lights
		const IHP_LIGHT_SPACING = 1.4; // meters between IHP lights
		const IHP_LIGHT_OFFSET = 0.4;

		// Find the center point of the stopbar
		const centerIndex = Math.floor(points.length / 2);
		const centerPoint = points[centerIndex];

		// Use heading from the closest stopbar light
		const centerStopbarLight = lightsWithHeading[centerIndex];

		// The stopbar lights point perpendicular to the stopbar line
		// So the stopbar line direction is 90 degrees off from the light heading
		const stopbarLightHeading = centerStopbarLight.heading;
		const stopbarDirection = (stopbarLightHeading - 90) % 360;

		// Randomly decide which side of the stopbar to place the IHP lights
		// This creates variation in the appearance of IHPs across an airport
		const pointsHash = points.reduce((acc, p) => acc + p.lat + p.lon, 0);
		const placeOnRightSide = pointsHash % 2 === 0; // Random but deterministic decision

		// Direction to offset the IHP lights from the stopbar
		// Either 90 degrees clockwise or 90 degrees counterclockwise from stopbar direction
		const offsetDirection = placeOnRightSide ? (stopbarDirection + 90) % 360 : (stopbarDirection - 90) % 360;

		// Create the center IHP light
		// It's offset 0.7m from the center of the stopbar in the offset direction
		const centerIhpPoint = calculateDestinationPoint(centerPoint, IHP_LIGHT_OFFSET, offsetDirection);

		// Create left and right IHP lights
		// They are positioned ALONG THE STOPBAR DIRECTION (parallel to it)
		// Left IHP light (1.5m along stopbar direction)
		const leftIhpPoint = calculateDestinationPoint(centerIhpPoint, IHP_LIGHT_SPACING, stopbarDirection);

		// Right IHP light (1.5m in opposite direction along stopbar)
		const rightIhpPoint = calculateDestinationPoint(centerIhpPoint, IHP_LIGHT_SPACING, (stopbarDirection + 180) % 360);

		// Create the three IHP lights with inherited heading from stopbar
		[leftIhpPoint, centerIhpPoint, rightIhpPoint].forEach((point) => {
			ihpLights.push({
				...point,
				heading: centerStopbarLight.heading, // Same heading as the stopbar light
				properties: {
					type: 'stopbar',
					color: 'yellow', // IHP lights are always yellow
					directionality: dbRecord.directionality || 'bi-directional', // inherit
					elevated: false, // IHP lights are never elevated
					ihp: true, // Mark as IHP light
				},
			});
		});

		return ihpLights;
	}

	/**
	 * Generate elevated lights at the ends of a stopbar
	 */
	private generateElevatedLights(points: GeoPoint[], lightsWithHeading: BarsLightPoint[], baseLineHeading: number): BarsLightPoint[] {
		if (points.length < 2 || lightsWithHeading.length < 2) return [];

		const elevatedLights: BarsLightPoint[] = [];

		// Get the first and last lights with their headings already calculated
		const firstLight = lightsWithHeading[0];
		const lastLight = lightsWithHeading[lightsWithHeading.length - 1];

		// baseLineHeading provided (direction along the stopbar line)

		// Step 1: Calculate the extension points - placing them exactly 1 meter beyond each end of the stopbar
		// First point - elevated light placed exactly 1 meter BEFORE the first light (extending the line)
		const startElevatedPoint = calculateDestinationPoint(
			firstLight,
			ELEVATED_LIGHT_DISTANCE,
			(baseLineHeading - 180) % 360, // Opposite direction of the stopbar line
		);

		// Last point - elevated light placed exactly 1 meter AFTER the last light (extending the line)
		const endElevatedPoint = calculateDestinationPoint(
			lastLight,
			ELEVATED_LIGHT_DISTANCE,
			baseLineHeading, // Same direction as the stopbar line
		);

		// Step 2: Move the lights inward by the defined inward offset (0.3 meters)
		const startInwardPoint = calculateDestinationPoint(
			startElevatedPoint,
			ELEVATED_LIGHT_INWARD_OFFSET,
			(baseLineHeading - 90 + 360) % 360, // perpendicular to the other side
		);

		const endInwardPoint = calculateDestinationPoint(
			endElevatedPoint,
			ELEVATED_LIGHT_INWARD_OFFSET,
			(baseLineHeading - 90 + 360) % 360,
		);
		const firstElevatedHeading = (baseLineHeading - ELEVATED_LIGHT_INWARD_ANGLE + 180 + 90) % 360;
		const lastElevatedHeading = (baseLineHeading - ELEVATED_LIGHT_INWARD_ANGLE + 180) % 360;

		// Add the elevated lights with correct positions and inward headings
		elevatedLights.push({
			...startInwardPoint,
			heading: firstElevatedHeading,
			properties: {
				type: 'stopbar',
				color: 'red',
				elevated: true,
				directionality: 'uni-directional',
			},
		});

		elevatedLights.push({
			...endInwardPoint,
			heading: lastElevatedHeading,
			properties: {
				type: 'stopbar',
				color: 'red',
				elevated: true,
				directionality: 'uni-directional',
			},
		});

		return elevatedLights;
	}
}

/**
 * Handler for lead_on type BARS
 */
export class Lead_onHandler extends BarsTypeHandler {
	generateLightPoints(polygon: BarsPolygon, dbRecord: BarsDBRecord): BarsLightPoint[] {
		const points = polygon.points;
		if (points.length < 2) return [];

		// Generate points along the line with 12-meter spacing
		const lightPoints = generateEquidistantPoints(points, LEAD_ON_SPACING);

		const lightsWithHeading = this.addHeadingToPoints(lightPoints);

		// Add properties to lights, alternating between yellow and yellow-green-uni types
		return lightsWithHeading.map((light, index): BarsLightPoint => {
			// Every second light is Yellow-Green-Uni
			const isYellowGreenUni = index % 2 === 1;

			return {
				...light,
				properties: {
					type: 'lead_on',
					color: isYellowGreenUni ? 'yellow-green-uni' : 'green',
					directionality: isYellowGreenUni ? 'bi-directional' : dbRecord.directionality || 'bi-directional',
					elevated: false,
				},
			};
		});
	}
}

/**
 * Handler for taxiway type BARS
 */
export class TaxiwayHandler extends BarsTypeHandler {
	generateLightPoints(polygon: BarsPolygon, dbRecord: BarsDBRecord): BarsLightPoint[] {
		const points = polygon.points;
		if (points.length < 2) return [];

		// First smooth the line to create more natural curves
		const smoothedPoints = smoothLine(points);

		// Generate points along the smoothed line with proper spacing
		const lightPoints = generateEquidistantPoints(smoothedPoints, TAXIWAY_SPACING);

		// Determine if we're in the southern hemisphere by checking the first point's latitude
		const isInSouthernHemisphere = points[0].lat < 0;

		// Check directionality
		const isUniDirectional = dbRecord.directionality === 'uni-directional';

		// Calculate heading for each light - account for hemisphere differences for uni-directional taxiways
		// For uni-directional taxiways, use right orientation like lead_on lights
		let headingAdjustment = 0;

		// For uni-directional taxiways, handle like lead_on/stand lights with hemisphere adjustment
		if (isUniDirectional && isInSouthernHemisphere) {
			headingAdjustment = (headingAdjustment + 180) % 360;
		}

		const lightsWithHeading = this.addHeadingToPoints(lightPoints, headingAdjustment);

		// Add properties to lights based on taxiway color and directionality
		return lightsWithHeading.map((light, index): BarsLightPoint => {
			// Get the base color, default to green if not specified
			const colorValue = dbRecord.color || 'green';
			// Handle hyphenated colors (green-yellow, green-blue, green-orange)
			const isHyphenatedColor = colorValue.includes('-');
			let finalColor = colorValue;

			// Handle different directionality types - ensure we have proper null checking
			const isBiDirectional = !dbRecord.directionality || dbRecord.directionality === 'bi-directional';

			// Special handling for hyphenated colors
			if (isHyphenatedColor) {
				const colors = colorValue.split('-');
				const primaryColor = colors[0]; // green
				const secondaryColor = colors[1]; // yellow, blue, or orange
				// Handle alternating colors based on directionality
				if (isBiDirectional) {
					// For bi-directional, every 2nd light in both directions is the secondary color
					finalColor = index % 2 === 0 ? primaryColor : secondaryColor;
				} else {
					// For uni-directional, use the special "color-uni" format for alternating colors
					if (index % 2 === 0) {
						finalColor = `${primaryColor}-uni`;
					} else {
						// Add "-uni" suffix to the secondary color for uni-directional segments
						finalColor = `${secondaryColor}-uni`;
					}
				}
			} else {
				// Normal single color handling
				if (!isBiDirectional) {
					// For uni-directional with single color, add "-uni" suffix only to every second light
					if (index % 2 === 0) {
						finalColor = `${finalColor}-uni`;
					}
					// Keep the base color for alternating lights
				}
				// Otherwise keep default orientation
			}

			return {
				...light,
				properties: {
					type: 'taxiway',
					color: finalColor,
					directionality: isUniDirectional ? 'uni-directional' : 'bi-directional',
					elevated: false,
				},
			};
		});
	}
}

/**
 * Handler for stand type BARS (stand lead-in lights)
 */
export class StandHandler extends BarsTypeHandler {
	generateLightPoints(polygon: BarsPolygon): BarsLightPoint[] {
		const points = polygon.points;
		if (points.length < 2) return [];

		// Generate points along the line with 15-meter spacing
		const lightPoints = generateEquidistantPoints(points, STAND_SPACING);

		// Calculate heading for each light based on the curve of the line
		// For stand lights, we want them facing the direction of travel (opposite of line direction)
		// Apply an adjustment to make them face the approach direction

		// Determine if we're in the southern hemisphere by checking the first point's latitude
		const isInSouthernHemisphere = points[0].lat < 0;

		// Calculate heading for each light - account for hemisphere differences
		let headingAdjustment = 0;

		// In the southern hemisphere, we need to add 180 degrees to correct the direction
		if (isInSouthernHemisphere) {
			headingAdjustment = (headingAdjustment + 180) % 360;
		}

		const lightsWithHeading = this.addHeadingToPoints(lightPoints, headingAdjustment);

		// All stand lead-in lights are amber (yellow)
		return lightsWithHeading.map((light): BarsLightPoint => {
			return {
				...light,
				properties: {
					type: 'stand',
					color: 'yellow', // Stand lead-in lights are amber
					directionality: 'uni-directional', // Uni-directional facing the start of the line
					elevated: false,
				},
			};
		});
	}
}

/**
 * Factory class to create the appropriate handler for a BARS type
 */
export class BarsHandlerFactory {
	static getHandler(type: string): BarsTypeHandler {
		switch (type) {
			case 'stopbar':
				return new StopbarHandler();
			case 'lead_on':
				return new Lead_onHandler();
			case 'stand':
				return new StandHandler();
			case 'taxiway':
				return new TaxiwayHandler();
			default:
				throw new Error(`Unsupported BARS type: ${type}`);
		}
	}
}

/**
 * Process BARS polygons and generate light points
 */
export async function processBarsPolygon(polygon: BarsPolygon, dbRecord: BarsDBRecord): Promise<ProcessedBarsObject | null> {
	try {
		const handler = BarsHandlerFactory.getHandler(dbRecord.type);
		const lightPoints = handler.generateLightPoints(polygon, dbRecord);

		if (lightPoints.length === 0) return null;

		return {
			id: polygon.id,
			type: dbRecord.type,
			points: lightPoints,
			properties: {
				type: dbRecord.type,
				color: dbRecord.color,
				directionality: dbRecord.directionality,
				elevated: dbRecord.elevated,
			},
		};
	} catch (error) {
		console.error(`Error processing BARS polygon ${polygon.id}:`, error);
		return null;
	}
}

/**
 * Minimum distance threshold (in meters) for merging points
 * Points closer than this threshold will be merged
 */
export const POINT_MERGE_THRESHOLD = 2.0;

/**
 * Merge points that are too close together to prevent overlapping lights
 * This is especially important for taxiway segments where ends meet other segments' starts
 * @param objects The processed BARS objects to deduplicate points from
 * @returns The processed BARS objects with deduplicated points
 */
export function deduplicateTaxiwayPoints(objects: ProcessedBarsObject[]): ProcessedBarsObject[] {
	// Extract all taxiway objects
	const taxiwayObjects = objects.filter((obj) => obj.type === 'taxiway');
	const otherObjects = objects.filter((obj) => obj.type !== 'taxiway');

	// If we don't have any taxiway objects, return the original array
	if (taxiwayObjects.length === 0) return objects;

	// Flatten all taxiway points into a single array for processing
	let allTaxiwayPoints: BarsLightPoint[] = [];
	taxiwayObjects.forEach((obj) => {
		allTaxiwayPoints = [...allTaxiwayPoints, ...obj.points];
	});

	// Create a map to track merged points and their connections
	const mergedPointsMap: Map<
		string,
		{
			point: BarsLightPoint;
			count: number;
			sourcePoints: BarsLightPoint[];
		}
	> = new Map();

	// First pass: group points by location within threshold
	for (const point of allTaxiwayPoints) {
		let foundExistingGroup = false;

		// Check if this point belongs to an existing group
		for (const [, group] of mergedPointsMap.entries()) {
			const distance = calculateDistance({ lat: point.lat, lon: point.lon }, { lat: group.point.lat, lon: group.point.lon });

			if (distance <= POINT_MERGE_THRESHOLD) {
				// Add this point to the existing group
				group.sourcePoints.push(point);
				group.count++;
				foundExistingGroup = true;
				break;
			}
		}

		// If no existing group was found, create a new one
		if (!foundExistingGroup) {
			const key = `${point.lat.toFixed(7)},${point.lon.toFixed(7)}`;
			mergedPointsMap.set(key, {
				point: { ...point },
				count: 1,
				sourcePoints: [point],
			});
		}
	}

	// Second pass: determine canonical positions per group (preserve original headings per light)
	// We only "snap" lat/lon to the group's canonical point; heading/properties stay from the source point.
	const canonicalPositions: Map<string, Pick<BarsLightPoint, 'lat' | 'lon'>> = new Map();

	for (const [key, group] of mergedPointsMap.entries()) {
		// Use the first point's position as canonical for stability
		canonicalPositions.set(key, { lat: group.point.lat, lon: group.point.lon });
	}

	// Final step: recreate the taxiway objects with deduplicated points
	const deduplicatedTaxiwayObjects = taxiwayObjects.map((obj) => {
		// Map each point in this object to its deduplicated version
		const newPoints: BarsLightPoint[] = [];

		for (const point of obj.points) {
			// Find which group this point belongs to
			let found = false;
			for (const [key, group] of mergedPointsMap.entries()) {
				if (group.sourcePoints.some((p) => p === point)) {
					// Use the canonical position for that group, but preserve the original heading and properties
					const canonical = canonicalPositions.get(key)!;
					newPoints.push({
						lat: canonical.lat,
						lon: canonical.lon,
						heading: ((point.heading % 360) + 360) % 360,
						properties: point.properties ? { ...point.properties } : undefined,
					});
					found = true;
					break;
				}
			}

			// If for some reason we didn't find a match (shouldn't happen), use the original
			if (!found) {
				newPoints.push({ ...point });
			}
		}

		// Return the object with deduplicated points
		return {
			...obj,
			points: newPoints,
		};
	});

	// Return the combined array of deduplicated taxiway objects and other objects
	return [...deduplicatedTaxiwayObjects, ...otherObjects];
}
