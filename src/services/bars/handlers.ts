import { BarsDBRecord, BarsLightPoint, BarsPolygon, GeoPoint, ProcessedBarsObject } from './types';
import { calculateDestinationPoint, calculateHeading, generateEquidistantPoints, calculateDistance, smoothLine } from './geoUtils';

const STOPBAR_SPACING = 3;
const LEADON_SPACING = 12;
const STAND_SPACING = 15;
const TAXIWAY_SPACING = 11.25;
const ELEVATED_LIGHT_INWARD_ANGLE = 140;
const ELEVATED_LIGHT_INWARD_OFFSET = 0.3;
const ELEVATED_LIGHT_DISTANCE = 1.5;

export abstract class BarsTypeHandler {
	abstract generateLightPoints(polygon: BarsPolygon, dbRecord: BarsDBRecord): BarsLightPoint[];

	protected getHeadingAdjustment(orientation: 'left' | 'right' | 'both'): number {
		switch (orientation) {
			case 'left':
				return 0;
			case 'right':
				return 180;
			case 'both':
				return 0;
			default:
				return 0;
		}
	}
	protected addHeadingToPoints(points: GeoPoint[], headingAdjustment: number = 0): BarsLightPoint[] {
		if (points.length < 2) return [];

		const result: BarsLightPoint[] = [];

		for (let i = 0; i < points.length; i++) {
			let heading: number;

			if (i === 0) {
				const nextIndex = Math.min(points.length - 1, 1);
				heading = calculateHeading(points[0], points[nextIndex]);
			} else if (i === points.length - 1) {
				heading = calculateHeading(points[i - 1], points[i]);
			} else {
				const headingFrom = calculateHeading(points[i - 1], points[i]);
				const headingTo = calculateHeading(points[i], points[i + 1]);

				const diff = Math.abs(headingFrom - headingTo);
				if (diff > 180) {
					const adjustedHeadingTo = headingTo < headingFrom ? headingTo + 360 : headingTo;
					const adjustedHeadingFrom = headingFrom < headingTo ? headingFrom + 360 : headingFrom;
					heading = ((adjustedHeadingFrom + adjustedHeadingTo) / 2) % 360;
				} else {
					heading = (headingFrom + headingTo) / 2;
				}
			}

			heading = (heading + headingAdjustment) % 360;

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

		// Orientation mapping requirement (perpendicular to line):
		//  We compute perpendicular headings (seg - 90) and (seg + 90).
		//  Flipped per latest feedback:
		//  left  -> choose perpendicular in north/east half (<180)
		//  right -> choose perpendicular in south/west half (>=180)
		//  both  -> deterministic choice (south/west half) so stable output.
		const orientation = dbRecord.orientation || 'both';

		const lightsWithHeading: BarsLightPoint[] = alongHeadings.map((p) => {
			const seg = ((p.heading % 360) + 360) % 360; // along-line heading
			const perpA = (seg + 90) % 360; // right side relative to direction of drawing
			const perpB = (seg + 270) % 360; // left side (seg - 90)
			// Determine which candidate is north/east (<180) vs south/west (>=180)
			const candidateNorthEast = perpA < 180 ? perpA : perpB < 180 ? perpB : perpA; // one <180 if possible
			const candidateSouthWest = perpA >= 180 ? perpA : perpB >= 180 ? perpB : perpA; // one >=180 if possible
			let chosen: number;
			if (orientation === 'right') {
				chosen = candidateSouthWest; // flipped
			} else if (orientation === 'left') {
				chosen = candidateNorthEast; // flipped
			} else {
				// both -> deterministic pick south/west
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
					orientation: dbRecord.orientation,
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
					orientation: dbRecord.orientation, // Inherit orientation from stopbar
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
		// Now place them on the OPPOSITE side of the stopbar (flip from previous -90 to +90)
		const startInwardPoint = calculateDestinationPoint(
			startElevatedPoint,
			ELEVATED_LIGHT_INWARD_OFFSET,
			(baseLineHeading + 90) % 360, // opposite side perpendicular
		);

		const endInwardPoint = calculateDestinationPoint(
			endElevatedPoint,
			ELEVATED_LIGHT_INWARD_OFFSET,
			(baseLineHeading + 90) % 360, // opposite side perpendicular
		);

		// Step 3: Flip headings 180° so elevated lights face the correct (opposite) way after side switch
		// Original inward headings: base+angle and base+180-angle. We add 180 to both to flip them.
		const firstElevatedHeading = (baseLineHeading + ELEVATED_LIGHT_INWARD_ANGLE + 90) % 360;
		const lastElevatedHeading = (baseLineHeading - ELEVATED_LIGHT_INWARD_ANGLE + 90) % 360;

		// Add the elevated lights with correct positions and inward headings
		elevatedLights.push({
			...startInwardPoint,
			heading: firstElevatedHeading,
			properties: {
				type: 'stopbar',
				color: 'red',
				elevated: true,
				orientation: firstLight.properties?.orientation || 'both',
			},
		});

		elevatedLights.push({
			...endInwardPoint,
			heading: lastElevatedHeading,
			properties: {
				type: 'stopbar',
				color: 'red',
				elevated: true,
				orientation: lastLight.properties?.orientation || 'both',
			},
		});

		return elevatedLights;
	}
}

/**
 * Handler for leadon type BARS
 */
export class LeadonHandler extends BarsTypeHandler {
	generateLightPoints(polygon: BarsPolygon, dbRecord: BarsDBRecord): BarsLightPoint[] {
		const points = polygon.points;
		if (points.length < 2) return [];

		// Generate points along the line with 12-meter spacing
		const lightPoints = generateEquidistantPoints(points, LEADON_SPACING);

		// Determine if we're in the southern hemisphere by checking the first point's latitude
		const isInSouthernHemisphere = points[0].lat < 0;

		// Calculate heading for each light - account for hemisphere differences
		let headingAdjustment = this.getHeadingAdjustment(dbRecord.orientation);

		// In the southern hemisphere, we need to add 180 degrees to correct the direction
		if (isInSouthernHemisphere) {
			headingAdjustment = (headingAdjustment + 180) % 360;
		}

		const lightsWithHeading = this.addHeadingToPoints(lightPoints, headingAdjustment);

		// Add properties to lights, alternating between yellow and yellow-green-uni types
		return lightsWithHeading.map((light, index): BarsLightPoint => {
			// Every second light is Yellow-Green-Uni
			const isYellowGreenUni = index % 2 === 1;

			return {
				...light,
				properties: {
					type: 'leadon',
					color: isYellowGreenUni ? 'yellow-green-uni' : 'green',
					orientation: isYellowGreenUni ? 'both' : dbRecord.orientation,
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

		// Check if the taxiway is uni-directional
		const isUniDirectional = dbRecord.directionality === 'uni-directional'; // For uni-directional taxiways, always use 'left' orientation consistently
		// For bi-directional taxiways, use 'both' orientation
		const defaultOrientation: 'left' | 'right' | 'both' = isUniDirectional ? 'left' : 'both';

		// Calculate heading for each light - account for hemisphere differences for uni-directional taxiways
		// For uni-directional taxiways, use right orientation like leadon lights
		let headingAdjustment = isUniDirectional
			? this.getHeadingAdjustment('right')
			: this.getHeadingAdjustment(dbRecord.orientation || 'both');

		// For uni-directional taxiways, handle like leadon/stand lights with hemisphere adjustment
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
			let finalOrientation: 'left' | 'right' | 'both' = defaultOrientation;

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
					finalOrientation = 'both';
				} else {
					// For uni-directional, use the special "color-uni" format for alternating colors
					if (index % 2 === 0) {
						finalColor = `${primaryColor}-uni`;
					} else {
						// Add "-uni" suffix to the secondary color for uni-directional segments
						finalColor = `${secondaryColor}-uni`;
					}
					// For uni-directional taxiways, all lights should face the same way (left)
					finalOrientation = 'left'; // All uni-directional taxiway lights face left
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
					orientation: finalOrientation,
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
	generateLightPoints(polygon: BarsPolygon, dbRecord: BarsDBRecord): BarsLightPoint[] {
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
		let headingAdjustment = this.getHeadingAdjustment(dbRecord.orientation);

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
					orientation: 'right', // Uni-directional facing the start of the line
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
			case 'leadon':
			case 'lead_on': // Handle both naming conventions
				return new LeadonHandler();
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
				orientation: dbRecord.orientation,
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

	// Second pass: create new points with averaged headings
	const mergedPoints: Map<string, BarsLightPoint> = new Map();

	for (const [key, group] of mergedPointsMap.entries()) {
		// If there's only one point in the group, no averaging needed
		if (group.count === 1) {
			mergedPoints.set(key, { ...group.point });
			continue;
		}

		// Calculate average heading (with proper handling of the 0/360 boundary)
		let sumSin = 0;
		let sumCos = 0;

		for (const point of group.sourcePoints) {
			// Convert heading to radians for vector averaging
			const headingRad = (point.heading * Math.PI) / 180;
			sumSin += Math.sin(headingRad);
			sumCos += Math.cos(headingRad);
		}

		// Calculate the average heading using vector components
		const averageHeading = ((Math.atan2(sumSin, sumCos) * 180) / Math.PI + 360) % 360;

		// Create the merged point
		// Use the position of the first point as the canonical position
		const mergedPoint: BarsLightPoint = {
			...group.point,
			heading: averageHeading,
			// Keep the properties from the first point but ensure type is defined to match LightProperties
			properties: {
				type: (group.point.properties?.type || 'taxiway') as string, // Ensure type is never undefined
				color: group.point.properties?.color,
				orientation: group.point.properties?.orientation,
				elevated: group.point.properties?.elevated,
				intensity: group.point.properties?.intensity,
			},
		};

		mergedPoints.set(key, mergedPoint);
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
					// Use the merged point from that group
					newPoints.push(mergedPoints.get(key)!);
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
