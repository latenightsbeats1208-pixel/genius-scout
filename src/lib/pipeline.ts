import { db } from "@/lib/db";
import { extractGeniusCredits } from "@/agents/genius-credits";
import { extractSpotifyCredits } from "@/agents/spotify-credits";
import { extractMusicbrainzCredits } from "@/agents/musicbrainz-credits";
import { extractDiscogsCredits } from "@/agents/discogs-credits";
import { mergeCredits } from "@/agents/credit-merger";
import { verifyIdentities } from "@/agents/identity-verifier";
import { agentGenius } from "@/agents/ig-agent-genius";
import { agentGoogle } from "@/agents/ig-agent-google";
import {
  mergeCandidates,
  agentArbiter,
  type ValidationMode,
} from "@/agents/ig-agent-arbiter";
import { checkHealth } from "@/lib/preflight";
import { resetBrowser } from "@/lib/browser";
import { runFresh } from "@/lib/cache";
import { nameMatchHandle } from "@/lib/name-match";
import type {
  EventEmitter,
  Producer,
  IgCandidate,
  IgProfileData,
  IgValidation,
} from "@/agents/types";

/** Raised when a scan was reaped/abandoned while still running. */
export class ScanAbortedError extends Error {
  constructor(scanId: string) {
    super(`Scan ${scanId} abandonné (statut 'failed') — arrêt propre`);
    this.name = "ScanAbortedError";
  }
}

/**
 * Stop as soon as the scan is no longer ours to run.
 *
 * Without this a scan marked `failed` by the reaper kept working for another
 * 11 minutes and overwrote the status afterwards, leaving the row inconsistent.
 */
function assertNotAborted(scanId: string): void {
  const row = db.getScan(scanId);
  if (row && row.status === "failed") {
    throw new ScanAbortedError(scanId);
  }
}

function makeEmitter(scanId: string): EventEmitter {
  let lastBeat = 0;
  return (type, agent, message, data) => {
    db.insertEvent(scanId, type, agent, message, data);
    // Every emitted event doubles as proof of life. Throttled to avoid an extra
    // write per log line; the reaper's staleness window is minutes-wide.
    const now = Date.now();
    if (now - lastBeat > 15_000) {
      lastBeat = now;
      db.touchScanHeartbeat(scanId);
    }
  };
}

/**
 * Surface broken dependencies BEFORE burning minutes on a degraded scan.
 * A missing Chromium previously killed the Spotify + Google agents silently and
 * the scan still reported success with a fraction of the producers.
 */
