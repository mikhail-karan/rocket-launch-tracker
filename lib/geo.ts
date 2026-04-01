import type { Coordinate, TrajectorySample } from "@/lib/types";

const WGS84_A = 6_378_137;
const WGS84_E2 = 6.69437999014e-3;
const EARTH_RADIUS_METERS = 6_371_000;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

export function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}

export function normalizeDegrees(value: number) {
  return ((value % 360) + 360) % 360;
}

export function headingDeltaDegrees(targetHeading: number, currentHeading: number) {
  const delta = normalizeDegrees(targetHeading - currentHeading);
  return delta > 180 ? delta - 360 : delta;
}

export function getCircularMean(values: number[]) {
  if (!values.length) {
    return null;
  }

  const vector = values.reduce(
    (accumulator, value) => {
      const radians = degreesToRadians(value);
      return {
        x: accumulator.x + Math.cos(radians),
        y: accumulator.y + Math.sin(radians),
      };
    },
    { x: 0, y: 0 },
  );

  if (vector.x === 0 && vector.y === 0) {
    return null;
  }

  return normalizeDegrees(radiansToDegrees(Math.atan2(vector.y, vector.x)));
}

export function distanceMeters(a: Coordinate, b: Coordinate) {
  const lat1 = degreesToRadians(a.lat);
  const lat2 = degreesToRadians(b.lat);
  const deltaLat = degreesToRadians(b.lat - a.lat);
  const deltaLon = degreesToRadians(b.lon - a.lon);

  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  const arc = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));

  return EARTH_RADIUS_METERS * arc;
}

export function pointInPolygon(point: Coordinate, polygon: Coordinate[]) {
  let inside = false;

  for (
    let index = 0, previousIndex = polygon.length - 1;
    index < polygon.length;
    previousIndex = index++
  ) {
    const current = polygon[index];
    const previous = polygon[previousIndex];

    const intersects =
      current.lat > point.lat !== previous.lat > point.lat &&
      point.lon <
        ((previous.lon - current.lon) * (point.lat - current.lat)) /
          (previous.lat - current.lat) +
          current.lon;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function geodeticToEcef(point: Coordinate) {
  const lat = degreesToRadians(point.lat);
  const lon = degreesToRadians(point.lon);
  const alt = point.altMeters ?? 0;

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const cosLon = Math.cos(lon);
  const sinLon = Math.sin(lon);
  const radiusOfCurvature = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  return {
    x: (radiusOfCurvature + alt) * cosLat * cosLon,
    y: (radiusOfCurvature + alt) * cosLat * sinLon,
    z: (radiusOfCurvature * (1 - WGS84_E2) + alt) * sinLat,
  };
}

export function computeAzimuthElevation(
  observer: Coordinate,
  target: Coordinate,
): { azimuthDegrees: number; elevationDegrees: number } {
  const observerLat = degreesToRadians(observer.lat);
  const observerLon = degreesToRadians(observer.lon);
  const observerEcef = geodeticToEcef(observer);
  const targetEcef = geodeticToEcef(target);

  const dx = targetEcef.x - observerEcef.x;
  const dy = targetEcef.y - observerEcef.y;
  const dz = targetEcef.z - observerEcef.z;

  const east = -Math.sin(observerLon) * dx + Math.cos(observerLon) * dy;
  const north =
    -Math.sin(observerLat) * Math.cos(observerLon) * dx -
    Math.sin(observerLat) * Math.sin(observerLon) * dy +
    Math.cos(observerLat) * dz;
  const up =
    Math.cos(observerLat) * Math.cos(observerLon) * dx +
    Math.cos(observerLat) * Math.sin(observerLon) * dy +
    Math.sin(observerLat) * dz;

  const azimuthDegrees = normalizeDegrees(radiansToDegrees(Math.atan2(east, north)));
  const elevationDegrees = radiansToDegrees(
    Math.atan2(up, Math.sqrt(east * east + north * north)),
  );

  return { azimuthDegrees, elevationDegrees };
}

export function interpolateTrajectorySample(
  samples: TrajectorySample[],
  elapsedSeconds: number,
) {
  if (samples.length < 2) {
    throw new Error("At least two trajectory samples are required to interpolate.");
  }

  const minimumTime = samples[0].tPlusSeconds;
  const maximumTime = samples[samples.length - 1].tPlusSeconds;
  const clampedElapsed = clamp(elapsedSeconds, minimumTime, maximumTime);

  let lowerIndex = 0;
  while (
    lowerIndex < samples.length - 2 &&
    samples[lowerIndex + 1].tPlusSeconds < clampedElapsed
  ) {
    lowerIndex += 1;
  }

  const lower = samples[lowerIndex];
  const upper = samples[lowerIndex + 1];

  if (lower.tPlusSeconds === upper.tPlusSeconds) {
    return lower;
  }

  const fraction =
    (clampedElapsed - lower.tPlusSeconds) / (upper.tPlusSeconds - lower.tPlusSeconds);
  const lowerAltitude = lower.altMeters ?? 0;
  const upperAltitude = upper.altMeters ?? 0;

  return {
    altMeters: lowerAltitude + (upperAltitude - lowerAltitude) * fraction,
    lat: lower.lat + (upper.lat - lower.lat) * fraction,
    lon: lower.lon + (upper.lon - lower.lon) * fraction,
    sampleIndex: lower.sampleIndex,
    tPlusSeconds: clampedElapsed,
  };
}
