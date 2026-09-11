import type { IgCandidate, Producer, EventEmitter } from "./types";
import { delay } from "@/lib/delays";
import { nameMatch } from "@/lib/name-match";

interface GeniusArtistHit {
  type?: string;
  result?: { id?: number; name?: string };
}

// Resolve the Genius artist id for a producer. We only accept a searched artist
// when its name STRONGLY matches the producer — the old "first artist result"
// fallback frequently grabbed the wrong artist and then confirmed that wrong
// artist's Instagram, which was a major source of false positives.
async function resolveArtistId(
  producer: Producer,
  emit: EventEmitter
): Promise<number | null> {
  if (producer.genius_artist_id) return producer.genius_artist_id;

  try {
    const searchResp = await fetch(
      `https://genius.com/api/search/multi?q=${encodeURIComponent(producer.name)}`
    );
    const searchData = await searchResp.json();

    for (const section of searchData.response?.sections || []) {
      for (const hit of (section.hits || []) as GeniusArtistHit[]) {
        if (hit.type !== "artist" || !hit.result?.id || !hit.result.name) {
          continue;
        }
        const m = nameMatch(
          producer.name,
          producer.aliases,
          "",
          hit.result.name
        );
        // Require strong/moderate name correspondence with the Genius artist.
        if (m.level === "strong" || m.level === "moderate") {
          return hit.result.id;
        }
      }
    }
  } catch {
    // search failed
  }

  emit(
    "ig_search",
    "agent_genius",
    `Aucun artiste Genius correspondant pour ${producer.name}`
  );
  return null;
}

export async function agentGenius(
  producer: Producer,
  emit: EventEmitter
): Promise<IgCandidate[]> {
  const candidates: IgCandidate[] = [];

  // An id carried by the credit itself binds the Genius page to THIS producer
  // with certainty; an id found by name search is a weaker prior. The arbiter
  // only auto-trusts the former.
  const fromCredits = Boolean(producer.genius_artist_id);
  const artistId = await resolveArtistId(producer, emit);
  if (!artistId) return candidates;

  try {
    const resp = await fetch(`https://genius.com/api/artists/${artistId}`);
    const data = await resp.json();
    const artist = data.response?.artist;

    if (artist?.instagram_name) {
      candidates.push({
        handle: artist.instagram_name,
        score: 10,
        source: fromCredits ? "GENIUS_API" : "GENIUS_API_SEARCH",
      });
      emit(
        "ig_found",
        "agent_genius",
        `Genius API → @${artist.instagram_name} pour ${producer.name}`
      );
    }

    if (artist?.twitter_name) {
      candidates.push({
        handle: artist.twitter_name,
        score: 5,
        source: "GENIUS_TWITTER",
      });
    }

    if (artist?.facebook_name) {
      candidates.push({
        handle: artist.facebook_name,
        score: 3,
        source: "GENIUS_FACEBOOK",
      });
    }
  } catch {
    emit("error", "agent_genius", `Erreur API Genius pour ${producer.name}`);
  }

  await delay.api();
  return candidates;
}
