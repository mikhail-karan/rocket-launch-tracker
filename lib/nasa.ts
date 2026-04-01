import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { LaunchStatusResponse, MissionConfig } from "@/lib/types";

const WINDOW_WORDS_TO_MINUTES: Record<string, number> = {
  one: 60,
  "one-hour": 60,
  three: 180,
  "three-hour": 180,
  two: 120,
  "two-hour": 120,
};

let cachedLaunchStatus:
  | {
      fetchedAt: number;
      value: LaunchStatusResponse;
    }
  | undefined;

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

function buildIsoString({
  day,
  hour12,
  meridiem,
  minute,
  month,
  timezone,
  year,
}: {
  day: number;
  hour12: number;
  meridiem: string;
  minute: number;
  month: number;
  timezone: string;
  year: number;
}) {
  const meridiemUpper = meridiem.toUpperCase();
  const hour24 =
    meridiemUpper === "PM" && hour12 !== 12
      ? hour12 + 12
      : meridiemUpper === "AM" && hour12 === 12
        ? 0
        : hour12;
  const offset = timezone === "EST" ? "-05:00" : "-04:00";

  return `${year}-${pad(month)}-${pad(day)}T${pad(hour24)}:${pad(minute)}:00${offset}`;
}

function monthNameToNumber(name: string) {
  return (
    [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ].indexOf(name.toLowerCase()) + 1
  );
}

function parseWindowMinutes(token: string) {
  const normalized = token.toLowerCase().trim();

  if (WINDOW_WORDS_TO_MINUTES[normalized]) {
    return WINDOW_WORDS_TO_MINUTES[normalized];
  }

  if (normalized.endsWith("-hour")) {
    return Number.parseInt(normalized, 10) * 60;
  }

  if (normalized.endsWith("-minute")) {
    return Number.parseInt(normalized, 10);
  }

  const hourMatch = normalized.match(/(\d+)\s*hour/);
  if (hourMatch) {
    return Number.parseInt(hourMatch[1], 10) * 60;
  }

  const minuteMatch = normalized.match(/(\d+)\s*minute/);
  if (minuteMatch) {
    return Number.parseInt(minuteMatch[1], 10);
  }

  return null;
}

export function parseCoveragePage(html: string, config: MissionConfig) {
  const paragraphMatch = html.match(
    /Launch is targeted for no earlier than\s+(\d{1,2}:\d{2})\s*p\.m\.\s*(EDT|EST)\s+\w+,\s+([A-Za-z]+)\s+(\d{1,2}),\s+with a\s+([a-z0-9-]+)\s+launch window/i,
  );

  if (!paragraphMatch) {
    return null;
  }

  const month = monthNameToNumber(paragraphMatch[3]);
  if (!month) {
    return null;
  }

  const [hourToken, minuteToken] = paragraphMatch[1].split(":");
  const launchTime = buildIsoString({
    day: Number.parseInt(paragraphMatch[4], 10),
    hour12: Number.parseInt(hourToken, 10),
    meridiem: "PM",
    minute: Number.parseInt(minuteToken, 10),
    month,
    timezone: paragraphMatch[2].toUpperCase(),
    year: new Date(config.launch.scheduledTimeIso).getUTCFullYear(),
  });
  const windowMinutes = parseWindowMinutes(paragraphMatch[5]);
  const updatedAt = html.match(/"dateModified":"([^"]+)"/)?.[1] ?? null;

  if (!windowMinutes) {
    return null;
  }

  return {
    launchTime,
    sourceUpdatedAt: updatedAt,
    windowMinutes,
  };
}

export async function extractTextFromPdfBuffer(buffer: Buffer) {
  const pdf = await getDocument({
    data: buffer,
  }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(text);
  }

  return pages.join(" ");
}

