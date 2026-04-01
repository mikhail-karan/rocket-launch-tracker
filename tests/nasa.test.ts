import { describe, expect, it } from "vitest";

import { missionConfig } from "../lib/mission-config";
import { parseCoveragePage, parseMissionAvailabilityText } from "../lib/nasa";

describe("NASA source parsing", () => {
  it("extracts the launch target from the live coverage paragraph", () => {
    const html = `
      <html>
        <head>
          <meta name="updated" content="2026-04-01T12:00:26-04:00" />
        </head>
        <body>
          <p>Launch is targeted for no earlier than 6:24 p.m. EDT Wednesday, April 1, with a two-hour launch window.</p>
        </body>
      </html>
    `;

    expect(parseCoveragePage(html, missionConfig)).toEqual({
      launchTime: "2026-04-01T18:24:00-04:00",
      sourceUpdatedAt: null,
      windowMinutes: 120,
    });
  });

  it("extracts the nearest viable launch target from mission availability text", () => {
    const pdfText = `
      04/30/2026 06:06:00 PM EDT 120
      04/02/2026 07:22:00 PM EDT 120
      04/01/2026 06:24:00 PM EDT 120
    `;

    expect(
      parseMissionAvailabilityText(
        pdfText,
        Date.parse("2026-04-01T15:00:00-04:00"),
      ),
    ).toMatchObject({
      launchTime: "2026-04-01T18:24:00-04:00",
      windowMinutes: 120,
    });
  });
});
