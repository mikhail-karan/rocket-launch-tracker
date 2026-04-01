import { describe, expect, it } from "vitest";

import { missionConfig } from "../lib/mission-config";
import { createGuidanceSnapshot, pickAutoTrajectory } from "../lib/guide";

describe("trajectory selection and guidance", () => {
  it("picks the northern path for a North Carolina observer", () => {
    const decision = pickAutoTrajectory(
      { lat: 34.2, lon: -76.2 },
      missionConfig,
    );

    expect(decision.key).toBe("ne");
    expect(decision.containmentCount).toBeGreaterThan(0);
  });

  it("picks the eastern path for an Atlantic observer", () => {
    const decision = pickAutoTrajectory(
      { lat: 28.6, lon: -73.5 },
      missionConfig,
    );

    expect(decision.key).toBe("e");
    expect(decision.containmentCount).toBeGreaterThan(0);
  });

  it("marks Toronto as below the horizon during ascent", () => {
    const snapshot = createGuidanceSnapshot({
      config: missionConfig,
      launchTimeMs: Date.parse(missionConfig.launch.scheduledTimeIso),
      location: { lat: 43.6532, lon: -79.3832 },
      nowMs: Date.parse(missionConfig.launch.scheduledTimeIso) + 120_000,
      trajectoryKey: "ne",
    });

    expect(snapshot.visibilityState).toBe("below_horizon");
    expect(snapshot.elevationDegrees).toBeLessThan(0);
  });
});
