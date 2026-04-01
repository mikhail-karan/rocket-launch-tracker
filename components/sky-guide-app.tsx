"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { TRAJECTORY_VARIANT_ORDER } from "@/lib/mission-config";
import { createGuidanceSnapshot, pickAutoTrajectory } from "@/lib/guide";
import {
  distanceMeters,
  getCircularMean,
  headingDeltaDegrees,
  normalizeDegrees,
} from "@/lib/geo";
import type {
  Coordinate,
  LaunchStatusResponse,
  MissionConfig,
  TrajectoryVariantKey,
} from "@/lib/types";

import styles from "./sky-guide-app.module.css";

type TrajectoryMode = "auto" | TrajectoryVariantKey;
type LocationStatus = "searching" | "ready" | "denied" | "unsupported" | "error";
type OrientationStatus =
  | "idle"
  | "loading"
  | "permission-required"
  | "ready"
  | "denied"
  | "unavailable";

type DeviceOrientationWithCompass = DeviceOrientationEvent & {
  webkitCompassHeading?: number;
};

const AUTO_REEVALUATION_DISTANCE_METERS = 5_000;
const HEADING_SAMPLE_WINDOW = 6;
const LIVE_REFRESH_INTERVAL_MS = 60_000;

function cardinalFromAzimuth(azimuth: number | null) {
  if (azimuth === null) {
    return "Awaiting bearing";
  }

  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return labels[Math.round(azimuth / 45) % labels.length];
}

function formatSignedDegrees(value: number | null, digits = 0) {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }

  return `${value.toFixed(digits)}°`;
}

function formatDistance(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }

  return `${value.toFixed(0)} km`;
}

