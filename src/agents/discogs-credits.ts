import type { ProducerCredit, EventEmitter } from "./types";
import { withCache, makeKey, CACHE_TTL } from "@/lib/cache";

// Discogs API rate limit: 60 req/min for authenticated requests.
// Get a personal token at https://www.discogs.com/settings/developers
const DISCOGS_DELAY = 1100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildHeaders(): Record<string, string> {
  const token = process.env.DISCOGS_TOKEN;
  return {
    "User-Agent": "GeniusScout/1.0 +https://github.com/genius-scout",
    Accept: "application/vnd.discogs.v2.discogs+json",
    ...(token ? { Authorization: `Discogs token=${token}` } : {}),
  };
}

async function discogsFetchRaw<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { headers: buildHeaders() });
      if (resp.ok) return (await resp.json()) as T;
      if (resp.status === 429 || resp.status === 503) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return null;
    } catch {
      await sleep(1500);
    }
  }
  return null;
}

async function discogsFetch<T>(url: string): Promise<T | null> {
  return withCache<T | null>(
    makeKey("discogs", url),
    "discogs",
    CACHE_TTL.DISCOGS,
    () => discogsFetchRaw<T>(url)
  );
}

interface DiscogsSearchResult {
  results: {
    id: number;
    title: string;
    type: string; // "release" | "master"
    year?: number | string;
    master_id?: number;
    master_url?: string;
    resource_url: string;
  }[];
}

interface DiscogsExtraArtist {
  name: string;
  role: string;
  tracks?: string; // e.g. "1, 3-5" or "" for whole release
  id?: number;
}

interface DiscogsTrack {
  position: string;
  type_?: string;
  title: string;
  duration?: string;
  extraartists?: DiscogsExtraArtist[];
}

interface DiscogsRelease {
  id: number;
  title: string;
  artists: { name: string; id: number }[];
  tracklist: DiscogsTrack[];
  extraartists?: DiscogsExtraArtist[];
  uri: string;
}

// Roles in Discogs that indicate production/composition credits
const CREDIT_ROLE_PATTERNS = [
  /produc/i,
  /\bbeat/i,
  /compos/i,
  /\bwrit/i,
  /\bmix/i,
  /\bengineer/i,
  /\barrang/i,
  /co-prod/i,
  /lyricist/i,
  /vocal\s+produc/i,
];

function isCreditRole(role: string): boolean {
  return CREDIT_ROLE_PATTERNS.some((p) => p.test(role));
}

