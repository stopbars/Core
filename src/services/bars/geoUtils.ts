import { GeoPoint } from './types';
import { getDistance, computeDestinationPoint, getGreatCircleBearing } from 'geolib';

/**
 * Calculate distance between two geographic points in meters
 */
export function calculateDistance(point1: GeoPoint, point2: GeoPoint): number {
	return getDistance(
		{ latitude: point1.lat, longitude: point1.lon },
		{ latitude: point2.lat, longitude: point2.lon },
		0.05, // Accuracy in meters
	);
}

/**
 * Calculate the heading from point1 to point2 in degrees (0-360)
 */
export function calculateHeading(point1: GeoPoint, point2: GeoPoint): number {
	const heading = getGreatCircleBearing({ latitude: point1.lat, longitude: point1.lon }, { latitude: point2.lat, longitude: point2.lon });

	// Convert to 0-360 range
	return (heading + 360) % 360;
}

/**
 * Calculate a point at a specific distance and bearing from the start point
 */
export function calculateDestinationPoint(start: GeoPoint, distance: number, bearing: number): GeoPoint {
	const result = computeDestinationPoint({ latitude: start.lat, longitude: start.lon }, distance, bearing);

	return {
		lat: result.latitude,
		lon: result.longitude,
	};
}

/**
 * Converts degrees to radians
 */
export function toRadians(degrees: number): number {
	return degrees * (Math.PI / 180);
}

/**
 * Converts radians to degrees
 */
export function toDegrees(radians: number): number {
	return radians * (180 / Math.PI);
}

/**
 * Smooths a line by applying a simple moving average
 * This creates more points between existing ones for a smoother curve
 */
export function smoothLine(points: GeoPoint[], segments = 5): GeoPoint[] {
	if (points.length < 2) return points;

	const result: GeoPoint[] = [];

	for (let i = 0; i < points.length - 1; i++) {
		const start = points[i];
		const end = points[i + 1];

		result.push(start);

		for (let j = 1; j < segments; j++) {
			const fraction = j / segments;
			result.push({
				lat: start.lat + (end.lat - start.lat) * fraction,
				lon: start.lon + (end.lon - start.lon) * fraction,
			});
		}
	}

	// Add the last point
	result.push(points[points.length - 1]);

	return result;
}

/**
 * Generates points along a line at exactly equal intervals
 */
export function generateEquidistantPoints(
	points: GeoPoint[],
	interval: number, // interval in meters
): GeoPoint[] {
	if (points.length < 2) return points;

	const result: GeoPoint[] = [];

	// Always add the first point
	result.push({ ...points[0] });

	// Precompute segment lengths and bearings to avoid repeated geodesic calculations
	const segmentLengths: number[] = new Array(points.length - 1);
	const segmentBearings: number[] = new Array(points.length - 1);
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		segmentLengths[i] = calculateDistance(a, b);
		segmentBearings[i] = calculateHeading(a, b);
	}

	// Compute the total path length once before the loop
	const totalPathLength = segmentLengths.reduce((sum, v) => sum + v, 0);

	let totalDistanceTraveled = 0;
	let currentSegmentIndex = 0;
	let currentSegmentStart = points[0];
	let currentSegmentLength = segmentLengths[0];
	let currentSegmentBearing = segmentBearings[0];
	let distanceInCurrentSegment = 0;

	// Keep adding points at exact intervals until we reach the end of the line
	while (totalDistanceTraveled + interval <= totalPathLength) {
		totalDistanceTraveled += interval;

		// Find the segment where the next point should be placed
		while (distanceInCurrentSegment + currentSegmentLength <= totalDistanceTraveled && currentSegmentIndex < points.length - 2) {
			// Move to the next segment
			distanceInCurrentSegment += currentSegmentLength;
			currentSegmentIndex++;
			currentSegmentStart = points[currentSegmentIndex];
			currentSegmentLength = segmentLengths[currentSegmentIndex];
			currentSegmentBearing = segmentBearings[currentSegmentIndex];
		}

		// Calculate the exact position within the current segment
		const distanceIntoSegment = totalDistanceTraveled - distanceInCurrentSegment;

		// Place the point using precise geodesic calculation
		const newPoint = calculateDestinationPoint(currentSegmentStart, distanceIntoSegment, currentSegmentBearing);

		result.push(newPoint);
	}

	return result;
}
