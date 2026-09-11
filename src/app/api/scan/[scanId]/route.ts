import { db } from "@/lib/db";
import type { NextRequest } from "next/server";

type RouteContext = { params: Promise<{ scanId: string }> };

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { scanId } = await ctx.params;

  const scan = db.getScan(scanId);
  if (!scan) {
    return Response.json({ error: "Scan not found" }, { status: 404 });
  }

  const tracks = db.getTracks(scanId);
  const producers = db.getProducers(scanId).map((p) => ({
    ...p,
    aliases: JSON.parse((p.aliases as string) || "[]"),
    sources: JSON.parse((p.sources as string) || "[]"),
    track_titles: JSON.parse((p.track_titles as string) || "[]"),
    ig_candidates: JSON.parse((p.ig_candidates as string) || "[]"),
    ig_profile_data: p.ig_profile_data ? JSON.parse(p.ig_profile_data as string) : null,
    ig_validation: p.ig_validation ? JSON.parse(p.ig_validation as string) : null,
  }));
  const events = db.getEvents(scanId);

  return Response.json({ scan, tracks, producers, events });
}
