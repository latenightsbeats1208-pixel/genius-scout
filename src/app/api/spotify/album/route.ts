import { spotifyApi } from "@/lib/spotify-api";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const input = searchParams.get("id") || searchParams.get("url");

  if (!input) {
    return Response.json({ error: "Missing id or url parameter" }, { status: 400 });
  }

  if (!spotifyApi.isConfigured()) {
    return Response.json(
      { error: "Spotify API not configured (missing SPOTIFY_CLIENT_ID/SECRET)" },
      { status: 503 }
    );
  }

  const albumId = spotifyApi.extractSpotifyAlbumId(input);
  if (!albumId) {
    return Response.json(
      { error: "Invalid Spotify album URL or ID" },
      { status: 400 }
    );
  }

  try {
    const album = await spotifyApi.getAlbumById(albumId);
    if (!album) {
      return Response.json({ error: "Album not found on Spotify" }, { status: 404 });
    }
    return Response.json({ album });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
