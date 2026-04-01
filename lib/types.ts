export type TrajectoryVariantKey = "ne" | "e" | "se";

export type ConfidenceLevel = "high" | "medium" | "low";

export type GuidanceState =
  | "countdown"
  | "live"
  | "post_ascent"
  | "unsupported";

export type VisibilityState =
  | "inside_zone"
  | "outside_zone_uncertain"
  | "below_horizon"
  | "no_location";

export type LaunchStatusKind =
  | "scheduled"
  | "adjusted"
  | "fallback"
  | "stale-cache";

export type Coordinate = {
  altMeters?: number;
  lat: number;
  lon: number;
};

export type TrajectorySample = Coordinate & {
  sampleIndex: number;
  tPlusSeconds: number;
};

export type VisibilityPolygon = {
  altitudeKm: number;
  minute: number;
  points: Coordinate[];
};

export type MissionTrajectory = {
  label: string;
  trajectorySamples: TrajectorySample[];
  visibilityPolygons: VisibilityPolygon[];
};

export type MissionConfig = {
  launch: {
    scheduledTimeIso: string;
    timezone: string;
    trackedDurationSeconds: number;
    windowMinutes: number;
  };
  missionName: string;
  sampling: {
    inferredSampleStepSeconds: number;
    note: string;
    sampleCount: number;
  };
  sources: {
    coveragePageUrl: string;
    kmlUrl: string;
    mapUrl: string;
    missionAvailabilityPdfUrl: string;
  };
  trajectories: Record<TrajectoryVariantKey, MissionTrajectory>;
};

export type LaunchStatusResponse = {
  confidence: ConfidenceLevel;
  fallbackUsed: boolean;
  launchTime: string;
  sourceUpdatedAt: string | null;
  sourceUrl: string;
  status: LaunchStatusKind;
  windowMinutes: number;
};

export type AutoTrajectoryDecision = {
  containmentCount: number;
  distanceToTPlus120Meters: number;
  key: TrajectoryVariantKey;
};

export type GuidanceSnapshot = {
  azimuthDegrees: number | null;
  distanceToTargetKm: number | null;
  elapsedSeconds: number | null;
  elevationDegrees: number | null;
  guidanceState: GuidanceState;
  targetMinute: number | null;
  targetTimeLabel: string | null;
  trajectoryKey: TrajectoryVariantKey;
  visibilityState: VisibilityState;
};
