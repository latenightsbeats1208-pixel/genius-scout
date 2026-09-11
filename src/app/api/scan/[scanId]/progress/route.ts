import { db } from "@/lib/db";
import type { NextRequest } from "next/server";

type RouteContext = { params: Promise<{ scanId: string }> };

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { scanId } = await ctx.params;

  const scan = db.getScan(scanId);
  if (!scan) {
    return new Response("Scan not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let lastEventId = 0;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        if (!closed) {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
      };

      const poll = async () => {
        while (!closed) {
          try {
            const events = db.getEventsSince(scanId, lastEventId);
            for (const event of events) {
              send(JSON.stringify(event));
              lastEventId = event.id as number;
            }

            // Check if scan is complete
            const currentScan = db.getScan(scanId);
            if (currentScan?.status === "complete" || currentScan?.status === "failed") {
              send(JSON.stringify({ type: "scan_done", status: currentScan.status }));
              closed = true;
              controller.close();
              return;
            }

            // Heartbeat
            send('{"type":"heartbeat"}');
          } catch {
            // DB error, continue
          }

          await new Promise((r) => setTimeout(r, 1000));
        }
      };

      poll();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