function formatCountdown(deltaMs: number) {
  const totalSeconds = Math.max(0, Math.floor(deltaMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

function formatLaunchTarget(launchTime: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
    weekday: "short",
  }).format(new Date(launchTime));
}

function toDateTimeLocalValue(isoString: string) {
  const date = new Date(isoString);
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

function getVisibilityCopy(visibilityState: ReturnType<typeof createGuidanceSnapshot>["visibilityState"]) {
  switch (visibilityState) {
    case "inside_zone":
      return "Mapped visibility zone";
    case "outside_zone_uncertain":
      return "Outside the mapped zone. Guidance is still best-effort.";
    case "below_horizon":
      return "Below your local horizon right now.";
    case "no_location":
      return "Need your location to evaluate visibility.";
    default:
      return "Awaiting visibility.";
  }
}

function getLaunchStatusCopy(status: LaunchStatusResponse["status"]) {
  switch (status) {
    case "adjusted":
      return "NASA updated the target time.";
    case "fallback":
      return "Using the mission availability fallback.";
    case "stale-cache":
      return "Showing the last known launch target.";
    case "scheduled":
    default:
      return "Synced from NASA launch coverage.";
  }
}

function getOrientationCopy(status: OrientationStatus) {
  switch (status) {
    case "ready":
      return "Compass locked";
    case "permission-required":
      return "Tap to enable compass access";
    case "denied":
      return "Compass permission denied";
    case "unavailable":
      return "Compass heading unavailable";
    case "loading":
      return "Waiting for compass heading";
    case "idle":
    default:
      return "Compass idle";
  }
}

function extractHeading(event: DeviceOrientationWithCompass) {
  if (typeof event.webkitCompassHeading === "number") {
    return normalizeDegrees(event.webkitCompassHeading);
  }

  if (event.absolute && typeof event.alpha === "number") {
    return normalizeDegrees(360 - event.alpha);
  }

  return null;
}

function parseCoordinateValue(rawValue: string, bounds: [number, number]) {
  const numericValue = Number.parseFloat(rawValue);

  if (Number.isNaN(numericValue) || numericValue < bounds[0] || numericValue > bounds[1]) {
    return null;
  }

  return numericValue;
}

export function SkyGuideApp({ missionConfig }: { missionConfig: MissionConfig }) {
  const isHydrated = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const supportsGeolocation =
    isHydrated && typeof navigator !== "undefined" && "geolocation" in navigator;
  const orientationCapability = useMemo(() => {
    if (
      !isHydrated ||
      typeof window === "undefined" ||
      typeof DeviceOrientationEvent === "undefined"
    ) {
      return {
        requiresPermission: false,
        supported: false,
      };
    }

    const OrientationEventWithPermission =
      DeviceOrientationEvent as typeof DeviceOrientationEvent & {
        requestPermission?: () => Promise<string>;
      };

    return {
      requiresPermission:
        typeof OrientationEventWithPermission.requestPermission === "function",
      supported: true,
    };
  }, [isHydrated]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [launchStatus, setLaunchStatus] = useState<LaunchStatusResponse | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>("searching");
  const [orientationStatus, setOrientationStatus] = useState<OrientationStatus>("idle");
  const [gpsLocation, setGpsLocation] = useState<Coordinate | null>(null);
  const [gpsAccuracyMeters, setGpsAccuracyMeters] = useState<number | null>(null);
  const [manualLocation, setManualLocation] = useState<Coordinate | null>(null);
  const [manualLatitude, setManualLatitude] = useState("");
  const [manualLongitude, setManualLongitude] = useState("");
  const [manualLocationError, setManualLocationError] = useState<string | null>(null);
  const [trajectoryMode, setTrajectoryMode] = useState<TrajectoryMode>("auto");
  const [autoTrajectory, setAutoTrajectory] = useState<TrajectoryVariantKey>("e");
  const [headingDegrees, setHeadingDegrees] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [manualLaunchOverrideEnabled, setManualLaunchOverrideEnabled] = useState(false);
  const [manualLaunchValue, setManualLaunchValue] = useState(() =>
    toDateTimeLocalValue(missionConfig.launch.scheduledTimeIso),
  );
  const headingSamplesRef = useRef<number[]>([]);
  const autoAnchorRef = useRef<Coordinate | null>(null);
  const orientationCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(timerId);
  }, []);

  const pollLaunchStatus = useEffectEvent(async () => {
    try {
      const response = await fetch("/api/launch-status", { cache: "no-store" });
      if (!response.ok) {
        return;
      }

      const nextStatus = (await response.json()) as LaunchStatusResponse;
      startTransition(() => {
        setLaunchStatus(nextStatus);
        if (!manualLaunchOverrideEnabled) {
          setManualLaunchValue(toDateTimeLocalValue(nextStatus.launchTime));
        }
      });
    } catch {
      // Leave the last-known client state in place if polling fails.
    }
  });

  useEffect(() => {
    void pollLaunchStatus();
    const intervalId = window.setInterval(() => {
      void pollLaunchStatus();
    }, LIVE_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, []);

  const updateAutoTrajectory = useCallback((nextLocation: Coordinate) => {
    const hasMovedFarEnough =
      !autoAnchorRef.current ||
      distanceMeters(autoAnchorRef.current, nextLocation) >
        AUTO_REEVALUATION_DISTANCE_METERS;

    if (!hasMovedFarEnough) {
      return;
    }

    setAutoTrajectory(pickAutoTrajectory(nextLocation, missionConfig).key);
    autoAnchorRef.current = nextLocation;
  }, [missionConfig]);

  useEffect(() => {
    if (!supportsGeolocation) {
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const nextLocation = {
          altMeters: position.coords.altitude ?? 0,
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };

        setGpsLocation({
          ...nextLocation,
        });
        setGpsAccuracyMeters(position.coords.accuracy);
        setLocationStatus("ready");
        if (!manualLocation) {
          updateAutoTrajectory(nextLocation);
        }
      },
      (error) => {
        setLocationStatus(error.code === error.PERMISSION_DENIED ? "denied" : "error");
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5_000,
        timeout: 12_000,
      },
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [manualLocation, supportsGeolocation, updateAutoTrajectory]);

  const ensureOrientationListeners = useCallback(() => {
    if (orientationCleanupRef.current || !orientationCapability.supported) {
      return;
    }

    const handleOrientation = (event: Event) => {
      const heading = extractHeading(event as DeviceOrientationWithCompass);
      if (heading === null) {
        return;
      }

      headingSamplesRef.current = [
        ...headingSamplesRef.current.slice(-(HEADING_SAMPLE_WINDOW - 1)),
        heading,
      ];
      setHeadingDegrees(getCircularMean(headingSamplesRef.current));
      setOrientationStatus("ready");
    };

    window.addEventListener("deviceorientationabsolute", handleOrientation, true);
    window.addEventListener("deviceorientation", handleOrientation, true);

    orientationCleanupRef.current = () => {
      window.removeEventListener("deviceorientationabsolute", handleOrientation, true);
      window.removeEventListener("deviceorientation", handleOrientation, true);
      orientationCleanupRef.current = null;
    };
  }, [orientationCapability.supported]);

  useEffect(() => {
    if (!orientationCapability.supported || orientationCapability.requiresPermission) {
      return;
    }
    ensureOrientationListeners();

    return () => {
      orientationCleanupRef.current?.();
    };
  }, [
    ensureOrientationListeners,
    orientationCapability.requiresPermission,
    orientationCapability.supported,
  ]);

  const activeLocation = manualLocation ?? gpsLocation;
  const effectiveLocationStatus: LocationStatus = !isHydrated
    ? "searching"
    : supportsGeolocation
      ? locationStatus
      : "unsupported";
  const effectiveOrientationStatus: OrientationStatus =
    !isHydrated
      ? "idle"
      : orientationStatus === "idle"
      ? !orientationCapability.supported
        ? "unavailable"
        : orientationCapability.requiresPermission
          ? "permission-required"
          : "loading"
        : orientationStatus;

  const activeTrajectory = trajectoryMode === "auto" ? autoTrajectory : trajectoryMode;
  const liveLaunchTime = launchStatus?.launchTime ?? missionConfig.launch.scheduledTimeIso;
  const launchTimeMs = manualLaunchOverrideEnabled
    ? new Date(manualLaunchValue).getTime()
    : Date.parse(liveLaunchTime);

  const guidance = useMemo(
    () =>
      createGuidanceSnapshot({
        config: missionConfig,
        launchTimeMs,
        location: activeLocation,
        nowMs,
        trajectoryKey: activeTrajectory,
      }),
    [activeLocation, activeTrajectory, launchTimeMs, missionConfig, nowMs],
  );

  const deltaToTargetDegrees =
    headingDegrees === null || guidance.azimuthDegrees === null
      ? null
      : headingDeltaDegrees(guidance.azimuthDegrees, headingDegrees);
  const targetCountdownMs = launchTimeMs - nowMs;

  async function handleEnableCompass() {
    if (!orientationCapability.supported) {
      setOrientationStatus("unavailable");
      return;
    }

    const OrientationEventWithPermission =
      DeviceOrientationEvent as typeof DeviceOrientationEvent & {
        requestPermission?: () => Promise<string>;
      };

    if (typeof OrientationEventWithPermission.requestPermission !== "function") {
      return;
    }

    try {
      const permission = await OrientationEventWithPermission.requestPermission();
      if (permission !== "granted") {
        setOrientationStatus("denied");
        return;
      }

      setOrientationStatus("loading");
      ensureOrientationListeners();
    } catch {
      setOrientationStatus("denied");
    }
  }

  function handleManualLocationSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const latitude = parseCoordinateValue(manualLatitude, [-90, 90]);
    const longitude = parseCoordinateValue(manualLongitude, [-180, 180]);

    if (latitude === null || longitude === null) {
      setManualLocationError("Enter a valid latitude and longitude.");
      return;
    }

    setManualLocation({
      lat: latitude,
      lon: longitude,
    });
    setManualLocationError(null);
    updateAutoTrajectory({
      lat: latitude,
      lon: longitude,
    });
  }

  const turnInstruction =
    guidance.azimuthDegrees === null
      ? "Need a launch bearing first"
      : headingDegrees === null || deltaToTargetDegrees === null
        ? "Use your phone compass to face the target bearing manually."
        : Math.abs(deltaToTargetDegrees) < 5
          ? "Hold steady and keep the phone aligned."
          : deltaToTargetDegrees > 0
            ? `Turn ${Math.abs(deltaToTargetDegrees).toFixed(0)}° right`
            : `Turn ${Math.abs(deltaToTargetDegrees).toFixed(0)}° left`;

  const heroLabel =
    guidance.guidanceState === "countdown"
      ? "Countdown"
      : guidance.guidanceState === "live"
        ? "Live ascent"
        : guidance.guidanceState === "post_ascent"
          ? "Tracked window complete"
          : "Guidance unavailable";

  const heroValue =
    guidance.guidanceState === "countdown"
      ? formatCountdown(targetCountdownMs)
      : guidance.guidanceState === "live"
        ? guidance.targetTimeLabel
        : guidance.guidanceState === "post_ascent"
          ? "T+08:00 reached"
          : "Share location to begin";

  return (
    <main className={styles.page}>
      <div className={styles.pageGlow} />

      <section className={styles.shell}>
        <div className={styles.masthead}>
          <div>
            <p className={styles.eyebrow}>Artemis II Sky Guide</p>
            <h1 className={styles.title}>Find the rocket before your eyes do.</h1>
          </div>
          <div className={styles.statusPills}>
            <span className={styles.pill}>{getLaunchStatusCopy(launchStatus?.status ?? "fallback")}</span>
            <span className={styles.pill}>{getOrientationCopy(effectiveOrientationStatus)}</span>
          </div>
        </div>

        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.heroLabel}>{heroLabel}</p>
            <div className={styles.heroValue}>{heroValue}</div>
            <p className={styles.heroMeta}>
              Launch target {formatLaunchTarget(liveLaunchTime)}
              {manualLaunchOverrideEnabled ? " · manual override active" : ""}
            </p>
          </div>

          <div className={styles.heroStats}>
            <div className={styles.statBlock}>
              <span className={styles.statLabel}>Trajectory</span>
              <strong className={styles.statValue}>{activeTrajectory.toUpperCase()}</strong>
            </div>
            <div className={styles.statBlock}>
              <span className={styles.statLabel}>Bearing</span>
              <strong className={styles.statValue}>
                {formatSignedDegrees(guidance.azimuthDegrees)} {cardinalFromAzimuth(guidance.azimuthDegrees)}
              </strong>
            </div>
            <div className={styles.statBlock}>
              <span className={styles.statLabel}>Elevation</span>
              <strong className={styles.statValue}>{formatSignedDegrees(guidance.elevationDegrees, 1)}</strong>
            </div>
          </div>
        </section>

        <section className={styles.dialSection}>
          <div className={styles.dialFrame}>
            <div className={styles.dialCardinalNorth}>N</div>
            <div className={styles.dialCardinalEast}>E</div>
            <div className={styles.dialCardinalSouth}>S</div>
            <div className={styles.dialCardinalWest}>W</div>
            <div className={styles.dialCenter}>
              {headingDegrees !== null && guidance.azimuthDegrees !== null ? (
                <div
                  className={styles.pointer}
                  style={{
                    transform: `translate(-50%, -100%) rotate(${deltaToTargetDegrees ?? 0}deg)`,
                  }}
                >
                  <span className={styles.pointerStem} />
                  <span className={styles.pointerHead} />
                </div>
              ) : (
                <div className={styles.pointerFallback}>Compass needed</div>
              )}
              <div className={styles.dialReticle} />
            </div>
          </div>

          <div className={styles.directionPanel}>
            <p className={styles.directionLine}>{turnInstruction}</p>
            <p className={styles.directionSubline}>
              {guidance.guidanceState === "countdown"
                ? "Preview uses the inferred T+2 minute trajectory point."
                : guidance.targetTimeLabel ?? "Live guidance starts once the clock reaches liftoff."}
            </p>

            <div className={styles.badgeRow}>
              <span
                className={styles.visibilityBadge}
                data-visibility={guidance.visibilityState}
              >
                {getVisibilityCopy(guidance.visibilityState)}
              </span>
              <span className={styles.visibilityBadge}>
                Range {formatDistance(guidance.distanceToTargetKm)}
              </span>
            </div>

            {effectiveOrientationStatus === "permission-required" ? (
              <button className={styles.primaryAction} onClick={handleEnableCompass} type="button">
                Enable compass
              </button>
            ) : null}
          </div>
        </section>

        <section className={styles.sensorStrip}>
          <article className={styles.sensorCard}>
            <span className={styles.sensorLabel}>Location</span>
            <strong className={styles.sensorValue}>
              {activeLocation
                ? `${activeLocation.lat.toFixed(4)}, ${activeLocation.lon.toFixed(4)}`
                : effectiveLocationStatus === "searching"
                  ? "Finding you"
                  : "No fix yet"}
            </strong>
            <p className={styles.sensorDetail}>
              {manualLocation
                ? "Manual coordinates are overriding GPS."
                : gpsAccuracyMeters !== null
                  ? `GPS accuracy ±${gpsAccuracyMeters.toFixed(0)} m`
                  : effectiveLocationStatus === "denied"
                    ? "Location permission denied. Use manual coordinates below."
                    : "High-accuracy watch enabled."}
            </p>
          </article>

          <article className={styles.sensorCard}>
            <span className={styles.sensorLabel}>Heading</span>
            <strong className={styles.sensorValue}>
              {headingDegrees === null ? "Manual compass" : `${headingDegrees.toFixed(0)}°`}
            </strong>
            <p className={styles.sensorDetail}>
              {headingDegrees === null
                ? "If the dial does not move, use the phone compass bearing manually."
                : `Target offset ${formatSignedDegrees(deltaToTargetDegrees)} from where the phone is facing.`}
            </p>
          </article>
        </section>

        <section className={styles.linksRow}>
          <a href={missionConfig.sources.mapUrl} rel="noreferrer" target="_blank">
            Flight map
          </a>
          <a href={missionConfig.sources.coveragePageUrl} rel="noreferrer" target="_blank">
            NASA coverage
          </a>
          <a href={launchStatus?.sourceUrl ?? missionConfig.sources.missionAvailabilityPdfUrl} rel="noreferrer" target="_blank">
            Current timing source
          </a>
        </section>
      </section>

      <aside className={styles.sheet} data-open={sheetOpen}>
        <button
          className={styles.sheetToggle}
          onClick={() => setSheetOpen((current) => !current)}
          type="button"
        >
          {sheetOpen ? "Hide controls" : "Open controls"}
        </button>

        <div className={styles.sheetContent}>
          <section className={styles.controlSection}>
            <div className={styles.controlHeader}>
              <h2>Trajectory</h2>
              <p>Auto mode scores the three published paths using your current location.</p>
            </div>

            <div className={styles.segmented}>
              <button
                className={styles.segment}
                data-active={trajectoryMode === "auto"}
                onClick={() => setTrajectoryMode("auto")}
                type="button"
              >
                Auto
              </button>
              {TRAJECTORY_VARIANT_ORDER.map((variant) => (
                <button
                  className={styles.segment}
                  data-active={trajectoryMode === variant}
                  key={variant}
                  onClick={() => setTrajectoryMode(variant)}
                  type="button"
                >
                  {variant.toUpperCase()}
                </button>
              ))}
            </div>
          </section>

          <section className={styles.controlSection}>
            <div className={styles.controlHeader}>
              <h2>Manual location</h2>
              <p>Useful if GPS is denied or noisy where you are standing.</p>
            </div>

            <form className={styles.form} onSubmit={handleManualLocationSubmit}>
              <label className={styles.field}>
                <span>Latitude</span>
                <input
                  inputMode="decimal"
                  onChange={(event) => setManualLatitude(event.target.value)}
                  placeholder="28.6278"
                  value={manualLatitude}
                />
              </label>
              <label className={styles.field}>
                <span>Longitude</span>
                <input
                  inputMode="decimal"
                  onChange={(event) => setManualLongitude(event.target.value)}
                  placeholder="-80.6208"
                  value={manualLongitude}
                />
              </label>

              <div className={styles.formActions}>
                <button className={styles.primaryAction} type="submit">
                  Use manual coordinates
                </button>
                {manualLocation ? (
                  <button
                    className={styles.secondaryAction}
                    onClick={() => {
                      setManualLocation(null);
                      if (gpsLocation) {
                        updateAutoTrajectory(gpsLocation);
                      }
                    }}
                    type="button"
                  >
                    Return to GPS
                  </button>
                ) : null}
              </div>
            </form>

            {manualLocationError ? (
              <p className={styles.formError}>{manualLocationError}</p>
            ) : null}
          </section>

          <section className={styles.controlSection}>
            <div className={styles.controlHeader}>
              <h2>Launch time override</h2>
              <p>Use this if countdown holds push liftoff later than the published target.</p>
            </div>

            <label className={styles.field}>
              <span>Local phone time</span>
              <input
                onChange={(event) => {
                  setManualLaunchOverrideEnabled(true);
                  setManualLaunchValue(event.target.value);
                }}
                type="datetime-local"
                value={manualLaunchValue}
              />
            </label>

            <div className={styles.formActions}>
              <button
                className={styles.secondaryAction}
                onClick={() => {
                  setManualLaunchOverrideEnabled(false);
                  setManualLaunchValue(toDateTimeLocalValue(liveLaunchTime));
                }}
                type="button"
              >
                Use NASA target time
              </button>
            </div>
          </section>

          <section className={styles.controlSection}>
            <div className={styles.controlHeader}>
              <h2>Notes</h2>
              <p>
                Trajectory spacing is inferred from the published KML. The app treats the
                49-point line as evenly sampled every 10 seconds from T+0 through T+8
                minutes, which is helpful guidance rather than official telemetry.
              </p>
            </div>
          </section>
        </div>
      </aside>
    </main>
  );
}
