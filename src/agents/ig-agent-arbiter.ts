import type {
  IgCandidate,
  IgProfileData,
  IgValidation,
  Producer,
  EventEmitter,
} from "./types";
import { createPage } from "@/lib/browser";
import { delay } from "@/lib/delays";
import { db } from "@/lib/db";
import { normalizeProducerName, CACHE_TTL, isFreshRun } from "@/lib/cache";
import { fetchInstagramProfile } from "@/lib/instagram";
import { gatherEvidence, type EvidenceContext } from "@/lib/ig-evidence";
import {
  nameMatch,
  nameMatchHandle,
  type NameMatchResult,
} from "@/lib/name-match";
import Anthropic from "@anthropic-ai/sdk";

const PRODUCER_CACHE_FRESH_MS = CACHE_TTL.PRODUCER_IG * 1000;

// ───────────────────────────────────────────────────────────────────────────
// Candidate merge
// ───────────────────────────────────────────────────────────────────────────
export function mergeCandidates(
  geniusCandidates: IgCandidate[],
  googleCandidates: IgCandidate[]
): IgCandidate[] {
  const all = [...geniusCandidates, ...googleCandidates];
  const map = new Map<string, { handle: string; score: number; sources: string[] }>();

  for (const c of all) {
    const key = c.handle.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.score += c.score;
      if (!existing.sources.includes(c.source)) {
        existing.sources.push(c.source);
        existing.score += 3; // multi-source bonus
      }
    } else {
      map.set(key, { handle: c.handle, score: c.score, sources: [c.source] });
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((e) => ({
      handle: e.handle,
      score: e.score,
      source: e.sources.join("+"),
    }));
}

// ───────────────────────────────────────────────────────────────────────────
// Profile extraction (async curl first, Playwright fallback)
// ───────────────────────────────────────────────────────────────────────────
async function extractProfileViaCurl(handle: string): Promise<IgProfileData | null> {
  // Goes through the Instagram access layer: curl when usable, otherwise the
  // logged-in Chrome (curl is currently hard-blocked by Instagram).
  const raw = await fetchInstagramProfile(handle);
  if (!raw) return null;
  return {
    existe: true,
    handle: raw.username,
    nom_affiche: raw.fullName,
    bio: raw.bio,
    followers:
      raw.followers !== null ? raw.followers.toLocaleString() : "inconnu",
    posts_recents: raw.posts,
    est_prive: raw.isPrivate,
  };
}

async function extractProfilePlaywright(handle: string): Promise<IgProfileData | null> {
  let page;
  try {
    page = await createPage();
    await page.goto(`https://www.instagram.com/${handle}/`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await delay.medium();

    const data = await page.evaluate(() => {
      const body = document.body.innerText || "";
      if (body.includes("Page Not Found") || body.includes("page isn't available")) {
        return null;
      }
      const nomAffiche =
        document.querySelector("header h2, header h1")?.textContent?.trim() ||
        document.querySelector('[class*="ProfileName"]')?.textContent?.trim() ||
        "";
      const bio =
        document
          .querySelector('header [class*="bio"], header section > div:nth-child(3)')
          ?.textContent?.trim() ||
        document.querySelector('[class*="-note"]')?.textContent?.trim() ||
        "";
      const followersEl =
        document.querySelector('a[href*="followers"] span, [title][class*="followers"]') ||
        document.querySelector("ul li:nth-child(2) span");
      const followers =
        followersEl?.getAttribute("title") || followersEl?.textContent?.trim() || "inconnu";
      const estPrive =
        body.includes("Ce compte est privé") || body.includes("This account is private");
      const posts: string[] = [];
      const images = document.querySelectorAll("article img[alt], main img[alt]");
      for (const img of images) {
        const alt = img.getAttribute("alt") || "";
        if (alt.length > 15 && !alt.toLowerCase().includes("photo de profil")) {
          posts.push(alt.slice(0, 200));
          if (posts.length >= 9) break;
        }
      }
      return { nomAffiche, bio, followers, estPrive, posts };
    });

    if (!data) return null;
    return {
      existe: true,
      handle,
      nom_affiche: data.nomAffiche,
      bio: data.bio,
      followers: data.followers,
      posts_recents: data.posts,
      est_prive: data.estPrive,
    };
  } catch {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function extractProfile(handle: string): Promise<IgProfileData | null> {
  const viaCurl = await extractProfileViaCurl(handle);
  if (viaCurl) return viaCurl;
  return extractProfilePlaywright(handle);
}

// ───────────────────────────────────────────────────────────────────────────
// Context signals (corroboration on top of the name gate)
// ───────────────────────────────────────────────────────────────────────────
const MUSIC_KEYWORDS = [
  "produc",
  "beat",
  "studio",
  "mix",
  "master",
  "engineer",
  "songwriter",
  "song writer",
  "music",
  "musician",
  "instrument",
  "808",
  "grammy",
  "riaa",
  "platinum",
  "ascap",
  "bmi",
  "records",
  "recording",
  "@",
];

interface ContextSignals {
  music: boolean;
  mentionsArtist: boolean;
  verified: boolean;
}

function computeContext(profile: IgProfileData, artist: string): ContextSignals {
  const allText = [profile.nom_affiche, profile.bio, ...profile.posts_recents]
    .join(" ")
    .toLowerCase();
  const music = MUSIC_KEYWORDS.some((k) => allText.includes(k));
  const artistTokens = artist
    .toLowerCase()
    .split(/[\s,&]+/)
    .filter((t) => t.length >= 4);
  const mentionsArtist = artistTokens.some((t) => allText.includes(t));
  // The curl profile path doesn't expose is_verified into IgProfileData; treat
  // a "verified" mention in bio as a weak proxy. (Kept false by default.)
  const verified = false;
  return { music, mentionsArtist, verified };
}

// ───────────────────────────────────────────────────────────────────────────
// Validation — name gate is mandatory
// ───────────────────────────────────────────────────────────────────────────
export type ValidationMode = "heuristic" | "llm";

interface Verdict {
  decision: "OUI" | "NON" | "PROBABLE";
  confidence: number;
  raison: string;
  match: NameMatchResult;
}

/**
 * Verdict = name gate AND evidence.
 *
 * The name gate alone accepted @cartoons (a meme page) for a producer called
 * "Cartoons" and @pdubbz (a pizzeria) for "P.Dubbz". A handle is only assigned
 * when the profile also PROVES it makes music — ideally by naming this very
 * record. No proof ⇒ no contact, on purpose: a blank is cheaper to fix than a
 * wrong contact in the database.
 */
async function evidenceValidate(
  producer: Producer,
  evCtx: EvidenceContext,
  profile: IgProfileData,
  candidate: IgCandidate,
  collect?: string[]
): Promise<Verdict> {
  const match = nameMatch(
    producer.name,
    producer.aliases,
    profile.handle,
    profile.nom_affiche
  );

  if (match.level === "none" || match.level === "weak") {
    return {
      decision: "NON",
      confidence: 0,
      raison: `Nom ne correspond pas (${match.level})`,
      match,
    };
  }

  const verdict = await gatherEvidence(profile, evCtx);
  // Credit captions name the OTHER producers on the record with their real
  // handles ("[produced by Rowan, @calig_ @_2one2 @cash3n]"). Harvest them:
  // that is how we reach a producer whose credited name differs from his handle.
  if (collect) {
    for (const h of verdict.report.collaboratorHandles) {
      if (!collect.includes(h)) collect.push(h);
    }
  }
  const officialSource = candidate.source.includes("GENIUS_API");

  if (verdict.decision === "NON") {
    // Genius' declared instagram_name is an artist-published link; trust it as
    // "probable" even when the profile is too sparse to prove anything.
    if (officialSource && match.level === "strong") {
      return {
        decision: "PROBABLE",
        confidence: 0.7,
        raison: "Lien déclaré sur Genius (profil sans preuve exploitable)",
        match,
      };
    }
    // Strong name + a handle several sources agree on, but the profile exposes
    // nothing readable (private, no bio, no captions). Dropping these lost real
    // producers the user could identify by eye — e.g. Frank Rose (@frankrose)
    // and Davion Farris (@davion_farris) on Kenyon Dixon's album. Surface them
    // at LOW confidence so they stay visible for a manual look without counting
    // as found (isCounted requires >= 0.6) or polluting confirmed contacts.
    if (match.level === "strong" && candidate.score >= 7) {
      return {
        decision: "PROBABLE",
        confidence: 0.45,
        raison: "Nom fort mais profil sans contenu lisible — À VÉRIFIER À LA MAIN",
        match,
      };
    }

    return {
      decision: "NON",
      confidence: 0,
      raison: verdict.raison,
      match,
    };
  }

  // A moderate name match needs real placement proof to be promoted.
  const placementProven =
    verdict.report.mentionsArtist ||
    verdict.report.mentionsAlbum ||
    verdict.report.mentionedTracks.length > 0;

  if (match.level === "moderate" && verdict.decision === "OUI" && !placementProven) {
    return {
      decision: "PROBABLE",
      confidence: Math.min(verdict.confidence, 0.72),
      raison: `${verdict.raison} (nom modéré)`,
      match,
    };
  }

  let confidence = verdict.confidence;
  if (officialSource && verdict.decision === "OUI") {
    confidence = Math.min(0.98, confidence + 0.02);
  }

  return {
    decision: verdict.decision,
    confidence,
    raison: verdict.raison,
    match,
  };
}

// LLM validation is also gated: even if Claude says OUI, the name match must be
// at least moderate. Claude is used to break ties / add nuance, never to
// override a missing name correspondence.
async function llmValidate(
  producer: Producer,
  artist: string,
  evCtx: EvidenceContext,
  profile: IgProfileData,
  candidate: IgCandidate
): Promise<Verdict> {
  const match = nameMatch(
    producer.name,
    producer.aliases,
    profile.handle,
    profile.nom_affiche
  );

  // Cheap rejection — don't spend a Claude call on an impossible match.
  if (match.level === "none" || match.level === "weak") {
    return {
      decision: "NON",
      confidence: 0,
      raison: `Nom ne correspond pas (${match.level})`,
      match,
    };
  }

  try {
    const anthropic = new Anthropic();
    // Consigne stable en `system` (mise en cache par l'API) ; le cas en `user`.
    // Règle de calibration (issue de l'analyse du prompt Fable 5.1, 09/2026) :
    // la confiance annoncée ne dépasse jamais le niveau de preuve observé.
    const system = `Tu es un vérificateur STRICT d'identité de producteurs musicaux. Ton rôle est d'éviter les faux positifs : en cas de doute, réponds NON.

CALIBRATION — ta confiance ne dépasse jamais la preuve :
- Une seule coïncidence (le nom, ou un mot-clé musical) vaut PROBABLE au mieux, jamais OUI.
- OUI exige deux preuves indépendantes visibles dans le profil : nom correspondant ET (mention de l'artiste, d'un titre produit, ou d'un collaborateur).
- N'infère rien de ce que le profil ne montre pas : un compte privé, une bio vide ou des posts absents sont une absence de preuve, pas un indice.
- La "raison" cite le fait observé (« bio mentionne "prod for X" »), jamais une impression (« semble être un producteur »).
- Réponds UNIQUEMENT par le JSON demandé, sans texte autour.`;
    const prompt = `PRODUCTEUR RECHERCHÉ : "${producer.name}"
Alias connus : ${producer.aliases.join(", ") || "aucun"}
Collabore avec l'artiste : ${artist}
Titres produits : ${producer.track_titles.slice(0, 5).join(", ") || "?"}

PROFIL INSTAGRAM ANALYSÉ : @${profile.handle}
- Nom affiché : ${profile.nom_affiche || "(vide)"}
- Bio : ${profile.bio || "(vide)"}
- Followers : ${profile.followers}
- Compte privé : ${profile.est_prive ? "oui" : "non"}
- Posts récents : ${profile.posts_recents.slice(0, 5).join(" | ") || "(aucun)"}

Correspondance de nom calculée : ${match.level} (${match.reason})

RÈGLES :
1. Le handle OU le nom affiché doit correspondre clairement au nom/alias du producteur. Sinon → NON.
2. Un profil "musical" mais dont le NOM ne correspond pas → NON (c'est un piège fréquent).
3. OUI seulement si tu es vraiment confiant (nom qui correspond + indice musical OU mention de l'artiste/collaborateurs). confidence >= 0.85.
4. PROBABLE si le nom correspond mais sans autre indice.

Réponds UNIQUEMENT en JSON : {"decision":"OUI"|"NON"|"PROBABLE","raison":"1 phrase","confidence":0.0-1.0}`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as IgValidation;
      // Gate the LLM: it can only DOWNGRADE a missing name match, never upgrade.
      if (
        (parsed.decision === "OUI" || parsed.decision === "PROBABLE") &&
        match.level !== "strong" &&
        match.level !== "moderate"
      ) {
        return {
          decision: "NON",
          confidence: 0,
          raison: "LLM positif mais nom insuffisant",
          match,
        };
      }
      return {
        decision: parsed.decision,
        confidence: parsed.confidence,
        raison: parsed.raison,
        match,
      };
    }
  } catch {
    // fall through to evidence
  }
  return evidenceValidate(producer, evCtx, profile, candidate);
}

async function validate(
  producer: Producer,
  artist: string,
  evCtx: EvidenceContext,
  profile: IgProfileData,
  candidate: IgCandidate,
  mode: ValidationMode,
  collect?: string[]
): Promise<Verdict> {
  // Evidence first: it is both cheaper and more decisive than an LLM opinion.
  const evidence = await evidenceValidate(producer, evCtx, profile, candidate, collect);
  if (mode !== "llm") return evidence;
  // Only bother Claude on the ambiguous middle ground.
  if (evidence.decision === "OUI" && evidence.confidence >= 0.9) return evidence;
  if (evidence.decision === "NON" && evidence.confidence === 0) return evidence;
  return llmValidate(producer, artist, evCtx, profile, candidate);
}

// ───────────────────────────────────────────────────────────────────────────
// Result + cross-scan cache
// ───────────────────────────────────────────────────────────────────────────
type ArbiterResult = {
  instagram: string | null;
  ig_status: "confirmed" | "probable" | "not_found";
  ig_confidence: number;
  ig_profile_data: IgProfileData | null;
  ig_validation: IgValidation | null;
  ig_candidates: IgCandidate[];
};

function tryProducerCache(producer: Producer, emit: EventEmitter): ArbiterResult | null {
  // A fresh re-scan must re-verify Instagram too, not replay a stored handle.
  if (isFreshRun()) return null;
  const key = normalizeProducerName(producer.name);
  if (!key) return null;
  const row = db.getProducerCache(key);
  if (!row) return null;

  const lastVerified = new Date(row.last_verified_at as string).getTime();
  const ageMs = Date.now() - lastVerified;
  if (ageMs > PRODUCER_CACHE_FRESH_MS) return null;

  const status = row.ig_status as "confirmed" | "probable" | "not_found" | null;
  const confidence = (row.ig_confidence as number) || 0;
  const instagram = row.instagram as string | null;
  // Only serve high-confidence CONFIRMED entries from cache. "probable" hits are
  // always recomputed so an evolving algorithm never resurfaces a weak guess.
  if (status !== "confirmed" || confidence < 0.85 || !instagram) return null;

  // Re-apply the name gate to cached entries so a previously-poisoned cache
  // (from the older loose algorithm) can't resurface a wrong handle.
  const m = nameMatchHandle(producer.name, producer.aliases, instagram);
  if (m.level === "none" || m.level === "weak") {
    return null;
  }

  emit(
    "ig_arbiter",
    "arbiter",
    `${producer.name} → cache (@${instagram}, ${(confidence * 100).toFixed(0)}%, ${Math.round(ageMs / 86400000)}j)`
  );

  return {
    instagram,
    ig_status: status,
    ig_confidence: confidence,
    ig_profile_data: row.ig_profile_data
      ? (JSON.parse(row.ig_profile_data as string) as IgProfileData)
      : null,
    ig_validation: row.ig_validation
      ? (JSON.parse(row.ig_validation as string) as IgValidation)
      : null,
    ig_candidates: row.ig_candidates
      ? (JSON.parse(row.ig_candidates as string) as IgCandidate[])
      : [],
  };
}

function persistProducerCache(producer: Producer, result: ArbiterResult): void {
  const key = normalizeProducerName(producer.name);
  if (!key) return;
  if (result.ig_status === "not_found") return;
  if (result.ig_confidence < 0.7) return;

  db.upsertProducerCache({
    name_normalized: key,
    display_name: producer.name,
    instagram: result.instagram,
    genius_artist_id: producer.genius_artist_id,
    ig_status: result.ig_status,
    ig_confidence: result.ig_confidence,
    ig_profile_data: result.ig_profile_data,
    ig_validation: result.ig_validation,
    ig_candidates: result.ig_candidates,
  });
}

export interface ArbiterOptions {
  mode?: ValidationMode;
  skipCache?: boolean;
  /** Album context used to prove a placement on the profile. */
  album?: string;
  trackTitles?: string[];
  /** Accumulator: real handles of collaborators harvested from credit captions. */
  collect?: string[];
}

export async function agentArbiter(
  producer: Producer,
  artist: string,
  allCandidates: IgCandidate[],
  emit: EventEmitter,
  options: ArbiterOptions = {}
): Promise<ArbiterResult> {
  const mode: ValidationMode = options.mode || "llm";

  if (!options.skipCache) {
    const cached = tryProducerCache(producer, emit);
    if (cached) return cached;
  }

  const evCtx: EvidenceContext = {
    producerName: producer.name,
    aliases: producer.aliases,
    artist,
    album: options.album || "",
    trackTitles: options.trackTitles || producer.track_titles,
  };

  const result = await agentArbiterCore(
    producer,
    artist,
    evCtx,
    allCandidates,
    emit,
    mode,
    options.collect
  );
  persistProducerCache(producer, result);
  return result;
}

async function agentArbiterCore(
  producer: Producer,
  artist: string,
  evCtx: EvidenceContext,
  allCandidates: IgCandidate[],
  emit: EventEmitter,
  mode: ValidationMode,
  collect?: string[]
): Promise<ArbiterResult> {
  emit("ig_arbiter", "arbiter", `${allCandidates.length} candidat(s) pour ${producer.name}`);

  if (allCandidates.length === 0) {
    return {
      instagram: null,
      ig_status: "not_found",
      ig_confidence: 0,
      ig_profile_data: null,
      ig_validation: null,
      ig_candidates: [],
    };
  }

  // Pre-filter: every visit costs an Instagram page load plus pacing, so a
  // candidate must EARN its visit. The old rule visited every Google result
  // regardless of name — profiles like @___________storm got loaded only to be
  // rejected on the name a second later.
  const plausible = allCandidates.filter((c) => {
    if (c.source.includes("GENIUS_API")) return true; // official page prior
    const m = nameMatchHandle(producer.name, producer.aliases, c.handle);
    if (m.level === "strong" || m.level === "moderate") return true;
    // weak/none name: only worth a visit when several sources corroborate it.
    return c.score >= 7;
  });

  // Nothing plausible: try the top two by score rather than blindly all five.
  const ordered = (plausible.length > 0 ? plausible : allCandidates.slice(0, 2)).slice(0, 4);

  let best: { candidate: IgCandidate; profile: IgProfileData; verdict: Verdict } | null =
    null;

  for (const candidate of ordered) {
    emit("ig_arbiter", "arbiter", `Visite @${candidate.handle}...`);

    const profile = await extractProfile(candidate.handle);
    if (!profile) {
      // Profile inaccessible. Only salvage it if the HANDLE strongly matches the
      // name AND it came from the official Genius API (high prior). Never from a
      // bare guess — that's how false positives crept in.
      const m = nameMatchHandle(producer.name, producer.aliases, candidate.handle);
      if (candidate.source.includes("GENIUS_API") && m.level === "strong") {
        emit(
          "ig_arbiter",
          "arbiter",
          `@${candidate.handle} inaccessible mais Genius API + nom fort → probable`
        );
        const verdict: Verdict = {
          decision: "PROBABLE",
          confidence: 0.7,
          raison: "Genius API + handle correspond (profil non visité)",
          match: m,
        };
        if (!best || verdict.confidence > best.verdict.confidence) {
          best = {
            candidate,
            profile: {
              existe: false,
              handle: candidate.handle,
              nom_affiche: "",
              bio: "",
              followers: "inconnu",
              posts_recents: [],
              est_prive: false,
            },
            verdict,
          };
        }
      } else {
        emit("ig_arbiter", "arbiter", `@${candidate.handle} → inaccessible / ignoré`);
      }
      await delay.short();
      continue;
    }

    const verdict = await validate(
      producer,
      artist,
      evCtx,
      profile,
      candidate,
      mode,
      collect
    );

    // The credit's own Genius page named this Instagram — exactly the
    // reference the user trusts when checking by hand. A readable profile
    // without contradiction is enough; demanding placement proof on top made
    // the pipeline re-verify what Genius already vouches for.
    if (verdict.decision === "PROBABLE" && candidate.source === "GENIUS_API") {
      verdict.decision = "OUI";
      verdict.confidence = Math.max(verdict.confidence, 0.92);
      verdict.raison = `Instagram officiel de la fiche Genius du crédit — ${verdict.raison}`;
    }

    emit(
      "ig_arbiter",
      "arbiter",
      `@${candidate.handle} → ${verdict.decision} (${(verdict.confidence * 100).toFixed(0)}%) [nom:${verdict.match.level}] ${verdict.raison}`
    );

    if (verdict.decision === "OUI") {
      const result: ArbiterResult = {
        instagram: candidate.handle,
        ig_status: "confirmed",
        ig_confidence: verdict.confidence,
        ig_profile_data: profile,
        ig_validation: {
          decision: "OUI",
          raison: verdict.raison,
          confidence: verdict.confidence,
        },
        ig_candidates: allCandidates,
      };
      return result;
    }

    if (
      verdict.decision === "PROBABLE" &&
      (!best || verdict.confidence > best.verdict.confidence)
    ) {
      best = { candidate, profile, verdict };
    }

    // Instagram pacing lives inside extractProfile; between candidates a short
    // breath is enough.
    await delay.short();
  }

  if (best) {
    return {
      instagram: best.candidate.handle,
      ig_status: "probable",
      ig_confidence: best.verdict.confidence,
      ig_profile_data: best.profile,
      ig_validation: {
        decision: "PROBABLE",
        raison: best.verdict.raison,
        confidence: best.verdict.confidence,
      },
      ig_candidates: allCandidates,
    };
  }

  return {
    instagram: null,
    ig_status: "not_found",
    ig_confidence: 0,
    ig_profile_data: null,
    ig_validation: null,
    ig_candidates: allCandidates,
  };
}
