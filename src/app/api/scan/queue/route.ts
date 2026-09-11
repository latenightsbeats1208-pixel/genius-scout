import { db } from "@/lib/db";
import {
  ensureQueueRunning,
  getRunningScans,
  MAX_CONCURRENT_SCANS,
} from "@/lib/scan-runner";

/**
 * Live view of the scan pipeline: what runs now, what waits its turn.
 * Polled by the home page; also the restart-recovery entry point (the GET
 * kicks the queue if the server rebooted with items still waiting).
 */
export async function GET() {
  ensureQueueRunning();

  const running = getRunningScans().map(({ scanId, kind }) => {
    const s = db.getScan(scanId);
    return {
      scanId,
      kind,
      artist: (s?.artist as string) || "?",
      album: (s?.album as string) || scanId,
      album_art_url: (s?.album_art_url as string) || null,
    };
  });

  const queued = db
    .getQueuedScans()
    .map((q, i) => ({ ...q, position: i + 1 }));

  return Response.json({ max: MAX_CONCURRENT_SCANS, running, queued });
}

export async function DELETE(request: Request) {
  const { scanId } = await request.json();
  if (!scanId) {
    return Response.json({ error: "Missing scanId" }, { status: 400 });
  }
  db.removeQueuedScan(scanId);
  return Response.json({ ok: true });
}
