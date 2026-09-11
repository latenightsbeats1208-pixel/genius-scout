import type { Producer, EventEmitter } from "./types";
import { delay } from "@/lib/delays";

export async function verifyIdentities(
  producers: Producer[],
  emit: EventEmitter
): Promise<Producer[]> {
  for (const p of producers) {
    emit("producer_verifying", "verifier", `Verification → ${p.name}`);

    // MusicBrainz lookup
    try {
      const mbResp = await fetch(
        `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(p.name)}&fmt=json&limit=3`,
        { headers: { "User-Agent": "GeniusScout/1.0 (contact@example.com)" } }
      );
      const mbData = await mbResp.json();
      const artist = mbData.artists?.[0];
      if (artist && artist.score > 80) {
        p.musicbrainz_url = `https://musicbrainz.org/artist/${artist.id}`;
        p.identity_confirmed = true;
        // Extract aliases
        if (artist.aliases) {
          for (const alias of artist.aliases) {
            if (alias.name && !p.aliases.includes(alias.name)) {
              p.aliases.push(alias.name);
            }
          }
        }
        emit("producer_verified", "verifier", `${p.name} confirme (MusicBrainz)`, {
          aliases: p.aliases,
        });
      }
    } catch {
      // MusicBrainz failed, continue
    }

    await delay.api();

    // Credits.fm lookup
    try {
      const cfResp = await fetch(
        `https://credits.fm/api/search?q=${encodeURIComponent(p.name)}`
      );
      if (cfResp.ok) {
        const cfData = await cfResp.json();
        if (cfData.results?.length > 0) {
          const match = cfData.results[0];
          p.credits_fm_url = match.url || null;
          if (match.instagram) {
            p.ig_candidates.push({
              handle: match.instagram,
              score: 10,
              source: "CREDITS_FM",
            });
            emit("ig_found", "verifier", `Credits.fm → @${match.instagram} pour ${p.name}`);
          }
          if (match.aliases) {
            for (const alias of match.aliases) {
              if (!p.aliases.includes(alias)) p.aliases.push(alias);
            }
          }
          p.identity_confirmed = true;
        }
      }
    } catch {
      // Credits.fm failed, continue
    }

    await delay.api();
  }

  return producers;
}
