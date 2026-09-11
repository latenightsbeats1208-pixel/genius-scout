/**
 * Name-correspondence scorer — the strict gate that guarantees an Instagram
 * profile actually belongs to the credited producer.
 *
 * The previous heuristic accepted a profile if ANY name token (>2 chars) showed
 * up in the bio, OR if the profile merely "looked musical". That produced many
 * false positives (random people whose bio happens to say "producer"). Here we
 * REQUIRE that the producer's name (or a known alias / quoted stage-name)
 * genuinely corresponds to the Instagram @handle OR the profile's display name.
 *
 * Match levels:
 *   strong   — handle/display-name essentially IS the producer's name
 *   moderate — substantial, unambiguous token overlap (all name tokens present)
 *   weak     — partial overlap, not trustworthy on its own
 *   none     — no meaningful correspondence
 */

export type MatchLevel = "strong" | "moderate" | "weak" | "none";

export interface NameMatchResult {
  level: MatchLevel;
  score: number; // 0..1
  reason: string;
  bestTarget: "handle" | "display_name" | "none";
}

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function cleanName(s: string): string {
  return stripDiacritics(s)
    .replace(/[‘’“”'"`]/g, "")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** lowercase, alnum-only collapse: "Jon-Jon Traxx" -> "jonjontraxx" */
function collapse(s: string): string {
  return cleanName(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** token list: "Jon-Jon Traxx" -> ["jon","jon","traxx"] */
function tokens(s: string): string[] {
  return cleanName(s)
    .toLowerCase()
    .split(/[\s\-._]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 0);
}

function extractQuotedNickname(name: string): string | null {
  const m = name.match(/[‘’“”'"`]([^‘’“”'"`]{2,40})[‘’“”'"`]/);
  return m ? m[1].trim() : null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/** similarity ratio 0..1 between two collapsed strings */
function ratio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

/**
 * Build the set of identity strings to compare against: the producer's name,
 * each alias, and any quoted stage-name embedded in the name.
 * Stop-words / generic single tokens are filtered when used alone.
 */
const GENERIC_TOKENS = new Set([
  "dj",
  "the",
  "lil",
  "young",
  "big",
  "mr",
  "ii",
  "iii",
  "jr",
  "sr",
  "prod",
  "beats",
  "music",
  "official",
]);

interface Identity {
  collapsed: string;
  tokens: string[];
  raw: string;
}

/**
 * Producer handles almost never are just the bare name — they carry a
 * profession affix: @prodbyrowan, @damooprod, @damnfraka, @gyzbanksitin,
 * @mikewavvsmusic, @itsthedlo. Requiring a bare-name match rejected all of
 * these. Stripping a KNOWN affix and matching the remainder is strong evidence
 * (the affix itself signals a producer account, not a random namesake).
 */
const HANDLE_PREFIXES = [
  "prodby",
  "beatsby",
  "producedby",
  "prod",
  "beats",
  "beat",
  "official",
  "itsthe",
  "its",
  "iam",
  "im",
  "the",
  "damn",
  "dj",
  "mr",
  "young",
  "real",
  "therealest",
  "thereal",
];

const HANDLE_SUFFIXES = [
  "prod",
  "prods",
  "production",
  "productions",
  "producer",
  "beats",
  "beatz",
  "beat",
  "music",
  "muzik",
  "official",
  "onthebeat",
  "onthetrack",
  "ontheboards",
  "sounds",
  "audio",
  "tv",
  "hq",
  "worldwide",
  "global",
];

/**
 * All plausible "core name" readings of a handle: the raw collapsed form plus
 * every form obtained by stripping a known producer affix (and trailing digits
 * / separators, e.g. @macshooter49 → macshooter).
 */
export function handleCoreVariants(handle: string): string[] {
  const base = collapse(handle);
  const out = new Set<string>();
  if (!base) return [];
  out.add(base);

  // Trailing digits are almost always filler (@macshooter49, @rance1500)
  const noDigits = base.replace(/\d+$/, "");
  if (noDigits.length >= 3) out.add(noDigits);

  for (const seed of [base, noDigits]) {
    if (!seed) continue;
    for (const p of HANDLE_PREFIXES) {
      if (seed.startsWith(p) && seed.length - p.length >= 3) {
        out.add(seed.slice(p.length));
      }
    }
    for (const s of HANDLE_SUFFIXES) {
      if (seed.endsWith(s) && seed.length - s.length >= 3) {
        out.add(seed.slice(0, seed.length - s.length));
      }
    }
  }

  // One more pass so prefix+suffix combos resolve (@prodrowanbeats → rowan)
  for (const v of [...out]) {
    for (const p of HANDLE_PREFIXES) {
      if (v.startsWith(p) && v.length - p.length >= 3) out.add(v.slice(p.length));
    }
    for (const s of HANDLE_SUFFIXES) {
      if (v.endsWith(s) && v.length - s.length >= 3) {
        out.add(v.slice(0, v.length - s.length));
      }
    }
  }

  return [...out].filter((v) => v.length >= 3);
}

export function buildIdentities(name: string, aliases: string[]): Identity[] {
  const sources: string[] = [name, ...aliases];
  const nick = extractQuotedNickname(name);
  if (nick) sources.push(nick);
  for (const a of aliases) {
    const an = extractQuotedNickname(a);
    if (an) sources.push(an);
  }

  const out: Identity[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    const c = collapse(s);
    if (c.length < 2 || seen.has(c)) continue;
    seen.add(c);
    out.push({ collapsed: c, tokens: tokens(s), raw: s });
  }
  return out;
}

/**
 * Compare one identity against one target string (handle or display name).
 * Returns a numeric score and a qualitative level.
 */
function compareOne(
  identity: Identity,
  targetCollapsed: string,
  targetTokens: string[]
): { level: MatchLevel; score: number } {
  if (!identity.collapsed || !targetCollapsed) {
    return { level: "none", score: 0 };
  }

  const idC = identity.collapsed;
  const idTokensMeaningful = identity.tokens.filter(
    (t) => t.length >= 2 && !GENERIC_TOKENS.has(t)
  );

  // ── STRONG ────────────────────────────────────────────────────────────
  // Exact collapsed equality — but length-gated. A 3-4 char coincidence
  // (@tre for "Tre", @gitty for "Gitty") is NOT reliable evidence; only a
  // sufficiently long exact match is strong. Short exact matches drop to
  // moderate/weak so the arbiter requires corroboration before trusting them.
  const r = ratio(idC, targetCollapsed);
  if (idC === targetCollapsed) {
    // Alphanumeric stage names ("2one2", "vvken", "plu2onash") are highly
    // distinctive — a letters+digits collision is not a coincidence the way
    // "tre" or "gitty" is, so they stay strong at shorter lengths.
    const mixedAlnum = /\d/.test(idC) && /[a-z]/.test(idC);
    if (idC.length >= 6) return { level: "strong", score: 1 };
    if (mixedAlnum && idC.length >= 4) return { level: "strong", score: 0.95 };
    if (idC.length === 5) return { level: "moderate", score: 0.75 };
    if (idC.length === 4) return { level: "weak", score: 0.4 };
    return { level: "none", score: 0 }; // <=3 char exact is meaningless
  }
  if (r >= 0.92 && idC.length >= 6) return { level: "strong", score: r };

  // Target fully contains the full collapsed name (e.g. handle "itsjackdine"
  // contains "jackdine"). Require the name to be reasonably long to avoid
  // short coincidences ("ben" inside "benjamin...").
  if (idC.length >= 6 && targetCollapsed.includes(idC)) {
    return { level: "strong", score: 0.95 };
  }
  // Multi-token name and ALL meaningful tokens appear, in order-independent
  // fashion, inside the target collapsed string.
  if (
    idTokensMeaningful.length >= 2 &&
    idTokensMeaningful.every((t) => targetCollapsed.includes(t))
  ) {
    // first+last adjacency or full coverage → strong
    return { level: "strong", score: 0.9 };
  }

  // ── MODERATE ──────────────────────────────────────────────────────────
  // The producer name contains the target (handle is a shortened nickname,
  // e.g. name "Dernst Emile" handle "dmile") — only if target is distinctive.
  if (
    targetCollapsed.length >= 5 &&
    idC.includes(targetCollapsed) &&
    r >= 0.45
  ) {
    return { level: "moderate", score: 0.7 };
  }
  // High fuzzy ratio for medium-length single-token names.
  if (r >= 0.8 && idC.length >= 4) {
    return { level: "moderate", score: r };
  }
  // Token overlap: at least 2 meaningful tokens shared with target tokens.
  const shared = idTokensMeaningful.filter((t) =>
    targetTokens.some((tt) => tt === t || (t.length >= 4 && ratio(t, tt) >= 0.85))
  );
  if (shared.length >= 2) {
    return { level: "moderate", score: 0.68 };
  }
  // Single distinctive token that is long & unique (stage names like
  // "OHGOSHLEOTUS", "KAYTRANADA") matching exactly.
  if (
    idTokensMeaningful.length === 1 &&
    idTokensMeaningful[0].length >= 6 &&
    targetTokens.includes(idTokensMeaningful[0])
  ) {
    return { level: "moderate", score: 0.7 };
  }

  // ── WEAK ──────────────────────────────────────────────────────────────
  if (shared.length === 1 && shared[0].length >= 5) {
    return { level: "weak", score: 0.4 };
  }
  if (r >= 0.6 && idC.length >= 4) {
    return { level: "weak", score: r * 0.5 };
  }

  return { level: "none", score: 0 };
}

const LEVEL_RANK: Record<MatchLevel, number> = {
  none: 0,
  weak: 1,
  moderate: 2,
  strong: 3,
};

/**
 * Public: best name match between a producer (name + aliases) and an Instagram
 * profile (handle + display name). Returns the strongest match found.
 */
export function nameMatch(
  producerName: string,
  aliases: string[],
  handle: string,
  displayName: string
): NameMatchResult {
  const identities = buildIdentities(producerName, aliases);
  const handleC = collapse(handle);
  const handleT = tokens(handle);
  const displayC = collapse(displayName);
  const displayT = tokens(displayName);

  let best: NameMatchResult = {
    level: "none",
    score: 0,
    reason: "Aucune correspondance entre le nom et le profil",
    bestTarget: "none",
  };

  // Handle readings: raw + affix-stripped cores (@prodbyrowan → rowan)
  const cores = handleCoreVariants(handle);

  for (const id of identities) {
    const onHandle = compareOne(id, handleC, handleT);
    if (
      LEVEL_RANK[onHandle.level] > LEVEL_RANK[best.level] ||
      (LEVEL_RANK[onHandle.level] === LEVEL_RANK[best.level] &&
        onHandle.score > best.score)
    ) {
      best = {
        level: onHandle.level,
        score: onHandle.score,
        reason: `"${id.raw}" ↔ @${handle} (${onHandle.level})`,
        bestTarget: "handle",
      };
    }

    // Affix-stripped comparison. An exact hit on the core is strong evidence
    // even for a short name, because the stripped affix (prod/beats/...) is
    // itself a producer signal — "Rowan" ↔ @prodbyrowan is not a coincidence.
    for (const core of cores) {
      if (core === handleC) continue; // already covered above
      if (core !== id.collapsed) continue;
      if (id.collapsed.length < 3) continue;
      if (LEVEL_RANK.strong > LEVEL_RANK[best.level] || best.score < 0.92) {
        best = {
          level: "strong",
          score: 0.92,
          reason: `"${id.raw}" ↔ @${handle} (affixe producteur)`,
          bestTarget: "handle",
        };
      }
    }

    if (displayC) {
      const onDisplay = compareOne(id, displayC, displayT);
      if (
        LEVEL_RANK[onDisplay.level] > LEVEL_RANK[best.level] ||
        (LEVEL_RANK[onDisplay.level] === LEVEL_RANK[best.level] &&
          onDisplay.score > best.score)
      ) {
        best = {
          level: onDisplay.level,
          score: onDisplay.score,
          reason: `"${id.raw}" ↔ "${displayName}" (${onDisplay.level})`,
          bestTarget: "display_name",
        };
      }
    }
  }

  return best;
}

/** Convenience for callers that only have a handle (no profile data yet). */
export function nameMatchHandle(
  producerName: string,
  aliases: string[],
  handle: string
): NameMatchResult {
  return nameMatch(producerName, aliases, handle, "");
}
