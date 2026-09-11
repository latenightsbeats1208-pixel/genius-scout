import type { GeniusAlbumResult, GeniusTrack } from "./types";

// Genius hosts translation accounts ("Genius Traducciones al Español",
// "Genius Türkçe Çeviriler", "Genius Brasil Traduções", etc.) that publish
// translated versions of albums as separate album pages. They share the
// original tracklist but link to translated lyrics and have NO production
// credits. We must filter them out so users always pick the original release.
const TRANSLATION_ARTIST_PATTERNS = [
  /^Genius\s+(Traducciones|Tradu|Tradução|Tradutores|Türkçe|Deutsche|Italian|Russian|Romanian|Polski|Polskie|Greek|France|Français|Brasil|Brazilian|Hispanic|Korean|한국어|日本語|中文|العربية|עברית|Czech|Magyar|Magyaroku|Sverige|Nederland|Suomi|Slovenský|Slovenský)/i,
  /\bÇeviri/i, // Turkish "translation"
  /\bTradução/i,
  /\bTraducción/i,
  /\bÜbersetzung/i,
  /\bПеревод/i,
  /\b翻訳/i,
  /\b번역/i,
  /\b\(Translation\)/i,
];

const TRANSLATION_TITLE_PATTERNS = [
  /\((?:Traduc|Tradução|Çeviri|Übersetzung|Tradu|Translation|Перевод|翻訳|번역)/i,
  /\b(Traducción al|Tradução em|Türkçe Çeviri|Deutsche Übersetzung)\b/i,
];

function isTranslationEntry(artist: string, title: string): boolean {
  if (!artist && !title) return false;
  if (TRANSLATION_ARTIST_PATTERNS.some((p) => p.test(artist))) return true;
  if (TRANSLATION_TITLE_PATTERNS.some((p) => p.test(title))) return true;
  // Catch-all: any artist literally starting with "Genius " is almost always
  // a translation/lyric-translation account (Genius itself uses "DrakeVEVO"
  // or the artist's name, never "Genius ...").
  if (/^Genius\s+/i.test(artist) && !/^Genius$/i.test(artist)) return true;
  return false;
}

interface GeniusHit {
  type?: string;
  result?: {
    id?: number;
    name?: string;
    full_title?: string;
    title?: string;
    artist?: { name?: string };
    artist_names?: string;
    primary_artist?: { name?: string };
    cover_art_url?: string;
    header_image_url?: string;
    url?: string;
    release_date_for_display?: string;
    album?: {
      id?: number;
      name?: string;
      full_title?: string;
      cover_art_url?: string;
      header_image_url?: string;
      url?: string;
    };
  };
}

interface GeniusSection {
  type?: string;
  hits?: GeniusHit[];
}

async function fetchGeniusSections(q: string): Promise<GeniusSection[]> {
  try {
    const resp = await fetch(
      `https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      response?: { sections?: GeniusSection[] };
    };
    return data.response?.sections || [];
  } catch {
    return [];
  }
}

export async function searchAlbums(query: string): Promise<GeniusAlbumResult[]> {
  // Genius's relevance ranking is order-sensitive: "drake habibti" returns
  // translation pages first while "habibti drake" returns the original album.
  // To work around this, query both orderings (and a reversed variant for
  // 3+ word queries) and merge results.
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const queries = new Set<string>([query]);
  if (tokens.length >= 2) {
    queries.add([...tokens].reverse().join(" "));
  }
  if (tokens.length >= 3) {
    // Try last-word-first too (often the album title is at the end)
    queries.add([tokens[tokens.length - 1], ...tokens.slice(0, -1)].join(" "));
  }

  const allSections: GeniusSection[] = [];
  for (const q of queries) {
    const sections = await fetchGeniusSections(q);
    allSections.push(...sections);
  }

  const albums: GeniusAlbumResult[] = [];
  const seen = new Set<number>();

  for (const section of allSections) {
    for (const hit of section.hits || []) {
      // Collect albums directly
      if (hit.type === "album" && hit.result && hit.result.id) {
        const a = hit.result;
        const artistName = a.artist?.name || "";
        const albumTitle = a.name || a.full_title || "";
        if (isTranslationEntry(artistName, albumTitle)) continue;
        if (!seen.has(a.id!)) {
          seen.add(a.id!);
          albums.push({
            id: a.id!,
            title: albumTitle,
            artist: artistName,
            cover_art_url: a.cover_art_url || a.header_image_url || "",
            url: a.url || "",
            release_date: a.release_date_for_display,
          });
        }
      }
      // Also collect song results to find their albums
      if (hit.type === "song" && hit.result?.album?.id) {
        const a = hit.result.album;
        const artistName =
          hit.result.artist_names || hit.result.primary_artist?.name || "";
        const albumTitle = a.name || a.full_title || "";
        if (isTranslationEntry(artistName, albumTitle)) continue;
        if (!seen.has(a.id!)) {
          seen.add(a.id!);
          albums.push({
            id: a.id!,
            title: albumTitle,
            artist: artistName,
            cover_art_url: a.cover_art_url || a.header_image_url || "",
            url: a.url || "",
          });
        }
      }
    }
  }

  return albums;
}

// Search Genius for a single song by artist + title.
// Used to enrich the tracklist with songs Genius didn't index in the album page.
export async function searchGeniusSong(
  artist: string,
  title: string
): Promise<{ id: number; url: string; title: string } | null> {
  const q = `${title} ${artist}`.trim();
  if (!q) return null;
  try {
    const resp = await fetch(
      `https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`
    );
    if (!resp.ok) return null;
    const data = await resp.json();

    const artistLower = artist.toLowerCase();
    const titleNorm = title.toLowerCase().replace(/[^a-z0-9]/g, "");

    for (const section of data.response?.sections || []) {
      if (section.type !== "song" && section.type !== "top") continue;
      for (const hit of section.hits || []) {
        if (hit.type !== "song" || !hit.result) continue;
        const s = hit.result;
        const songTitle = (s.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const songArtist = (
          s.artist_names ||
          s.primary_artist?.name ||
          ""
        ).toLowerCase();

        // Require artist OR title match (avoids picking unrelated songs with same name)
        const artistMatch =
          songArtist.includes(artistLower) ||
          artistLower.includes(songArtist.split(/[\s,&]/)[0] || "_____");
        const titleMatch =
          songTitle === titleNorm ||
          (titleNorm.length >= 6 && songTitle.includes(titleNorm.slice(0, 8))) ||
          (songTitle.length >= 6 && titleNorm.includes(songTitle.slice(0, 8)));

        // Skip translation song entries
        if (isTranslationEntry(songArtist, s.title || "")) continue;

        if (artistMatch && titleMatch) {
          return { id: s.id, url: s.url, title: s.title };
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function getAlbumTracks(albumId: number): Promise<{
  tracks: GeniusTrack[];
  artist: string;
  album: string;
  albumArtUrl: string;
}> {
  // Fetch album metadata
  const albumResp = await fetch(`https://genius.com/api/albums/${albumId}`);
  const albumData = await albumResp.json();
  const album = albumData.response?.album;

  if (!album) throw new Error("Album not found on Genius");

  // Fetch tracks via dedicated endpoint
  const tracksResp = await fetch(`https://genius.com/api/albums/${albumId}/tracks`);
  const tracksData = await tracksResp.json();

  const tracks: GeniusTrack[] = [];
  for (const t of tracksData.response?.tracks || []) {
    const s = t.song;
    if (s) {
      tracks.push({
        title: s.title,
        genius_song_id: s.id,
        url: s.url,
      });
    }
  }

  return {
    tracks,
    artist: album.artist?.name || album.primary_artist_names || "",
    album: album.name || "",
    albumArtUrl: album.cover_art_url || "",
  };
}