export function parseMissionAvailabilityText(text: string, referenceTime = Date.now()) {
  const pattern =
    /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):\d{2}\s+(AM|PM)\s+(EDT|EST)[\s\S]{0,30}?(\d{2,3})(?!\d)/g;
  const candidates = [...text.matchAll(pattern)].map((match) => {
    const isoString = buildIsoString({
      day: Number.parseInt(match[2], 10),
      hour12: Number.parseInt(match[4], 10),
      meridiem: match[6],
      minute: Number.parseInt(match[5], 10),
      month: Number.parseInt(match[1], 10),
      timezone: match[7].toUpperCase(),
      year: Number.parseInt(match[3], 10),
    });

    return {
      launchTime: isoString,
      sourceUpdatedAt: null,
      windowMinutes: Number.parseInt(match[8], 10),
    };
  });

  if (!candidates.length) {
    return null;
  }

  const eligible = candidates
    .map((candidate) => ({
      ...candidate,
      deltaMs: Date.parse(candidate.launchTime) - referenceTime,
    }))
    .filter((candidate) => candidate.deltaMs >= -12 * 60 * 60 * 1000)
    .sort((left, right) => left.deltaMs - right.deltaMs);

  return (
    eligible[0] ??
    candidates.sort(
      (left, right) => Date.parse(left.launchTime) - Date.parse(right.launchTime),
    )[0]
  );
}

async function fetchCoveragePageStatus(config: MissionConfig) {
  const response = await fetch(config.sources.coveragePageUrl, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Coverage page request failed with ${response.status}.`);
  }

  const html = await response.text();
  const parsed = parseCoveragePage(html, config);

  if (!parsed) {
    throw new Error("Coverage page did not contain a parsable launch target.");
  }

  return {
    confidence: "high",
    fallbackUsed: false,
    launchTime: parsed.launchTime,
    sourceUpdatedAt: parsed.sourceUpdatedAt,
    sourceUrl: config.sources.coveragePageUrl,
    status:
      parsed.launchTime === config.launch.scheduledTimeIso ? "scheduled" : "adjusted",
    windowMinutes: parsed.windowMinutes,
  } satisfies LaunchStatusResponse;
}

async function fetchMissionAvailabilityStatus(config: MissionConfig) {
  const response = await fetch(config.sources.missionAvailabilityPdfUrl, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Mission availability PDF request failed with ${response.status}.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const parsed = parseMissionAvailabilityText(await extractTextFromPdfBuffer(buffer));

  if (!parsed) {
    throw new Error("Mission availability PDF did not contain a parsable launch target.");
  }

  return {
    confidence: "medium",
    fallbackUsed: true,
    launchTime: parsed.launchTime,
    sourceUpdatedAt: parsed.sourceUpdatedAt,
    sourceUrl: config.sources.missionAvailabilityPdfUrl,
    status: "fallback",
    windowMinutes: parsed.windowMinutes,
  } satisfies LaunchStatusResponse;
}

export async function getLiveLaunchStatus(config: MissionConfig) {
  const cacheTtlMs = 45_000;
  if (cachedLaunchStatus && Date.now() - cachedLaunchStatus.fetchedAt < cacheTtlMs) {
    return cachedLaunchStatus.value;
  }

  try {
    const fresh = await fetchCoveragePageStatus(config);
    cachedLaunchStatus = { fetchedAt: Date.now(), value: fresh };
    return fresh;
  } catch {
    try {
      const fallback = await fetchMissionAvailabilityStatus(config);
      cachedLaunchStatus = { fetchedAt: Date.now(), value: fallback };
      return fallback;
    } catch {
      if (cachedLaunchStatus) {
        return {
          ...cachedLaunchStatus.value,
          confidence: "low",
          fallbackUsed: true,
          status: "stale-cache",
        } satisfies LaunchStatusResponse;
      }

      const staticFallback = {
        confidence: "low",
        fallbackUsed: true,
        launchTime: config.launch.scheduledTimeIso,
        sourceUpdatedAt: null,
        sourceUrl: config.sources.coveragePageUrl,
        status: "fallback",
        windowMinutes: config.launch.windowMinutes,
      } satisfies LaunchStatusResponse;

      cachedLaunchStatus = { fetchedAt: Date.now(), value: staticFallback };
      return staticFallback;
    }
  }
}
