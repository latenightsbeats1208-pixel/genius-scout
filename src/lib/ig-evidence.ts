import { fetchRecentPosts, type IgPost } from "./instagram";
import type { IgProfileData } from "@/agents/types";

/**
 * Evidence-based Instagram verification.
 *
 * A name match only proves that a handle LOOKS like the producer's name. It
 * cannot tell @cashen (a clothing account) from @cash3n (the actual producer),
 * nor stop @cartoons (a meme page) from being accepted for a producer called
 * "Cartoons". To assert that a profile IS the credited producer we need proof
 * the account (a) makes music and (b) ideally worked on THIS record.
 *
 * Strongest proof, in order:
 *   1. A post/bio naming the artist, the album, or one of its tracks
 *      → "@torylanez Made You Think I Was Gone…But — “Kody” [produced by Rowan]"
 *   2. A production credit anywhere ("produced by", "prod.", drum kit, mixing)
 *   3. A stated producer role in the bio + music-industry links
 * Absent all of that, we refuse to assign a handle.
 */

export interface EvidenceContext {
  producerName: string;
  aliases: string[];
  artist: string;
  album: string;
  trackTitles: string[];
}

export interface EvidenceReport {
  mentionsArtist: boolean;
  mentionsAlbum: boolean;
  mentionedTracks: string[];
  productionCredit: boolean;
  producerRole: boolean;
  musicLinks: boolean;
  offDomain: boolean;
  collaboratorHandles: string[];
  score: number;
  reasons: string[];
  postsChecked: number;
}

const ROLE_PATTERNS = [
  /\bproducer\b/i,
  /\bproducteur\b/i,
  /\bbeatmaker\b/i,
  /\bbeat\s?maker\b/i,
  /\bprod\b/i,
  /\bmixing\b/i,
  /\bmixer\b/i,
  /\bmastering\b/i,
  /\bmasterer\b/i,
  /\bengineer\b/i,
  /\bsongwriter\b/i,
  /\bcomposer\b/i,
  /\bmusician\b/i,
  /\bmusic\b/i,
  /\bA&R\b/i,
];

const CREDIT_PATTERNS = [
  /produced\s+by/i,
  /prod(?:\.|uced)?\s*(?:by|par)/i,
  /\bprod\.\s*@/i,
  /\bon the beat\b/i,
  /\bdrum\s?kit\b/i,
  /\bout\s+now\b/i,
  /\bnew\s+(?:single|album|project|EP)\b/i,
  /\bmixed\s+by\b/i,
  /\bwrote\b.*\bfor\b/i,
  /\bplacement\b/i,
  /\bgrammy\b/i,
  /\bplatinum\b/i,
  /\bRIAA\b/i,
  /\bBillboard\b/i,
];

const MUSIC_LINK_PATTERNS = [
  /linktr\.ee/i,
  /beatstars/i,
  /soundcloud/i,
  /audiomack/i,
  /spotify/i,
  /music\.apple/i,
  /apple\s?music/i,
  /distrokid/i,
  /splice/i,
  /bandcamp/i,
  /tidal/i,
  /youtube\.com\/(?:channel|@)/i,
  /open\.spotify/i,
];

/** Bios that clearly belong to another walk of life. */
const OFF_DOMAIN_PATTERNS = [
  /childhood one post at a time/i,
  /\bmemes?\b/i,
  /\bcartoon/i,
  /\bpizza\b/i,
  /\bwings\b/i,
  /\brestaurant\b/i,
  /\bcafe\b/i,
  /\brugby\b/i,
  /\bfootball\b/i,
  /\bbasketball\b/i,
  /\bsoccer\b/i,
  /\bfitness\b/i,
  /\bgym\b/i,
  /\breal estate\b/i,
  /\bclothing\b/i,
  /\bboutique\b/i,
  /\bnail\b/i,
  /\bhair\b/i,
  /\blashes\b/i,
  /\btravel blog/i,
  /\bgaming\b/i,
  /\bcodm\b/i,
  /\bstreamer\b/i,
];

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Track titles short or generic enough to match by accident. */
function isDistinctiveTitle(title: string): boolean {
  const n = norm(title);
  if (n.length < 6) return false;
  const generic = new Set([
    "intro", "outro", "interlude", "skit", "love", "you", "me", "us",
    "alone", "home", "again", "forever", "why", "how", "run", "stay",
  ]);
  return !generic.has(n);
}

