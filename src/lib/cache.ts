import { db } from "./db";
import crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";

export const CACHE_TTL = {
  // Recent albums get their credits filled in on Genius over days/weeks, so a
  // long TTL made re-scans return the same stale (often empty) credits. Keep it
  // short: the point of this cache is to avoid hammering the API within a run,
  // not to freeze results for a week.
  GENIUS_SONG: 6 * 3600, // 6 hours
  MUSICBRAINZ: 3 * 24 * 3600, // 3 days
  DISCOGS: 3 * 24 * 3600, // 3 days
  SPOTIFY_TRACKLIST: 30 * 24 * 3600, // tracklists are stable
  PRODUCER_IG: 30 * 24 * 3600,
};

/**
 * Per-run "fresh" flag.
 *
 * When the user relaunches a scan they expect the sources to be re-queried —
 * previously the API cache silently served week-old responses, so a re-scan
 * produced byte-identical (and often near-empty) results. We propagate the flag
 * through the whole async pipeline with AsyncLocalStorage so every agent's
 * withCache() call bypasses reads without changing any function signature.
 */
const freshStore = new AsyncLocalStorage<boolean>();

export function runFresh<T>(fn: () => Promise<T>): Promise<T> {
  return freshStore.run(true, fn);
}

export function isFreshRun(): boolean {
  return freshStore.getStore() === true;
}

function hashKey(parts: (string | number | undefined | null)[]): string {
  const joined = parts.map((p) => String(p ?? "")).join("|");
  return crypto.createHash("sha1").update(joined).digest("hex").slice(0, 32);
}

export function makeKey(source: string, ...parts: (string | number | undefined | null)[]): string {
  return `${source}:${hashKey(parts)}`;
}

export function getCached<T>(key: string): T | null {
  if (isFreshRun()) return null;
  const row = db.getApiCache(key);
  if (!row) return null;
  try {
    return JSON.parse(row.response as string) as T;
  } catch {
    return null;
  }
}

export function setCached<T>(key: string, source: string, value: T, ttlSeconds: number): void {
  db.setApiCache(key, source, value, ttlSeconds);
}

export async function withCache<T>(
  key: string,
  source: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const hit = getCached<T>(key);
  if (hit !== null) return hit;
  const fresh = await fetcher();
  if (fresh !== null && fresh !== undefined) {
    // Always refresh the stored value, even on a fresh run, so subsequent
    // non-fresh reads get the up-to-date payload.
    setCached(key, source, fresh, ttlSeconds);
  }
  return fresh;
}

export function normalizeProducerName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}
