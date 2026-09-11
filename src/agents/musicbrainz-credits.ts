import type { ProducerCredit, EventEmitter } from "./types";
import { withCache, makeKey, CACHE_TTL } from "@/lib/cache";

// MusicBrainz rate limit: 1 request/second
const MB_DELAY = 1100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MB_HEADERS = {
  "User-Agent": "GeniusScout/1.0 ( https://github.com/genius-scout )",
  Accept: "application/json",
};

async function mbFetchRaw(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { headers: MB_HEADERS });
      if (resp.ok) return await resp.json();
      if (resp.status === 503 || resp.status === 429) {
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

async function mbFetch(url: string): Promise<unknown> {
  return withCache(makeKey("musicbrainz", url), "musicbrainz", CACHE_TTL.MUSICBRAINZ, () =>
    mbFetchRaw(url)
  );
}

interface MbRelation {
  type?: string;
  "target-type"?: string;
  artist?: { name: string; id: string };
}

interface MbRecording {
  id: string;
  title: string;
  score?: number;
  relations?: MbRelation[];
  "artist-credit"?: { name: string; artist?: { name: string } }[];
}

const PRODUCER_TYPES = new Set([
  "producer",
  "co-producer",
  "executive producer",
  "additional producer",
  "vocal producer",
  "mix",
  "mixer",
  "mixed by",
  "engineer",
  "remixer",
]);

const COMPOSER_TYPES = new Set(["composer", "writer", "lyricist", "arranger"]);

export async function extractMusicbrainzCredits(
  artist: string,
  album: string,
  tracks: { title: string }[],
  emit: EventEmitter
): Promise<ProducerCredit[]> {
  const results: ProducerCredit[] = [];
  emit("step_start", "musicbrainz", `Recherche MusicBrainz "${album}"...`);

  // 1. Find the release
  const searchQuery = encodeURIComponent(
    `release:"${album}" AND artist:"${artist}"`
  );
  const searchData = (await mbFetch(
    `https://musicbrainz.org/ws/2/release/?query=${searchQuery}&fmt=json&limit=5`
  )) as { releases?: { id: string; title: string; date?: string }[] } | null;

  await sleep(MB_DELAY);

  const release = searchData?.releases?.find((r) =>
    r.title.toLowerCase().includes(album.toLowerCase().slice(0, 8))
  );

  if (!release) {
    emit("error", "musicbrainz", `Album "${album}" introuvable sur MusicBrainz`);
    // Still return placeholder results so merger doesn't crash
    return tracks.map((t) => ({
      titre: t.title,
      credits: [],
      statut: "MB_NOT_FOUND",
      sourceUrl: null,
    }));
  }

  emit("track_done", "musicbrainz", `Album trouve: ${release.title}`);

  // 2. Get release with recordings
  const releaseData = (await mbFetch(
    `https://musicbrainz.org/ws/2/release/${release.id}?inc=recordings&fmt=json`
  )) as
    | {
        media?: { tracks?: { recording: { id: string; title: string } }[] }[];
      }
    | null;

  await sleep(MB_DELAY);

  const mbTracks: { id: string; title: string }[] = [];
  for (const media of releaseData?.media || []) {
    for (const t of media.tracks || []) {
      if (t.recording) {
        mbTracks.push({ id: t.recording.id, title: t.recording.title });
      }
    }
  }

  emit("track_done", "musicbrainz", `${mbTracks.length} titres MB trouves`);

  // 3. For each track, fetch artist relationships (producer credits)
  for (const track of tracks) {
    emit("track_processing", "musicbrainz", `MusicBrainz → "${track.title}"`);

    // Find matching MB track (fuzzy)
    const titleLower = track.title.toLowerCase();
    const titleNorm = titleLower.replace(/[^a-z0-9]/g, "");
    const mbTrack = mbTracks.find((mt) => {
      const mtNorm = mt.title.toLowerCase().replace(/[^a-z0-9]/g, "");
      return (
        mt.title.toLowerCase() === titleLower ||
        mtNorm === titleNorm ||
        mtNorm.includes(titleNorm.slice(0, 8)) ||
        titleNorm.includes(mtNorm.slice(0, 8))
      );
    });

    if (!mbTrack) {
      results.push({
        titre: track.title,
        credits: [],
        statut: "MB_TRACK_NOT_FOUND",
        sourceUrl: null,
      });
      emit("track_done", "musicbrainz", `Titre non trouve sur MB`);
      continue;
    }

    // Fetch full recording with artist-rels
    const recData = (await mbFetch(
      `https://musicbrainz.org/ws/2/recording/${mbTrack.id}?inc=artist-rels&fmt=json`
    )) as MbRecording | null;

    await sleep(MB_DELAY);

    const credits: string[] = [];
    if (recData?.relations) {
      for (const rel of recData.relations) {
        if (rel["target-type"] !== "artist") continue;
        const type = (rel.type || "").toLowerCase();
        const isProducer =
          PRODUCER_TYPES.has(type) ||
          type.includes("produc") ||
          type.includes("beat");
        const isComposer = COMPOSER_TYPES.has(type);
        if ((isProducer || isComposer) && rel.artist?.name) {
          if (!credits.includes(rel.artist.name)) {
            credits.push(rel.artist.name);
          }
        }
      }
    }

    const statut = credits.length > 0 ? "OK" : "MB_NO_CREDITS";
    results.push({
      titre: track.title,
      credits,
      statut,
      sourceUrl: `https://musicbrainz.org/recording/${mbTrack.id}`,
    });

    emit(
      "track_done",
      "musicbrainz",
      `${credits.length} credit(s) MB : ${credits.join(", ") || "aucun"}`
    );
  }

  return results;
}
