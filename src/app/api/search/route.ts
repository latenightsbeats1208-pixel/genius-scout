import { searchAlbums } from "@/agents/genius-search";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");

  if (!q) {
    return Response.json({ error: "Missing query parameter" }, { status: 400 });
  }

  try {
    const albums = await searchAlbums(q);
    return Response.json({ albums });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
