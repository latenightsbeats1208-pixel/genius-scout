// Spotify Web API wrapper (Client Credentials flow).
// Setup: create an app at https://developer.spotify.com/dashboard,
// then set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.local.

interface SpotifyToken {
  value: string;
  expiresAt: number;
}

interface SpotifyAlbumSearchItem {
  id: string;
  name: string;
  artists: { name: string }[];
  release_date?: string;
  total_tracks: number;
  external_urls: { spotify: string };
  images: { url: string; width: number; height: number }[];
}

interface SpotifyAlbumTracksItem {
  id: string;
  name: string;
  duration_ms: number;
  track_number: number;
  external_urls: { spotify: string };
  external_ids?: { isrc?: string };
}

let cachedToken: SpotifyToken | null = null;

function isConfigured(): boolean {
  return Boolean(
    process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET
  );
}

async function getAccessToken(): Promise<string | null> {
  if (!isConfigured()) return null;

  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) return null;

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

async function spotifyFetch<T>(url: string): Promise<T | null> {
  const token = await getAccessToken();
  if (!token) return null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) return (await resp.json()) as T;
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("retry-after") || "1");
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      continue;
    }
    if (resp.status === 401) {
      cachedToken = null;
      continue;
    }
    return null;
  }
  return null;
}

export interface SpotifyAlbumMatch {
  id: string;
  name: string;
  artists: string[];
  url: string;
  release_date?: string;
  total_tracks: number;
  cover_art_url?: string;
}

export interface SpotifyTrack {
  id: string;
  title: string;
  url: string;
  duration_ms: number;
  track_number: number;
  isrc: string | null;
}

function score(text: string, target: string): number {
  const a = text.toLowerCase();
  const b = target.toLowerCase();
  if (a === b) return 10;
  if (a.includes(b) || b.includes(a)) return 6;
  const aTokens = new Set(a.split(/\s+/));
  const bTokens = b.split(/\s+/);
  let common = 0;
  for (const t of bTokens) if (aTokens.has(t)) common++;
  return common * 2;
}

export async function searchAlbum(
  artist: string,
  album: string
): Promise<SpotifyAlbumMatch | null> {
  const q = encodeURIComponent(`album:${album} artist:${artist}`);
  const data = await spotifyFetch<{ albums?: { items: SpotifyAlbumSearchItem[] } }>(
    `https://api.spotify.com/v1/search?q=${q}&type=album&limit=10`
  );
  const items = data?.albums?.items || [];
  if (items.length === 0) return null;

  let best: SpotifyAlbumSearchItem | null = null;
  let bestScore = -1;
  for (const item of items) {
    const albumScore = score(item.name, album);
    const artistScore = Math.max(
      ...item.artists.map((a) => score(a.name, artist))
    );
    const total = albumScore + artistScore;
    if (total > bestScore) {
      bestScore = total;
      best = item;
    }
  }
  if (!best || bestScore < 4) return null;

  return {
    id: best.id,
    name: best.name,
    artists: best.artists.map((a) => a.name),
    url: best.external_urls.spotify,
    release_date: best.release_date,
    total_tracks: best.total_tracks,
    cover_art_url:
      best.images?.find((img) => img.width >= 300)?.url ||
      best.images?.[0]?.url ||
      "",
  };
}

export async function getAlbumTracks(
  albumId: string
): Promise<SpotifyTrack[]> {
  interface TracksPage {
    items: SpotifyAlbumTracksItem[];
    next: string | null;
  }

  const all: SpotifyTrack[] = [];
  let nextUrl: string | null = `https://api.spotify.com/v1/albums/${albumId}/tracks?limit=50`;

  // Paginate (some albums > 50 tracks)
  while (nextUrl) {
    const data: TracksPage | null = await spotifyFetch<TracksPage>(nextUrl);
    if (!data) break;
    for (const t of data.items) {
      all.push({
        id: t.id,
        title: t.name,
        url: t.external_urls.spotify,
        duration_ms: t.duration_ms,
        track_number: t.track_number,
        isrc: t.external_ids?.isrc || null,
      });
    }
    nextUrl = data.next;
  }

  // /albums/{id}/tracks does not include external_ids by default, so re-fetch
  // tracks in batches of 50 to get ISRC codes (useful for cross-platform matching)
  if (all.length > 0 && all.every((t) => t.isrc === null)) {
    for (let i = 0; i < all.length; i += 50) {
      const batch = all.slice(i, i + 50);
      const ids = batch.map((t) => t.id).join(",");
      const data = await spotifyFetch<{
        tracks: { id: string; external_ids?: { isrc?: string } }[];
      }>(`https://api.spotify.com/v1/tracks?ids=${ids}`);
      if (data?.tracks) {
        for (const t of data.tracks) {
          const target = all.find((x) => x.id === t.id);
          if (target) target.isrc = t.external_ids?.isrc || null;
        }
      }
    }
  }

  return all;
}

export async function getAlbumById(
  albumId: string
): Promise<SpotifyAlbumMatch | null> {
  const data = await spotifyFetch<SpotifyAlbumSearchItem>(
    `https://api.spotify.com/v1/albums/${albumId}`
  );
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    artists: data.artists.map((a) => a.name),
    url: data.external_urls.spotify,
    release_date: data.release_date,
    total_tracks: data.total_tracks,
    cover_art_url:
      data.images?.find((img) => img.width >= 300)?.url ||
      data.images?.[0]?.url ||
      "",
  };
}

export function extractSpotifyAlbumId(input: string): string | null {
  const trimmed = input.trim();
  // Direct ID (22 alphanumeric chars)
  if (/^[a-zA-Z0-9]{22}$/.test(trimmed)) return trimmed;
  // URL: https://open.spotify.com/[intl-xx/]album/{id}[?si=...]
  const match = trimmed.match(
    /open\.spotify\.com\/(?:intl-[a-z]+\/)?album\/([a-zA-Z0-9]{22})/i
  );
  if (match) return match[1];
  // URI: spotify:album:{id}
  const uri = trimmed.match(/spotify:album:([a-zA-Z0-9]{22})/i);
  if (uri) return uri[1];
  return null;
}

export const spotifyApi = {
  isConfigured,
  searchAlbum,
  getAlbumById,
  getAlbumTracks,
  extractSpotifyAlbumId,
};
