import { NextResponse } from "next/server";

import { missionConfig } from "@/lib/mission-config";
import { getLiveLaunchStatus } from "@/lib/nasa";

export const runtime = "nodejs";
export const revalidate = 0;

export async function GET() {
  const status = await getLiveLaunchStatus(missionConfig);

  return NextResponse.json(status, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
