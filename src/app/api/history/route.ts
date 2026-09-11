import { db } from "@/lib/db";

export async function GET() {
  const scans = db.getAllScans();

  // Enrich with producer stats
  const enriched = scans.map((scan) => {
    const producers = db.getProducers(scan.id as string);
    const confirmed = producers.filter((p) => p.ig_status === "confirmed").length;
    const probable = producers.filter((p) => p.ig_status === "probable").length;
    const notFound = producers.filter((p) => p.ig_status === "not_found" || p.ig_status === "pending").length;

    return {
      ...scan,
      ig_stats: {
        total: producers.length,
        confirmed,
        probable,
        not_found: notFound,
        rate: producers.length > 0 ? ((confirmed + probable) / producers.length * 100).toFixed(0) : "0",
      },
    };
  });

  return Response.json({ scans: enriched });
}
