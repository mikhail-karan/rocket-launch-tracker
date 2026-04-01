import { describe, expect, it } from "vitest";

import missionData from "../data/artemis-ii.mission.json";

describe("mission data shape", () => {
  it("contains the expected trajectory folders, sample counts, and polygons", () => {
    expect(Object.keys(missionData.trajectories)).toEqual(["ne", "e", "se"]);

    for (const trajectory of Object.values(missionData.trajectories)) {
      expect(trajectory.trajectorySamples).toHaveLength(49);
      expect(trajectory.visibilityPolygons).toHaveLength(8);
    }
  });
});
