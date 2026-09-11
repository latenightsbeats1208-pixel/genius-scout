import { db } from "@/lib/db";
import { runInstagramPipeline } from "@/lib/pipeline";

export async function POST(request: Request) {
  const { scanId } = await request.json();

  if (!scanId) {
    return Response.json({ error: "Missing scanId" }, { status: 400 });
  }
  if (!db.getScan(scanId)) {
    return Response.json({ error: "Scan not found" }, { status: 404 });
  }

  try {
    await runInstagramPipeline(scanId);
    const producers = db.getProducers(scanId);
    const confirmed = producers.filter((p) => p.ig_status === "confirmed").length;
    const probable = producers.filter((p) => p.ig_status === "probable").length;
    return Response.json({
      success: true,
      stats: {
        total: producers.length,
        confirmed,
        probable,
        not_found: producers.length - confirmed - probable,
      },
    });
  } catch (e) {
    db.updateScanStatus(scanId, "failed");
    db.insertEvent(scanId, "error", "instagram", `Erreur: ${(e as Error).message}`);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