// Parse track range strings like "1", "1, 3", "A1 to A4", "1-5"
// into a function that tells whether a track at position N matches.
function buildTrackRangePredicate(
  rangeStr: string | undefined,
  trackPositions: string[]
): (position: string) => boolean {
  if (!rangeStr || !rangeStr.trim()) return () => true; // empty = all tracks

  const positions = trackPositions.map((p, idx) => ({ p, idx }));
  const parts = rangeStr.split(",").map((s) => s.trim()).filter(Boolean);
  const matches = new Set<string>();

  for (const part of parts) {
    const dashMatch = part.match(/^(.+?)\s*[-–to]+\s*(.+)$/i);
    if (dashMatch) {
      const start = dashMatch[1].trim();
      const end = dashMatch[2].trim();
      const startIdx = positions.find((p) => p.p === start)?.idx;
      const endIdx = positions.find((p) => p.p === end)?.idx;
      if (startIdx !== undefined && endIdx !== undefined) {
        for (let i = startIdx; i <= endIdx; i++) {
          matches.add(positions[i].p);
        }
      }
    } else {
      matches.add(part);
    }
  }

  return (position) => matches.has(position);
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findMatchingDiscogsTrack(
  geniusTitle: string,
  discogsTracks: DiscogsTrack[]
): DiscogsTrack | null {
  const target = normalizeTitle(geniusTitle);
  if (!target) return null;
  // Exact normalized match first
  for (const t of discogsTracks) {
    if (normalizeTitle(t.title) === target) return t;
  }
  // Partial match (one contains the other, ≥ 6 chars overlap)
  for (const t of discogsTracks) {
    const dn = normalizeTitle(t.title);
    if (!dn) continue;
    if (
      (target.length >= 6 && dn.includes(target.slice(0, 8))) ||
      (dn.length >= 6 && target.includes(dn.slice(0, 8)))
    ) {
      return t;
    }
  }
  return null;
}

export async function extractDiscogsCredits(
  artist: string,
  album: string,
  tracks: { title: string }[],
  emit: EventEmitter
): Promise<ProducerCredit[]> {
  emit("step_start", "discogs", `Recherche Discogs "${album}"...`);

  if (!process.env.DISCOGS_TOKEN) {
    emit(
      "error",
      "discogs",
      "DISCOGS_TOKEN manquant dans .env.local — requete anonyme (rate limit reduit)"
    );
  }

  // 1. Search for release.
  // Use structured params (release_title + artist) instead of a raw `q=` to
  // avoid Discogs returning unrelated releases that happen to contain a
  // common word from the title (e.g. "PINK").
  const params = new URLSearchParams({
    release_title: album,
    artist,
    type: "release",
    per_page: "10",
  });
  const search = await discogsFetch<DiscogsSearchResult>(
    `https://api.discogs.com/database/search?${params.toString()}`
  );
  await sleep(DISCOGS_DELAY);

  const albumNorm = album.toLowerCase().replace(/[^a-z0-9]/g, "");
  const artistNorm = artist.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Discogs search results have title formatted "Artist - Title".
  // We require BOTH a title match and an artist match to avoid wrong releases.
  const release = search?.results?.find((r) => {
    if (r.type !== "release") return false;
    const titleNorm = (r.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!titleNorm) return false;
    const titleMatch =
      albumNorm.length >= 6 && titleNorm.includes(albumNorm.slice(0, 8));
    const artistMatch =
      artistNorm.length >= 3 && titleNorm.includes(artistNorm.slice(0, 4));
    return titleMatch && artistMatch;
  });

  if (!release) {
    emit(
      "error",
      "discogs",
      `Album "${album}" de "${artist}" introuvable sur Discogs (aucun match titre+artiste sur ${search?.results?.length || 0} resultats)`
    );
    return tracks.map((t) => ({
      titre: t.title,
      credits: [],
      statut: "DISCOGS_NOT_FOUND",
      sourceUrl: null,
    }));
  }

  emit("track_done", "discogs", `Release Discogs trouvee: ${release.title}`);

  // 2. Fetch full release data
  const releaseData = await discogsFetch<DiscogsRelease>(
    `https://api.discogs.com/releases/${release.id}`
  );
  await sleep(DISCOGS_DELAY);

  if (!releaseData) {
    return tracks.map((t) => ({
      titre: t.title,
      credits: [],
      statut: "DISCOGS_FETCH_FAILED",
      sourceUrl: null,
    }));
  }

  const trackPositions = releaseData.tracklist.map((t) => t.position);
  const releaseSourceUrl = `https://www.discogs.com/release/${release.id}`;

  // 3. For each Genius track, find matching Discogs track and merge credits
  const results: ProducerCredit[] = [];

  for (const track of tracks) {
    const dTrack = findMatchingDiscogsTrack(track.title, releaseData.tracklist);
    const credits = new Set<string>();

    // Track-level credits
    if (dTrack?.extraartists) {
      for (const a of dTrack.extraartists) {
        if (isCreditRole(a.role) && a.name) {
          credits.add(a.name.replace(/\s*\(\d+\)\s*$/, "")); // strip Discogs disambig "(2)"
        }
      }
    }

    // Release-level credits that apply to all tracks (or this specific position)
    if (releaseData.extraartists) {
      for (const a of releaseData.extraartists) {
        if (!isCreditRole(a.role) || !a.name) continue;
        const matches = buildTrackRangePredicate(a.tracks, trackPositions);
        if (!dTrack || matches(dTrack.position) || !a.tracks) {
          credits.add(a.name.replace(/\s*\(\d+\)\s*$/, ""));
        }
      }
    }

    const finalCredits = Array.from(credits);
    const statut = finalCredits.length > 0 ? "OK" : "DISCOGS_NO_CREDITS";

    results.push({
      titre: track.title,
      credits: finalCredits,
      statut,
      sourceUrl: releaseSourceUrl,
    });

    emit(
      "track_done",
      "discogs",
      `${finalCredits.length} credit(s) Discogs : ${finalCredits.join(", ") || "aucun"}`
    );
  }

  return results;
}
