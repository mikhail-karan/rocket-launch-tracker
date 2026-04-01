import rawMissionConfig from "@/data/artemis-ii.mission.json";

import type { MissionConfig, TrajectoryVariantKey } from "@/lib/types";

export const TRAJECTORY_VARIANT_ORDER: TrajectoryVariantKey[] = ["ne", "e", "se"];

export const missionConfig = rawMissionConfig as MissionConfig;