export function scoreEvidence(
  profile: IgProfileData,
  posts: IgPost[],
  ctx: EvidenceContext
): EvidenceReport {
  const bioText = [profile.nom_affiche, profile.bio, ...profile.posts_recents].join(" ");
  const postText = posts.map((p) => p.caption).join(" \n ");
  const all = `${bioText} \n ${postText}`;
  const allNorm = norm(all);

  const reasons: string[] = [];
  let score = 0;

  // ── 1. Placement proof — ties the account to THIS record ────────────
  const artistNorm = norm(ctx.artist);
  const artistCompact = artistNorm.replace(/\s/g, "");
  const mentionsArtist =
    Boolean(artistNorm) &&
    (allNorm.includes(artistNorm) ||
      (artistCompact.length >= 4 &&
        new RegExp(`@[a-z0-9._]*${artistCompact}`, "i").test(all)));
  if (mentionsArtist) {
    score += 6;
    reasons.push(`mentionne l'artiste (${ctx.artist})`);
  }

  const albumNorm = norm(ctx.album);
  const mentionsAlbum = albumNorm.length >= 6 && allNorm.includes(albumNorm);
  if (mentionsAlbum) {
    score += 6;
    reasons.push("mentionne l'album");
  }

  const mentionedTracks = ctx.trackTitles
    .filter(isDistinctiveTitle)
    .filter((t) => allNorm.includes(norm(t)));
  if (mentionedTracks.length > 0) {
    score += 6;
    reasons.push(`mentionne le(s) titre(s) : ${mentionedTracks.slice(0, 3).join(", ")}`);
  }

  // ── 2. Production credit anywhere → proves they produce ─────────────
  const productionCredit = CREDIT_PATTERNS.some((re) => re.test(all));
  if (productionCredit) {
    score += 3;
    reasons.push("crédit de production visible");
  }

  // ── 3. Declared role + industry links ──────────────────────────────
  const producerRole = ROLE_PATTERNS.some((re) => re.test(bioText));
  if (producerRole) {
    score += 2;
    reasons.push("rôle musical dans la bio");
  }

  const musicLinks = MUSIC_LINK_PATTERNS.some((re) => re.test(all));
  if (musicLinks) {
    score += 2;
    reasons.push("liens musicaux");
  }

  // ── 4. Negative signal ─────────────────────────────────────────────
  const offDomain =
    OFF_DOMAIN_PATTERNS.some((re) => re.test(bioText)) && !producerRole && !productionCredit;
  if (offDomain) {
    score -= 8;
    reasons.push("bio hors domaine musical");
  }

  // Harvest collaborator handles from credit captions — these are the REAL
  // handles of the other producers on the record, even when their credited
  // name differs from their social handle.
  const collaboratorHandles = [
    ...new Set(
      posts
        .filter((p) => CREDIT_PATTERNS.some((re) => re.test(p.caption)))
        .flatMap((p) => p.tagged)
    ),
  ];

  return {
    mentionsArtist,
    mentionsAlbum,
    mentionedTracks,
    productionCredit,
    producerRole,
    musicLinks,
    offDomain,
    collaboratorHandles,
    score,
    reasons,
    postsChecked: posts.length,
  };
}

export interface EvidenceVerdict {
  decision: "OUI" | "PROBABLE" | "NON";
  confidence: number;
  raison: string;
  report: EvidenceReport;
}

/** Turn the evidence report into a decision. */
export function decideFromEvidence(report: EvidenceReport): EvidenceVerdict {
  const placement =
    report.mentionsArtist || report.mentionsAlbum || report.mentionedTracks.length > 0;

  if (report.offDomain && !placement) {
    return {
      decision: "NON",
      confidence: 0,
      raison: `Profil hors domaine musical (${report.reasons.join(", ") || "aucun signal"})`,
      report,
    };
  }

  if (placement) {
    return {
      decision: "OUI",
      confidence: 0.97,
      raison: `Placement prouvé — ${report.reasons.join(", ")}`,
      report,
    };
  }

  if (report.productionCredit && (report.producerRole || report.musicLinks)) {
    return {
      decision: "OUI",
      confidence: 0.88,
      raison: `Producteur avéré — ${report.reasons.join(", ")}`,
      report,
    };
  }

  if (report.productionCredit || (report.producerRole && report.musicLinks)) {
    return {
      decision: "PROBABLE",
      confidence: 0.75,
      raison: `Signaux musicaux — ${report.reasons.join(", ")}`,
      report,
    };
  }

  if (report.producerRole) {
    return {
      decision: "PROBABLE",
      confidence: 0.65,
      raison: `Rôle musical déclaré uniquement — ${report.reasons.join(", ")}`,
      report,
    };
  }

  // No music evidence at all: refuse rather than hand over a wrong contact.
  return {
    decision: "NON",
    confidence: 0,
    raison: "Aucune preuve musicale sur le profil",
    report,
  };
}

/**
 * Gather evidence for a candidate. Post captions cost several page loads, so we
 * only pay for them when the bio alone hasn't already proven the placement.
 */
export async function gatherEvidence(
  profile: IgProfileData,
  ctx: EvidenceContext,
  opts: { maxPosts?: number } = {}
): Promise<EvidenceVerdict> {
  const bioOnly = scoreEvidence(profile, [], ctx);
  const provenByBio =
    bioOnly.mentionsArtist || bioOnly.mentionsAlbum || bioOnly.mentionedTracks.length > 0;

  if (provenByBio || profile.est_prive) {
    return decideFromEvidence(bioOnly);
  }

  const posts = await fetchRecentPosts(profile.handle, opts.maxPosts ?? 3);
  const full = scoreEvidence(profile, posts, ctx);
  return decideFromEvidence(full);
}
