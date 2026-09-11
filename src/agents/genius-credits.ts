import type { ProducerCredit, EventEmitter } from "./types";
import { delay } from "@/lib/delays";
import { withCache, makeKey, CACHE_TTL } from "@/lib/cache";

interface GeniusArtistRef {
  id?: number;
  name?: string;
}

interface GeniusCustomPerformance {
  label?: string;
  artists?: GeniusArtistRef[];
}

interface GeniusSong {
  url?: string;
  description?: { plain?: string } | string;
  primary_artist?: { name?: string };
  producer_artists?: GeniusArtistRef[];
  writer_artists?: GeniusArtistRef[];
  custom_performances?: GeniusCustomPerformance[];
}

interface GeniusSongApiResponse {
  response?: { song?: GeniusSong };
}

// Match labels that indicate production/composition credits
const CREDIT_LABEL_PATTERNS = [
  /produc/i,        // Producer, Co-producer, Executive producer
  /\bbeat/i,        // Beat by, Beats
  /compos/i,        // Composer, Composed by
  /\bwrit/i,        // Writer, Written by
  /\bmix/i,         // Mixed by
  /\bengineer/i,    // Engineer
  /\barrang/i,      // Arranger
  /\binstrument/i,  // Instrumentation
  /^additional/i,   // Additional production
  /co-prod/i,
];

function isCreditRole(label: string): boolean {
  return CREDIT_LABEL_PATTERNS.some((p) => p.test(label));
}

// Strip HTML and extract producer names from text patterns like "Produced by X & Y"
function extractFromTextPatterns(text: string): string[] {
  const out = new Set<string>();
  if (!text) return [];

  // Remove HTML tags
  const clean = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  const patterns = [
    /(?:Produced|Production|Beat|Composed|Written|Mixed|Engineered)\s+by\s*:?\s*([^.,;:\n(]+(?:[,&]\s*[^.,;:\n(]+)*)/gi,
    /(?:Producer|Beatmaker|Composer)s?\s*:\s*([^.,;:\n(]+(?:[,&]\s*[^.,;:\n(]+)*)/gi,
  ];

  for (const re of patterns) {
    const matches = clean.matchAll(re);
    for (const m of matches) {
      const names = m[1]
        .split(/[,&]|\band\b|\bet\b/i)
        .map((n) => n.trim())
        .filter((n) => n.length > 1 && n.length < 60 && !/\d{2,}/.test(n));
      names.forEach((n) => out.add(n));
    }
  }

  return Array.from(out);
}

export async function extractGeniusCredits(
  tracks: { title: string; genius_song_id: number }[],
  emit: EventEmitter
): Promise<ProducerCredit[]> {
  const results: ProducerCredit[] = [];

  for (const track of tracks) {
    emit("track_processing", "genius", `Genius → "${track.title}"`, {
      title: track.title,
    });

    try {
      const data = await withCache<GeniusSongApiResponse | null>(
        makeKey("genius_song", track.genius_song_id),
        "genius",
        CACHE_TTL.GENIUS_SONG,
        async () => {
          const resp = await fetch(
            `https://genius.com/api/songs/${track.genius_song_id}?text_format=plain`
          );
          if (!resp.ok) return null;
          return (await resp.json()) as GeniusSongApiResponse;
        }
      );
      const song = data?.response?.song;

      const credits = new Set<string>();
      const geniusArtistIds: { name: string; genius_artist_id: number }[] = [];

      // 1. producer_artists (structured, highest priority)
      for (const a of song?.producer_artists || []) {
        if (a.name) {
          credits.add(a.name);
          if (a.id) geniusArtistIds.push({ name: a.name, genius_artist_id: a.id });
        }
      }

      // 2. writer_artists (composers - often double as producers in modern music)
      const primaryArtistName = song?.primary_artist?.name?.toLowerCase();
      for (const a of song?.writer_artists || []) {
        if (a.name && a.name.toLowerCase() !== primaryArtistName) {
          credits.add(a.name);
          if (a.id) geniusArtistIds.push({ name: a.name, genius_artist_id: a.id });
        }
      }

      // 3. custom_performances - scan all roles matching producer/composer keywords
      for (const perf of song?.custom_performances || []) {
        if (perf.label && isCreditRole(perf.label)) {
          for (const a of perf.artists || []) {
            if (a.name) {
              credits.add(a.name);
              if (a.id) geniusArtistIds.push({ name: a.name, genius_artist_id: a.id });
            }
          }
        }
      }

      // 4. Fallback: parse song description text for "Produced by X" patterns
      if (credits.size === 0) {
        const desc = song?.description;
        let description = "";
        if (typeof desc === "string") description = desc;
        else if (desc && typeof desc === "object" && desc.plain) description = desc.plain;
        const fromText = extractFromTextPatterns(description);
        fromText.forEach((n) => credits.add(n));
      }

      // 5. Last resort: scrape the song page HTML for credits section
      if (credits.size === 0 && song?.url) {
        try {
          const pageResp = await fetch(song.url, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (compatible; GeniusScout/1.0)",
              Accept: "text/html",
            },
          });
          if (pageResp.ok) {
            const html = await pageResp.text();
            // Search inside the credits section
            const creditsMatch = html.match(/[Cc]redits[\s\S]{0,3000}/);
            if (creditsMatch) {
              const fromPage = extractFromTextPatterns(creditsMatch[0]);
              fromPage.forEach((n) => credits.add(n));
            }
            // Look in song header / metadata for "Produced by X"
            const fromTopText = extractFromTextPatterns(
              html.slice(0, 8000)
            );
            fromTopText.forEach((n) => credits.add(n));
          }
        } catch {
          // ignore page scrape failures
        }
      }

      const finalCredits = Array.from(credits);
      const statut = finalCredits.length > 0 ? "OK" : "GENIUS_NO_CREDITS";

      results.push({
        titre: track.title,
        credits: finalCredits,
        statut,
        sourceUrl: song?.url || null,
        genius_artist_ids: geniusArtistIds,
      });

      emit(
        "track_done",
        "genius",
        `${finalCredits.length} credit(s) : ${finalCredits.join(", ") || "aucun"} [${statut}]`,
        { title: track.title, credits: finalCredits, statut }
      );
    } catch (e) {
      results.push({
        titre: track.title,
        credits: [],
        statut: "ERROR",
        sourceUrl: null,
      });
      emit("error", "genius", `Erreur sur "${track.title}": ${(e as Error).message}`);
    }

    await delay.api();
  }

  return results;
}
