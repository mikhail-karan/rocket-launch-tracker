import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { XMLParser } from "fast-xml-parser";

import type {
  Coordinate,
  MissionConfig,
  TrajectorySample,
  TrajectoryVariantKey,
  VisibilityPolygon,
} from "@/lib/types";

const MAP_URL =
  "https://www.google.com/maps/d/u/0/viewer?mid=1oko0bZvm_ljj5YD42oJVE6S02ZPIm9o&ll=30.708332735747376%2C-70.27652349999998&z=5";
const KML_URL =
  "https://www.google.com/maps/d/u/0/kml?mid=1oko0bZvm_ljj5YD42oJVE6S02ZPIm9o&forcekml=1";
const COVERAGE_PAGE_URL =
  "https://www.nasa.gov/missions/artemis/artemis-2/nasa-sets-coverage-for-artemis-ii-moon-mission/";
const MISSION_AVAILABILITY_PDF_URL =
  "https://www.nasa.gov/wp-content/uploads/2026/01/artemis-ii-mission-availability.pdf?emrc=69661b746d1af";

function asArray<T>(value: T | T[] | undefined) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function parseCoordinates(rawCoordinates: string): Coordinate[] {
  return rawCoordinates
    .trim()
    .split(/\s+/)
    .map((point) => {
      const [lon, lat, alt = "0"] = point.split(",");

      return {
        altMeters: Number.parseFloat(alt),
        lat: Number.parseFloat(lat),
        lon: Number.parseFloat(lon),
      };
    });
}

function parseVisibilityPolygon(name: string, rawCoordinates: string): VisibilityPolygon {
  const match = name.match(/T\+\s*(\d+)\s*min.*?\|\s*(\d+)\s*km alt/i);

  if (!match) {
    throw new Error(`Unexpected visibility placemark name: ${name}`);
  }

  return {
    altitudeKm: Number.parseInt(match[2], 10),
    minute: Number.parseInt(match[1], 10),
    points: parseCoordinates(rawCoordinates),
  };
}

function parseTrajectorySamples(rawCoordinates: string): TrajectorySample[] {
  const points = parseCoordinates(rawCoordinates);

  return points.map((point, sampleIndex) => ({
    ...point,
    sampleIndex,
    tPlusSeconds: sampleIndex * 10,
  }));
}

function toVariantKey(folderName: string): TrajectoryVariantKey {
  const suffix = folderName.split(" ").at(-1)?.toLowerCase();

  if (suffix === "ne" || suffix === "e" || suffix === "se") {
    return suffix;
  }

  throw new Error(`Unexpected folder name: ${folderName}`);
}

async function main() {
  const response = await fetch(KML_URL);

  if (!response.ok) {
    throw new Error(`KML request failed with ${response.status}.`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
  });
  const document = parser.parse(await response.text())?.kml?.Document;
  const folders = asArray(document?.Folder);

  if (folders.length !== 3) {
    throw new Error(`Expected 3 trajectory folders, received ${folders.length}.`);
  }

  const trajectories = Object.fromEntries(
    folders.map((folder: { Placemark?: unknown; name: string }) => {
      const key = toVariantKey(folder.name);
      const placemarks = asArray(folder.Placemark) as Array<{
        LineString?: { coordinates: string };
        Polygon?: {
          outerBoundaryIs?: { LinearRing?: { coordinates: string } };
        };
        name: string;
      }>;

      const trajectoryPlacemark = placemarks.find(
        (placemark) => placemark.name === "Trajectory + Orbit",
      );

      if (!trajectoryPlacemark?.LineString?.coordinates) {
        throw new Error(`Folder ${folder.name} is missing the trajectory line.`);
      }

      const visibilityPolygons = placemarks
        .filter((placemark) => placemark.name.includes("T+"))
        .map((placemark) => {
          const coordinates =
            placemark.Polygon?.outerBoundaryIs?.LinearRing?.coordinates;

          if (!coordinates) {
            throw new Error(`Placemark ${placemark.name} is missing polygon coordinates.`);
          }

          return parseVisibilityPolygon(placemark.name, coordinates);
        })
        .sort((left, right) => left.minute - right.minute);

      const trajectorySamples = parseTrajectorySamples(
        trajectoryPlacemark.LineString.coordinates,
      );

      if (visibilityPolygons.length !== 8) {
        throw new Error(
          `Folder ${folder.name} expected 8 visibility polygons, received ${visibilityPolygons.length}.`,
        );
      }

      if (trajectorySamples.length !== 49) {
        throw new Error(
          `Folder ${folder.name} expected 49 trajectory samples, received ${trajectorySamples.length}.`,
        );
      }

      return [
        key,
        {
          label: folder.name,
          trajectorySamples,
          visibilityPolygons,
        },
      ];
    }),
  ) as MissionConfig["trajectories"];

  const missionConfig: MissionConfig = {
    launch: {
      scheduledTimeIso: "2026-04-01T18:24:00-04:00",
      timezone: "America/New_York",
      trackedDurationSeconds: 480,
      windowMinutes: 120,
    },
    missionName: "Artemis II Sky Guide",
    sampling: {
      inferredSampleStepSeconds: 10,
      note: "Trajectory + Orbit line is inferred as evenly sampled from T+0 through T+480 seconds.",
      sampleCount: 49,
    },
    sources: {
      coveragePageUrl: COVERAGE_PAGE_URL,
      kmlUrl: KML_URL,
      mapUrl: MAP_URL,
      missionAvailabilityPdfUrl: MISSION_AVAILABILITY_PDF_URL,
    },
    trajectories,
  };

  const outputDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../data",
  );
  const outputPath = path.join(outputDirectory, "artemis-ii.mission.json");

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(missionConfig, null, 2)}\n`, "utf8");

  console.log(
    `Wrote ${outputPath} with ${Object.keys(trajectories).length} trajectory variants.`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
