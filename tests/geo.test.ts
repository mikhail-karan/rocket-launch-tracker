import { describe, expect, it } from "vitest";

import { missionConfig } from "../lib/mission-config";
import { computeAzimuthElevation, getCircularMean } from "../lib/geo";

describe("geometry helpers", () => {
  it("computes a high-elevation eastward look angle near the launch site", () => {
    const observer = {
      altMeters: 0,
      lat: 28.62783,
      lon: -80.62075,
    };
    const target = missionConfig.trajectories.e.trajectorySamples[12];
    const result = computeAzimuthElevation(observer, target);

    expect(result.azimuthDegrees).toBeCloseTo(90, 1);
    expect(result.elevationDegrees).toBeCloseTo(50.5, 1);
  });

  it("smooths nearby headings with a circular mean", () => {
    expect(getCircularMean([350, 0, 10])).toBeCloseTo(0, 0);
  });
});
