import type { ProducerCredit, Producer } from "./types";

/**
 * Genius appends a disambiguating role to some artist names:
 *   "Gyz (Producer)", "Kevin Mitchell (Producer)", "DAMOO (Producer)"
 * Left in place, that suffix breaks dedup (Gyz vs "Gyz (Producer)" become two
 * producers) and wrecks the Instagram handle search. Strip trailing role
 * parentheses while preserving genuine stage names like "2one2" or "VV$ KEN".
 */
const ROLE_SUFFIX =
  /\s*\((?:producer|prod|production|co-producer|composer|writer|songwriter|musician|artist|rapper|singer|beats?|mixer|engineer)\)\s*$/i;

export function cleanCreditName(raw: string): string {
  let name = raw.trim();
  // A name can carry more than one suffix, e.g. "X (Producer) (Rapper)"
  let previous: string;
  do {
    previous = name;
    name = name.replace(ROLE_SUFFIX, "").trim();
  } while (name !== previous);
  return name.replace(/\s+/g, " ").trim();
}

/** Names that are never real producers (label/rights metadata leaking in). */
const NON_PERSON = [
  /^(copyright|phonographic|label|distributor|publisher)\b/i,
  /^℗|^©/,
  /^various artists$/i,
  /^unknown$/i,
];

export function isPlausibleProducerName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 60) return false;
  if (NON_PERSON.some((re) => re.test(name))) return false;
  // Require at least one letter (rejects stray numbers/punctuation)
  return /[a-zA-Z]/.test(name);
}

/**
 * Grouping key — aggressive on purpose. Accents, punctuation, spacing and
 * "prod by" prefixes vary per source ("A.G. Cook" / "AG Cook", "88-Keys" /
 * "88 Keys"), and every variant became its own row: the user saw the same
 * producer listed several times per album. Collapsing to bare alphanumerics
 * merges them; two genuinely different producers sharing a collapsed key is
 * far rarer than one producer written two ways.
 */
export function normalizeCreditKey(raw: string): string {
  return cleanCreditName(raw)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^(?:prod(?:uced)?\.?\s*by|beats?\s*by)\s+/i, "")
    .replace(/[^a-z0-9]/g, "");
}

interface SourceResults {
  source: string; // "GENIUS" | "SPOTIFY" | "MUSICBRAINZ" | "DISCOGS"
  results: ProducerCredit[];
}

export function mergeCredits(...sources: SourceResults[]): Producer[] {
  const map = new Map<
    string,
    {
      name: string;
      geniusNamed: boolean;
      variants: Set<string>;
      sources: Set<string>;
      titles: Set<string>;
      genius_artist_id: number | null;
    }
  >();

  for (const { source, results } of sources) {
    for (const r of results) {
      for (const rawCredit of r.credits) {
        const credit = cleanCreditName(rawCredit);
        if (!isPlausibleProducerName(credit)) continue;
        const key = normalizeCreditKey(credit);
        if (!key) continue;
        // Genius artist ids are keyed on the RAW name, so match on both forms.
        const findId = () =>
          r.genius_artist_ids?.find(
            (e) =>
              normalizeCreditKey(e.name) === key
          );
        const existing = map.get(key);
        if (existing) {
          existing.sources.add(source);
          existing.titles.add(r.titre);
          existing.variants.add(credit);
          if (source === "GENIUS") {
            // Genius publishes the alias producers actually use; Spotify often
            // carries the legal name, which wrecks the Instagram hunt. The
            // Genius spelling wins as display name.
            if (!existing.geniusNamed) {
              existing.name = credit;
              existing.geniusNamed = true;
            }
            if (!existing.genius_artist_id) {
              const idEntry = findId();
              if (idEntry) existing.genius_artist_id = idEntry.genius_artist_id;
            }
          }
        } else {
          const idEntry = source === "GENIUS" ? findId() : null;
          map.set(key, {
            name: credit,
            geniusNamed: source === "GENIUS",
            variants: new Set([credit]),
            sources: new Set([source]),
            titles: new Set([r.titre]),
            genius_artist_id: idEntry?.genius_artist_id || null,
          });
        }
      }
    }
  }

  return Array.from(map.values()).map((entry) => ({
    name: entry.name,
    // Other spellings met along the way — the Instagram agents match on them.
    aliases: Array.from(entry.variants).filter((v) => v !== entry.name),
    sources: Array.from(entry.sources),
    double_source: entry.sources.size > 1,
    genius_artist_id: entry.genius_artist_id,
    track_titles: Array.from(entry.titles),
    instagram: null,
    ig_candidates: [],
    ig_status: "pending" as const,
    ig_confidence: 0,
    ig_profile_data: null,
    ig_validation: null,
    identity_confirmed: false,
    credits_fm_url: null,
    musicbrainz_url: null,
  }));
}
