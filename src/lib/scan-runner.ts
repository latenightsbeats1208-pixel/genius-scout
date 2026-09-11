import { db } from "./db";
import {
  runCreditsPipeline,
  runInstagramPipeline,
  runFullPipeline,
  runFreshPipeline,
} from "./pipeline";

export type RunKind = "full" | "credits" | "instagram";

// Registry of scans currently executing.
//
// Stored on globalThis rather than in a module-level const: Next.js gives each
// route its own module instance, so a plain const meant /api/scan/running saw an
// empty map while a scan was actually in flight. One process-wide map fixes it.
const GLOBAL_KEY = "__geniusScoutRunning__";
const KICKED_KEY = "__geniusScoutQueueKicked__";
type RunningMap = Map<string, RunKind>;
const globalStore = globalThis as unknown as Record<string, unknown>;
const running: RunningMap =
  (globalStore[GLOBAL_KEY] as RunningMap) ?? new Map<string, RunKind>();
globalStore[GLOBAL_KEY] = running;

/**
 * Concurrency budget shared by every scan.
 *
 * All scans share ONE Instagram session, ONE dedicated Chrome and ONE IP
 * (MusicBrainz allows 1 req/s worldwide per IP). Two scans stay inside those
 * limits; beyond that Instagram starts soft-blocking and real producers come
 * back "not found" without a single error anywhere. The queue exists so that
 * launching ten albums at once is safe: two run, the rest wait their turn.
 */
export const MAX_CONCURRENT_SCANS = 2;

export function isScanRunning(scanId: string): boolean {
  return running.has(scanId);
}

export function getRunningScans(): { scanId: string; kind: RunKind }[] {
  return [...running.entries()].map(([scanId, kind]) => ({ scanId, kind }));
}

/** Launch queued scans while there is capacity. Must never throw. */
function launchNextFromQueue(): void {
  try {
    while (running.size < MAX_CONCURRENT_SCANS) {
      const next = db.popNextQueued();
      if (!next) break;
      // Deleted from history while waiting: skip it silently.
      if (!db.getScan(next.scan_id)) continue;
      startScan(next.scan_id, next.kind as RunKind, Boolean(next.fresh));
    }
  } catch {
    // A broken queue must never take down the scan that just finished.
  }
}

/**
 * The queue lives in the database, but nothing relaunched it after a server
 * restart. First API call that cares kicks it — idempotent via globalThis.
 */
export function ensureQueueRunning(): void {
  if (globalStore[KICKED_KEY]) return;
  globalStore[KICKED_KEY] = true;
  launchNextFromQueue();
}

export interface RequestScanResult {
  started: boolean;
  alreadyRunning: boolean;
  queued: boolean;
  position: number | null;
}

/**
 * Single entry point for the UI: run now if a slot is free, queue otherwise.
 */
export function requestScan(
  scanId: string,
  kind: RunKind = "full",
  fresh = false
): RequestScanResult {
  ensureQueueRunning();
  if (running.has(scanId)) {
    return { started: false, alreadyRunning: true, queued: false, position: null };
  }
  if (running.size < MAX_CONCURRENT_SCANS) {
    startScan(scanId, kind, fresh);
    return { started: true, alreadyRunning: false, queued: false, position: null };
  }
  const position = db.enqueueScan(scanId, kind, fresh ? 1 : 0);
  db.insertEvent(
    scanId,
    "step_start",
    "runner",
    `En file d'attente (position ${position}) — démarrage automatique dès qu'un des ${MAX_CONCURRENT_SCANS} créneaux se libère.`
  );
  return { started: false, alreadyRunning: false, queued: true, position };
}

/**
 * Fire-and-forget: kicks the pipeline off in the background and returns
 * immediately. The HTTP request that triggered it does NOT stay open, so the
 * scan keeps running even if the user closes the tab or starts other scans.
 */
export function startScan(
  scanId: string,
  kind: RunKind = "full",
  fresh = false
): { started: boolean; alreadyRunning: boolean } {
  if (running.has(scanId)) {
    return { started: false, alreadyRunning: true };
  }
  running.set(scanId, kind);

  void (async () => {
    try {
      if (fresh) {
        await runFreshPipeline(scanId, kind);
      } else if (kind === "credits") await runCreditsPipeline(scanId);
      else if (kind === "instagram") await runInstagramPipeline(scanId);
      else await runFullPipeline(scanId);
    } catch (e) {
      const err = e as Error;
      if (err.name === "ScanAbortedError") {
        // Already marked failed by the reaper — just note the clean stop.
        db.insertEvent(scanId, "error", "runner", err.message);
      } else {
        db.insertEvent(scanId, "error", "runner", `Pipeline interrompu: ${err.message}`);
        db.updateScanStatus(scanId, "failed");
      }
    } finally {
      running.delete(scanId);
      // A slot just freed up: the queue moves forward on its own.
      launchNextFromQueue();
      // Fresh results just landed: snapshot them (30 min guard against bursts).
      try {
        db.backupNow(30 * 60 * 1000);
      } catch {
        /* a failed snapshot must never block the queue */
      }
    }
  })();

  return { started: true, alreadyRunning: false };
}
