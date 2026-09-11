import { db } from "@/lib/db";
import { runCreditsPipeline } from "@/lib/pipeline";

export async function POST(request: Request) {
  const { scanId } = await request.json();

  if (!scanId) {
    return Response.json({ error: "Missing scanId" }, { status: 400 });
  }
  if (!db.getScan(scanId)) {
    return Response.json({ error: "Scan not found" }, { status: 404 });
  }

  try {
    await runCreditsPipeline(scanId);
    const producers = db.getProducers(scanId);
    return Response.json({ success: true, producerCount: producers.length });
  } catch (e) {
    db.updateScanStatus(scanId, "failed");
    db.insertEvent(scanId, "error", "pipeline", `Erreur: ${(e as Error).message}`);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
