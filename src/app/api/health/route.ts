import { checkHealth } from "@/lib/preflight";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const force = searchParams.get("force") === "1";
  const report = await checkHealth(force);
  return Response.json(report);
}
