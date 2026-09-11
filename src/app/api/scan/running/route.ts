import { getRunningScans } from "@/lib/scan-runner";

export async function GET() {
  return Response.json({ running: getRunningScans() });
}
