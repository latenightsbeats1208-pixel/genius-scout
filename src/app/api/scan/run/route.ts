import { db } from "@/lib/db";
import { requestScan, type RunKind } from "@/lib/scan-runner";

export async function POST(request: Request) {
  const { scanId, kind, fresh } = await request.json();

  if (!scanId) {
    return Response.json({ error: "Missing scanId" }, { status: 400 });
  }

  const scan = db.getScan(scanId);
  if (!scan) {
    return Response.json({ error: "Scan not found" }, { status: 404 });
  }

  const runKind: RunKind =
    kind === "credits" || kind === "instagram" ? kind : "full";

  // Runs immediately when a slot is free, queues otherwise (2 max at a time:
  // every scan shares one Instagram session, one Chrome and one IP).
  const result = requestScan(scanId, runKind, Boolean(fresh));

  return Response.json({ ...result, fresh: Boolean(fresh) });
}
