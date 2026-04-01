import { missionConfig, TRAJECTORY_VARIANT_ORDER } from "@/lib/mission-config";
import {
  clamp,
  computeAzimuthElevation,
  distanceMeters,
  interpolateTrajectorySample,
  pointInPolygon,
} from "@/lib/geo";
import type {
  AutoTrajectoryDecision,
  Coordinate,
  GuidanceSnapshot,
  GuidanceState,
  MissionConfig,
  TrajectoryVariantKey,
  VisibilityState,
} from "@/lib/types";

const PREVIEW_ELAPSED_SECONDS = 120;

export function getGuidanceState(
  nowMs: number,
  launchTimeMs: number,
  trackedDurationSeconds: number,
  hasLocation: boolean,
): GuidanceState {
  if (!hasLocation || Number.isNaN(launchTimeMs)) {
    return "unsupported";
  }

  if (nowMs < launchTimeMs) {
    return "countdown";
  }

  if (nowMs <= launchTimeMs + trackedDurationSeconds * 1000) {
    return "live";
  }

  return "post_ascent";
}

export function getNearestVisibilityMinute(elapsedSeconds: number) {
  if (elapsedSeconds < 0) {
    return null;
  }

  return clamp(Math.round(elapsedSeconds / 60), 1, 8);
}

export function pickAutoTrajectory(
  location: Coordinate,
  config: MissionConfig = missionConfig,
): AutoTrajectoryDecision {
  const ranked = TRAJECTORY_VARIANT_ORDER.map((key) => {
    const trajectory = config.trajectories[key];
    const containmentCount = trajectory.visibilityPolygons.filter((polygon) =>
      pointInPolygon(location, polygon.points),
    ).length;
    const tPlus120Sample =
      trajectory.trajectorySamples.find((sample) => sample.tPlusSeconds === 120) ??
      trajectory.trajectorySamples[12];
    const distanceToTPlus120Meters = distanceMeters(location, tPlus120Sample);

    return {
      containmentCount,
      distanceToTPlus120Meters,
      key,
    } satisfies AutoTrajectoryDecision;
  }).sort((left, right) => {
    if (right.containmentCount !== left.containmentCount) {
      return right.containmentCount - left.containmentCount;
    }

    return left.distanceToTPlus120Meters - right.distanceToTPlus120Meters;
  });

  return ranked[0];
}

function resolveVisibilityState(
  location: Coordinate | null,
  polygonPoints: Coordinate[] | null,
  elevationDegrees: number | null,
): VisibilityState {
  if (!location) {
    return "no_location";
  }

  if (elevationDegrees !== null && elevationDegrees < 0) {
    return "below_horizon";
  }

  if (!polygonPoints) {
    return "outside_zone_uncertain";
  }

  return pointInPolygon(location, polygonPoints)
    ? "inside_zone"
    : "outside_zone_uncertain";
}

export function createGuidanceSnapshot({
  config = missionConfig,
  launchTimeMs,
  location,
  nowMs,
  trajectoryKey,
}: {
  config?: MissionConfig;
  launchTimeMs: number;
  location: Coordinate | null;
  nowMs: number;
  trajectoryKey: TrajectoryVariantKey;
}): GuidanceSnapshot {
  const guidanceState = getGuidanceState(
    nowMs,
    launchTimeMs,
    config.launch.trackedDurationSeconds,
    Boolean(location),
  );

  if (!location) {
    return {
      azimuthDegrees: null,
      distanceToTargetKm: null,
      elapsedSeconds: null,
      elevationDegrees: null,
      guidanceState,
      targetMinute: null,
      targetTimeLabel: null,
      trajectoryKey,
      visibilityState: "no_location",
    };
  }

  if (guidanceState === "post_ascent" || guidanceState === "unsupported") {
    return {
      azimuthDegrees: null,
      distanceToTargetKm: null,
      elapsedSeconds: null,
      elevationDegrees: null,
      guidanceState,
      targetMinute: null,
      targetTimeLabel: null,
      trajectoryKey,
      visibilityState: "no_location",
    };
  }

  const rawElapsedSeconds =
    guidanceState === "countdown"
      ? PREVIEW_ELAPSED_SECONDS
      : (nowMs - launchTimeMs) / 1000;
  const trajectory = config.trajectories[trajectoryKey];
  const elapsedSeconds = clamp(
    rawElapsedSeconds,
    0,
    config.launch.trackedDurationSeconds,
  );
  const target = interpolateTrajectorySample(
    trajectory.trajectorySamples,
    elapsedSeconds,
  );
  const { azimuthDegrees, elevationDegrees } = computeAzimuthElevation(location, target);
  const targetMinute = getNearestVisibilityMinute(elapsedSeconds);
  const visibilityPolygon =
    trajectory.visibilityPolygons.find((polygon) => polygon.minute === targetMinute) ?? null;
  const visibilityState = resolveVisibilityState(
    location,
    visibilityPolygon?.points ?? null,
    elevationDegrees,
  );

  return {
    azimuthDegrees,
    distanceToTargetKm: distanceMeters(location, target) / 1000,
    elapsedSeconds,
    elevationDegrees,
    guidanceState,
    targetMinute,
    targetTimeLabel:
      guidanceState === "countdown"
        ? "Preview at T+2m"
        : `Tracking T+${Math.floor(elapsedSeconds / 60)
            .toString()
            .padStart(2, "0")}:${Math.floor(elapsedSeconds % 60)
            .toString()
            .padStart(2, "0")}`,
    trajectoryKey,
    visibilityState,
  };
}