async function preflight(emit: EventEmitter, opts: { quiet?: boolean } = {}) {
  // Re-probe for the user's logged-in Chrome. Without this a headless browser
  // cached earlier in the process would be reused for the whole session, and
  // Spotify credits would stay empty even after Chrome-Spotify.bat is launched.
  await resetBrowser();

  const health = await checkHealth(true);
  // In a full scan, phase 3 re-checks the deps; don't duplicate the log lines.
  if (opts.quiet) return health;
  for (const c of health.checks) {
    if (!c.ok) {
      emit(
        "error",
        "preflight",
        `${c.critical ? "⛔ CRITIQUE" : "⚠️"} ${c.name} : ${c.detail}`
      );
    }
  }
  if (health.degraded) {
    emit(
      "error",
      "preflight",
      "⛔ Une source critique est indisponible — les résultats seront INCOMPLETS. Corrige le problème ci-dessus puis relance le scan."
    );
  } else {
    const warnings = health.checks.filter((c) => !c.ok);
    // Don't claim "OK" when checks failed — that message appeared right after a
    // warning and made a crippled scan look healthy.
    if (warnings.length > 0) {
      emit(
        "step_complete",
        "preflight",
        `⚠️ Dépendances partielles : ${warnings.map((c) => c.name).join(", ")} indisponible(s)`
      );
    } else {
      emit("step_complete", "preflight", "Dépendances OK (navigateur, Spotify, Instagram)");
    }
  }
  return health;
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 2 — credits
// ───────────────────────────────────────────────────────────────────────────
export async function runCreditsPipeline(scanId: string): Promise<void> {
  const scan = db.getScan(scanId);
  if (!scan) throw new Error("Scan not found");

  const tracks = db.getTracks(scanId);
  const artist = scan.artist as string;
  const album = scan.album as string;
  const emit = makeEmitter(scanId);

  db.updateScanStatus(scanId, "credits");
  await preflight(emit);
  emit("step_start", "pipeline", "Extraction des credits depuis 4 sources...");

  const geniusTracks = tracks
    .map((t) => ({
      title: t.title as string,
      genius_song_id: t.genius_song_id as number,
    }))
    .filter((t) => t.genius_song_id && t.genius_song_id > 0);
  const trackTitles = tracks.map((t) => t.title as string);
  const trackForMeta = tracks.map((t) => ({ title: t.title as string }));

  emit(
    "step_start",
    "pipeline",
    "Lancement parallele Genius + MusicBrainz + Spotify + Discogs"
  );

  const [geniusResults, mbResults, spotifyResults, discogsResults] =
    await Promise.all([
      extractGeniusCredits(geniusTracks, emit).catch((e: Error) => {
        emit("error", "genius", `Erreur Genius: ${e.message}`);
        return [];
      }),
      extractMusicbrainzCredits(artist, album, trackForMeta, emit).catch(
        (e: Error) => {
          emit("error", "musicbrainz", `Erreur MusicBrainz: ${e.message}`);
          return [];
        }
      ),
      extractSpotifyCredits(artist, album, trackTitles, emit).catch(
        (e: Error) => {
          emit("error", "spotify", `Erreur Spotify: ${e.message}`);
          return [];
        }
      ),
      extractDiscogsCredits(artist, album, trackForMeta, emit).catch(
        (e: Error) => {
          emit("error", "discogs", `Erreur Discogs: ${e.message}`);
          return [];
        }
      ),
    ]);

  const geniusCount = geniusResults.filter((r) => r.credits.length > 0).length;
  const mbCount = mbResults.filter((r) => r.credits.length > 0).length;
  const spotifyCount = spotifyResults.filter((r) => r.credits.length > 0).length;
  const discogsCount = discogsResults.filter((r) => r.credits.length > 0).length;

  emit(
    "step_complete",
    "pipeline",
    `Sources : Genius ${geniusCount}/${geniusResults.length} | MusicBrainz ${mbCount}/${mbResults.length} | Spotify ${spotifyCount}/${spotifyResults.length} | Discogs ${discogsCount}/${discogsResults.length}`
  );

  emit("step_start", "merger", "Fusion des credits multi-sources...");
  const producers = mergeCredits(
    { source: "GENIUS", results: geniusResults },
    { source: "MUSICBRAINZ", results: mbResults },
    { source: "SPOTIFY", results: spotifyResults },
    { source: "DISCOGS", results: discogsResults }
  );

  if (producers.length === 0) {
    emit(
      "error",
      "merger",
      "Aucun producteur trouve sur les 4 sources. L'album est peut-etre trop recent ou mal indexe."
    );
  } else {
    emit("step_complete", "merger", `${producers.length} producteurs uniques trouves`);
  }

  emit("step_start", "verifier", "Verification des identites...");
  const verifiedProducers = await verifyIdentities(producers, emit);
  emit("step_complete", "verifier", "Identites verifiees");

  // Replace any previously-inserted producers so a re-run doesn't duplicate them
  db.deleteProducers(scanId);
  for (const p of verifiedProducers) {
    db.insertProducer(
      scanId,
      p.name,
      p.aliases,
      p.sources,
      p.genius_artist_id,
      p.track_titles
    );
  }
  db.updateScanCounts(scanId, tracks.length, verifiedProducers.length);
  emit("step_complete", "pipeline", `Credits extraits : ${verifiedProducers.length} producteurs`);
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 3 — Instagram discovery
// ───────────────────────────────────────────────────────────────────────────
type IgStatus = "confirmed" | "probable" | "not_found";

interface ArbiterResultLite {
  instagram: string | null;
  ig_status: IgStatus;
  ig_confidence: number;
  ig_profile_data: IgProfileData | null;
  ig_validation: IgValidation | null;
  ig_candidates: IgCandidate[];
}

const BUDGET_RESCUE_THRESHOLD = 0.6;

function readMode(): "heuristic" | "llm" | "budget" {
  const raw = (process.env.IG_VALIDATION_MODE || "budget").toLowerCase().trim();
  if (raw === "heuristic" || raw === "llm" || raw === "budget") return raw;
  return "budget";
}

function isCounted(r: ArbiterResultLite): boolean {
  return (
    r.ig_status === "confirmed" ||
    (r.ig_status === "probable" && r.ig_confidence >= 0.6)
  );
}

function persistIg(producerDbId: number, result: ArbiterResultLite): void {
  db.updateProducerIg(
    producerDbId,
    result.instagram,
    result.ig_status,
    result.ig_confidence,
    result.ig_candidates,
    result.ig_profile_data,
    result.ig_validation
  );
}

export async function runInstagramPipeline(scanId: string): Promise<void> {
  const scan = db.getScan(scanId);
  if (!scan) throw new Error("Scan not found");

  const artist = scan.artist as string;
  const album = scan.album as string;
  // Full album tracklist: a producer proving a placement may name ANY track,
  // not only the ones they are credited on.
  const albumTracks = db.getTracks(scanId).map((t) => t.title as string);
  const dbProducers = db.getProducers(scanId);
  const mode = readMode();
  const emit = makeEmitter(scanId);

  db.updateScanStatus(scanId, "instagram");

  // Gate: if no Instagram read path works (curl blocked AND no logged-in Chrome),
  // every profile would come back empty and be rejected for "no musical
  // evidence" — turning a healthy album into 0 confirmed. Refuse to run and keep
  // the previous results instead of overwriting them with false negatives.
  const health = await preflight(emit);
  const igReadable = health.checks.some(
    (c) =>
      c.ok &&
      (c.name.startsWith("Session Chrome") || c.name.startsWith("Accès Instagram"))
  );
  if (!igReadable) {
    emit(
      "error",
      "instagram",
      "⛔ Phase Instagram ANNULÉE : aucun moyen de lire les profils (curl bloqué et Chrome debug absent). Lance Chrome-Spotify.bat, connecte-toi à Instagram, puis relance. Les résultats précédents sont conservés."
    );
    db.updateScanStatus(scanId, "failed");
    return;
  }

  emit(
    "step_start",
    "instagram",
    `Recherche Instagram pour ${dbProducers.length} producteurs (mode=${mode})`
  );

  interface ProducerEntry {
    dbId: number;
    producer: Producer;
    candidates: IgCandidate[];
    result: ArbiterResultLite;
  }

  const entries: ProducerEntry[] = [];
  // Real handles seen in other producers' credit captions on this record.
  const collaboratorPool: string[] = [];

  for (const dbProd of dbProducers) {
    // Resume support: a scan killed mid-flight (server stopped, machine
    // rebooted) leaves some producers already resolved. Re-checking them costs
    // ~3 min each through the browser, so we keep their result and continue
    // where we left off. A fresh re-scan clears these first, so nothing is
    // silently frozen.
    const existingStatus = dbProd.ig_status as string;
    if (existingStatus && existingStatus !== "pending") {
      const alreadyDone: ArbiterResultLite = {
        instagram: (dbProd.instagram as string) || null,
        ig_status: existingStatus as IgStatus,
        ig_confidence: (dbProd.ig_confidence as number) || 0,
        ig_profile_data: dbProd.ig_profile_data
          ? (JSON.parse(dbProd.ig_profile_data as string) as IgProfileData)
          : null,
        ig_validation: dbProd.ig_validation
          ? (JSON.parse(dbProd.ig_validation as string) as IgValidation)
          : null,
        ig_candidates: JSON.parse((dbProd.ig_candidates as string) || "[]"),
      };
      entries.push({
        dbId: dbProd.id as number,
        producer: {
          name: dbProd.name as string,
          aliases: JSON.parse((dbProd.aliases as string) || "[]"),
          sources: JSON.parse((dbProd.sources as string) || "[]"),
          double_source: false,
          genius_artist_id: (dbProd.genius_artist_id as number) || null,
          track_titles: JSON.parse((dbProd.track_titles as string) || "[]"),
          instagram: alreadyDone.instagram,
          ig_candidates: alreadyDone.ig_candidates,
          ig_status: alreadyDone.ig_status,
          ig_confidence: alreadyDone.ig_confidence,
          ig_profile_data: alreadyDone.ig_profile_data,
          ig_validation: alreadyDone.ig_validation,
          identity_confirmed: false,
          credits_fm_url: null,
          musicbrainz_url: null,
        },
        candidates: alreadyDone.ig_candidates,
        result: alreadyDone,
      });
      emit(
        "ig_resume",
        "instagram",
        `⏩ ${dbProd.name} déjà traité (${existingStatus}) — repris tel quel`
      );
      continue;
    }

    const producer: Producer = {
      name: dbProd.name as string,
      aliases: JSON.parse((dbProd.aliases as string) || "[]"),
      sources: JSON.parse((dbProd.sources as string) || "[]"),
      double_source: false,
      genius_artist_id: (dbProd.genius_artist_id as number) || null,
      track_titles: JSON.parse((dbProd.track_titles as string) || "[]"),
      instagram: null,
      ig_candidates: [],
      ig_status: "pending",
      ig_confidence: 0,
      ig_profile_data: null,
      ig_validation: null,
      identity_confirmed: false,
      credits_fm_url: null,
      musicbrainz_url: null,
    };

    assertNotAborted(scanId);
    emit("ig_start", "instagram", `Recherche IG → ${producer.name}`);

    const geniusCandidates = await agentGenius(producer, emit);
    // Give the Google agent the Twitter hint discovered by Genius.
    producer.ig_candidates = geniusCandidates;

    const phase1Mode: ValidationMode = mode === "llm" ? "llm" : "heuristic";
    const arbiterOptions = {
      mode: phase1Mode,
      album,
      trackTitles: albumTracks,
      collect: collaboratorPool,
    };

    // Fast path — the user's manual method, automated: when the credit carries
    // its own Genius artist page and that page lists an Instagram, trying that
    // single profile usually settles the producer in one visit (~10s). The
    // Google stage (browser search + up to 16 handle variants, 15-20s) only
    // runs when the fast path fails.
    let allCandidates = geniusCandidates;
    let result: Awaited<ReturnType<typeof agentArbiter>> | null = null;
    if (geniusCandidates.some((c) => c.source === "GENIUS_API")) {
      const quick = await agentArbiter(
        producer,
        artist,
        geniusCandidates,
        emit,
        arbiterOptions
      );
      if (
        quick.ig_status === "confirmed" ||
        (quick.ig_status === "probable" && quick.ig_confidence >= 0.7)
      ) {
        result = quick;
        emit(
          "ig_fastpath",
          "instagram",
          `⚡ ${producer.name} résolu via sa fiche Genius — étape Google évitée`
        );
      }
    }

    if (!result) {
      const googleCandidates = await agentGoogle(producer, artist, emit);
      allCandidates = mergeCandidates(geniusCandidates, googleCandidates);
      emit(
        "ig_candidates",
        "instagram",
        `${allCandidates.length} candidat(s) pour ${producer.name}: ${allCandidates
          .map((c) => `@${c.handle}(${c.score})`)
          .join(", ")}`
      );
      // skipCache: the fast-path attempt may have cached its lesser verdict.
      result = await agentArbiter(producer, artist, allCandidates, emit, {
        ...arbiterOptions,
        skipCache: true,
      });
    }

    entries.push({
      dbId: dbProd.id as number,
      producer,
      candidates: allCandidates,
      result,
    });
    persistIg(dbProd.id as number, result);

    const icon =
      result.ig_status === "confirmed"
        ? "✅"
        : result.ig_status === "probable"
          ? "🟡"
          : "❌";
    emit(
      "ig_result",
      "instagram",
      `${icon} ${producer.name} → ${result.instagram ? `@${result.instagram}` : "non trouve"} (${result.ig_status}, ${(result.ig_confidence * 100).toFixed(0)}%)`
    );
  }

  // ── Collaborator pass ────────────────────────────────────────────────
  // Producers announce each other: "[produced by Rowan, @calig_ @_2one2
  // @cash3n]". Those handles are authoritative and solve the hardest case —
  // a producer whose social handle looks nothing like his credited name
  // (credited "Cashen", handle @cash3n). Retry the unresolved ones against
  // the pool harvested from confirmed profiles.
  const unresolved = entries.filter((e) => e.result.ig_status === "not_found");
  if (collaboratorPool.length > 0 && unresolved.length > 0) {
    emit(
      "ig_collab_start",
      "instagram",
      `🤝 Passe collaborateurs : ${collaboratorPool.length} handle(s) récolté(s) dans les crédits, ${unresolved.length} producteur(s) à retrouver`
    );

    let recovered = 0;
    for (const entry of unresolved) {
      // Only try pool handles that plausibly match this producer's name.
      const plausible = collaboratorPool
        .filter((h) => {
          const m = nameMatchHandle(entry.producer.name, entry.producer.aliases, h);
          return m.level === "strong" || m.level === "moderate";
        })
        .map((h) => ({ handle: h, score: 9, source: "COLLAB_CREDIT" }));

      if (plausible.length === 0) continue;

      emit(
        "ig_collab_try",
        "instagram",
        `${entry.producer.name} → test ${plausible.map((c) => "@" + c.handle).join(", ")}`
      );

      const res = await agentArbiter(entry.producer, artist, plausible, emit, {
        mode: "heuristic",
        skipCache: true,
        album,
        trackTitles: albumTracks,
      });

      if (res.ig_status !== "not_found") {
        entry.result = res;
        persistIg(entry.dbId, res);
        recovered++;
        emit(
          "ig_collab_found",
          "instagram",
          `↗️ ${entry.producer.name} → @${res.instagram} via crédits d'un collaborateur`
        );
      }
    }
    emit(
      "ig_collab_complete",
      "instagram",
      `Passe collaborateurs : ${recovered}/${unresolved.length} récupéré(s)`
    );
  }

  // Budget rescue with Claude if heuristic found rate is low
  if (mode === "budget") {
    const total = entries.length;
    const found = entries.filter((e) => isCounted(e.result)).length;
    const foundRate = total > 0 ? found / total : 1;

    emit(
      "ig_budget_eval",
      "instagram",
      `Mode budget : taux heuristique = ${(foundRate * 100).toFixed(0)}% (${found}/${total}) — seuil rescue = ${BUDGET_RESCUE_THRESHOLD * 100}%`
    );

    if (foundRate < BUDGET_RESCUE_THRESHOLD) {
      const toRescue = entries.filter(
        (e) =>
          e.result.ig_status === "not_found" ||
          (e.result.ig_status === "probable" && e.result.ig_confidence < 0.6)
      );

      emit(
        "ig_rescue_start",
        "instagram",
        `🚑 Rescue Claude lance sur ${toRescue.length} producteur(s)`
      );

      let upgrades = 0;
      for (const entry of toRescue) {
        const before = entry.result.ig_status;
        const beforeIg = entry.result.instagram;
        const newResult = await agentArbiter(
          entry.producer,
          artist,
          entry.candidates,
          emit,
          { mode: "llm", skipCache: true, album, trackTitles: albumTracks }
        );
        const isUpgrade =
          newResult.ig_confidence > entry.result.ig_confidence ||
          (newResult.ig_status === "confirmed" && before !== "confirmed");
        if (isUpgrade) {
          entry.result = newResult;
          persistIg(entry.dbId, newResult);
          upgrades++;
          emit(
            "ig_rescue_upgrade",
            "instagram",
            `↗️ ${entry.producer.name}: ${before} → ${newResult.ig_status} (${beforeIg || "none"} → @${newResult.instagram || "none"})`
          );
        }
      }
      emit(
        "ig_rescue_complete",
        "instagram",
        `Rescue termine : ${upgrades}/${toRescue.length} producteurs rattrapes par Claude`
      );
    } else {
      emit("ig_budget_skip", "instagram", "Heuristique suffisante — Claude non utilise");
    }
  }

  db.updateScanStatus(scanId, "complete");

  const total = entries.length;
  const confirmed = entries.filter((e) => e.result.ig_status === "confirmed").length;
  const probable = entries.filter((e) => e.result.ig_status === "probable").length;
  const found = confirmed + probable;
  emit(
    "step_complete",
    "instagram",
    `Instagram termine: ${confirmed} confirmes, ${probable} probables, ${total - found} non trouves (${total > 0 ? ((found / total) * 100).toFixed(0) : 0}%)`
  );
}

// Full pipeline (credits → instagram) used by the background runner.
export async function runFullPipeline(scanId: string): Promise<void> {
  await runCreditsPipeline(scanId);
  await runInstagramPipeline(scanId);
}

/**
 * Re-scan with every source re-queried from scratch.
 *
 * Sources keep improving after release day (Genius credits for a new album can
 * go from 3 producers to 22 within a week). Without this, a relaunch replayed
 * cached responses and produced identical results, which is exactly what made
 * re-scans useless.
 */
export function runFreshPipeline(
  scanId: string,
  kind: "full" | "credits" | "instagram"
): Promise<void> {
  return runFresh(async () => {
    const emit = makeEmitter(scanId);
    emit(
      "step_start",
      "pipeline",
      "🔄 Scan FRAIS — cache ignoré, toutes les sources sont réinterrogées"
    );
    // Clear previous Instagram results, otherwise the resume logic (which skips
    // already-resolved producers) would make a fresh re-scan a no-op.
    if (kind === "instagram" || kind === "full") {
      db.resetProducerIg(scanId);
    }
    if (kind === "credits") return runCreditsPipeline(scanId);
    if (kind === "instagram") return runInstagramPipeline(scanId);
    return runFullPipeline(scanId);
  });
}
