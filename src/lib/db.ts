import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// One connection per PROCESS, not per module. Next.js instantiates modules per
// route, so a module-level variable produced several connections — and ran the
// orphan reaper several times, including in the middle of a live scan.
// The connection is cached alongside the path it was opened with, so a changed
// path invalidates it instead of silently serving a stale handle.
interface DbGlobals {
  __geniusScoutDb__?: Database.Database;
  __geniusScoutDbPath__?: string;
}
const dbGlobal = globalThis as unknown as DbGlobals;

/**
 * The database lives OUTSIDE the project directory.
 *
 * Turbopack watches the whole source tree in dev and crashed with a fatal panic
 * trying to read `data/scans.db-shm` — SQLite's WAL shared-memory file, which is
 * locked by our own connection ("os error 33"). A runtime database has no
 * business inside a watched source tree anyway.
 */
/**
 * The database now lives under the USER PROFILE ROOT, not AppData\\Local.
 *
 * Twice (18/08 and 25/08) the LOCALAPPDATA store was silently wiped around a
 * reboot — scans.db reappeared empty and the dedicated Chrome profile lost its
 * sessions the same way. Whatever cleans that zone treats our folders as
 * disposable caches. %USERPROFILE%\\GeniusScoutData sits outside the cleaners'
 * hunting ground and outside OneDrive.
 */
function dataHome(): string {
  return path.join(process.env.USERPROFILE || process.cwd(), "GeniusScoutData");
}

function legacyHome(): string {
  const base =
    process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || process.cwd(), "AppData", "Local");
  return path.join(base, "GeniusScout");
}

export function resolveDbPath(): string {
  if (process.env.GENIUS_DB_PATH) return process.env.GENIUS_DB_PATH;
  return path.join(dataHome(), "scans.db");
}

/** Number of scans a database file holds; -1 when unreadable or corrupt. */
function countScans(file: string): number {
  if (!fs.existsSync(file)) return -1;
  let conn: Database.Database | null = null;
  try {
    conn = new Database(file, { readonly: true, fileMustExist: true });
    const row = conn.prepare("SELECT COUNT(*) c FROM scans").get() as { c: number };
    return row.c;
  } catch {
    return -1;
  } finally {
    try {
      conn?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Self-healing open: when the live database is missing, empty or corrupt,
 * adopt the best surviving copy (legacy stores included) instead of silently
 * starting over. The user twice opened the app to an apparently erased
 * history; recovery must not depend on anyone noticing.
 */
function recoverIfNeeded(dbPath: string) {
  try {
    if (countScans(dbPath) > 0) return; // healthy

    const candidates: string[] = [];
    const push = (f: string) => {
      if (fs.existsSync(f)) candidates.push(f);
    };
    const pushDir = (dir: string) => {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith(".db")) push(path.join(dir, f));
        }
      } catch {
        /* absent */
      }
    };
    pushDir(path.join(path.dirname(dbPath), "backups"));
    push(path.join(legacyHome(), "scans.db"));
    pushDir(path.join(legacyHome(), "backups"));
    push(path.join(legacyHome(), "backup-legacy", "scans.db"));
    push(path.join(process.cwd(), "data", "scans.db"));

    let best: { file: string; scans: number; at: number } | null = null;
    for (const f of candidates) {
      if (path.resolve(f) === path.resolve(dbPath)) continue;
      const n = countScans(f);
      if (n <= 0) continue;
      const at = fs.statSync(f).mtimeMs;
      if (!best || n > best.scans || (n === best.scans && at > best.at)) {
        best = { file: f, scans: n, at };
      }
    }
    if (!best) return; // fresh install, nothing to restore

    // Park the dead file instead of overwriting it blind.
    if (fs.existsSync(dbPath)) {
      const stamp = new Date().toISOString().slice(0, 10);
      const quarantine = path.join(path.dirname(dbPath), "remplace-" + stamp);
      fs.mkdirSync(quarantine, { recursive: true });
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          if (fs.existsSync(dbPath + suffix)) {
            fs.renameSync(
              dbPath + suffix,
              path.join(quarantine, path.basename(dbPath) + suffix)
            );
          }
        } catch {
          /* keep going */
        }
      }
    }
    fs.copyFileSync(best.file, dbPath);
    console.log(
      "[GeniusScout] Base restauree automatiquement depuis " +
        best.file +
        " (" +
        best.scans +
        " scans)"
    );
  } catch (e) {
    console.error("[GeniusScout] Restauration automatique impossible:", e);
  }
}

function getDb(): Database.Database {
  const dbPath = resolveDbPath();
  const existing = dbGlobal.__geniusScoutDb__;

  // Reuse the cached connection ONLY if it still points at the current path and
  // that file still exists. A connection cached on globalThis survives hot
  // reloads, so after the database moved out of the project the old process kept
  // a handle on the vanished file and every query came back empty — the history
  // looked wiped while the real database was intact.
  if (existing) {
    const samePath = dbGlobal.__geniusScoutDbPath__ === dbPath;
    if (samePath && existing.open && fs.existsSync(dbPath)) return existing;
    try {
      existing.close();
    } catch {
      /* already closed */
    }
    dbGlobal.__geniusScoutDb__ = undefined;
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // Missing, empty or corrupt: adopt the best surviving copy automatically
  // (covers the legacy LOCALAPPDATA store and the old in-project data/).
  recoverIfNeeded(dbPath);

  const conn = new Database(dbPath);
  dbGlobal.__geniusScoutDbPath__ = dbPath;
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  initSchema(conn);
  dbGlobal.__geniusScoutDb__ = conn;
  recoverOrphanedScans(conn);
  backupDaily(conn, dbPath);
  return conn;
}

/** How many dated snapshots to keep before the oldest is dropped. */
const BACKUP_KEEP = 10;
const BACKUP_INTERVAL_MS = 3 * 60 * 60 * 1000;

/**
 * Keep dated copies of the database next to it.
 *
 * The whole point of this app is the scan history, and it was silently lost
 * once: the live file ended up empty while the only surviving copy was an
 * unrelated migration leftover. A schema-only database looks perfectly healthy
 * to every query, so nothing raised an alarm — a snapshot is the only thing
 * that turns that into a five-minute recovery.
 *
 * Runs at most twice a day, never on an empty database (so a broken state can
 * never overwrite a good snapshot), and uses SQLite's own backup API so the
 * WAL is included.
 */
function backupDaily(
  conn: Database.Database,
  dbPath: string,
  intervalMs: number = BACKUP_INTERVAL_MS
) {
  try {
    const count = (
      conn.prepare("SELECT COUNT(*) c FROM scans").get() as { c: number }
    ).c;
    if (count === 0) return; // never snapshot an empty database

    const dir = path.join(path.dirname(dbPath), "backups");
    fs.mkdirSync(dir, { recursive: true });

    const existing = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("scans-") && f.endsWith(".db"))
      .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);

    if (existing.length && Date.now() - existing[0].at < intervalMs) {
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    void conn.backup(path.join(dir, `scans-${stamp}.db`));

    for (const old of existing.slice(BACKUP_KEEP - 1)) {
      try {
        fs.unlinkSync(path.join(dir, old.f));
      } catch {
        /* keep going */
      }
    }
  } catch {
    // A failed backup must never prevent the app from starting.
  }
}

/**
 * How long a scan may go without a heartbeat before we consider it dead.
 * A single producer can legitimately take a few minutes (browser visits to
 * several Instagram profiles), so this must be generous.
 */
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

/**
 * Mark genuinely-dead scans as failed.
 *
 * WARNING — this must never touch a RUNNING scan. The previous version assumed
 * it ran "once at boot, before any scan can start", but Next.js isolates modules
 * per route: the first DB access inside ANY route module runs this, which can
 * happen while a scan is mid-flight. It then marked the live scan `failed`
 * (observed: scan declared interrupted at 08:06 while it kept working until
 * 08:17). We now rely on a heartbeat the running pipeline refreshes, and only
 * reap scans whose heartbeat is stale.
 */
function recoverOrphanedScans(db: Database.Database) {
  const cutoff = new Date(Date.now() - HEARTBEAT_STALE_MS).toISOString();
  const orphans = db
    .prepare(
      `SELECT id FROM scans
       WHERE status IN ('credits','instagram')
         AND COALESCE(heartbeat_at, created_at) < ?`
    )
    .all(cutoff) as { id: string }[];
  if (orphans.length === 0) return;

  const markFailed = db.prepare("UPDATE scans SET status = 'failed' WHERE id = ?");
  const addEvent = db.prepare(
    "INSERT INTO scan_events (scan_id, timestamp, type, agent, message) VALUES (?, ?, 'error', 'runner', ?)"
  );
  const now = new Date().toISOString();
  for (const o of orphans) {
    markFailed.run(o.id);
    addEvent.run(
      o.id,
      now,
      "Scan interrompu (serveur arrêté pendant l'exécution) — relance-le pour le terminer."
    );
  }
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      album_art_url TEXT,
      genius_album_id INTEGER,
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      track_count INTEGER DEFAULT 0,
      producer_count INTEGER DEFAULT 0,
      heartbeat_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT REFERENCES scans(id),
      title TEXT NOT NULL,
      genius_song_id INTEGER,
      spotify_track_id TEXT,
      spotify_url TEXT,
      genius_url TEXT
    );

    CREATE TABLE IF NOT EXISTS producers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT REFERENCES scans(id),
      name TEXT NOT NULL,
      aliases TEXT DEFAULT '[]',
      sources TEXT DEFAULT '[]',
      genius_artist_id INTEGER,
      track_titles TEXT DEFAULT '[]',
      instagram TEXT,
      ig_candidates TEXT DEFAULT '[]',
      ig_status TEXT DEFAULT 'pending',
      ig_confidence REAL DEFAULT 0,
      ig_profile_data TEXT,
      ig_validation TEXT
    );

    CREATE TABLE IF NOT EXISTS scan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT REFERENCES scans(id),
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      agent TEXT,
      message TEXT,
      data TEXT
    );

    CREATE TABLE IF NOT EXISTS producer_cache (
      name_normalized TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      instagram TEXT,
      genius_artist_id INTEGER,
      ig_status TEXT,
      ig_confidence REAL DEFAULT 0,
      ig_profile_data TEXT,
      ig_validation TEXT,
      ig_candidates TEXT DEFAULT '[]',
      last_verified_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_cache (
      cache_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache(expires_at);

    -- Outreach tracking. Keyed on the normalized producer name (NOT on a scan)
    -- so the email and the "already contacted" state survive re-scans and are
    -- shared across every album the producer appears on.
    CREATE TABLE IF NOT EXISTS scan_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT NOT NULL UNIQUE REFERENCES scans(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'full',
      fresh INTEGER NOT NULL DEFAULT 0,
      enqueued_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_crm (
      name_normalized TEXT PRIMARY KEY,
      display_name TEXT,
      email TEXT,
      email_source TEXT,
      emailed_at TEXT,
      follow_up_at TEXT,
      notes TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  // Migration for databases created before heartbeat_at existed.
  const cols = db.prepare("PRAGMA table_info(scans)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "heartbeat_at")) {
    db.exec("ALTER TABLE scans ADD COLUMN heartbeat_at TEXT");
  }
}

export const db = {
  // Scans
  createScan(id: string, artist: string, album: string, albumArtUrl: string, geniusAlbumId: number) {
    getDb()
      .prepare(
        "INSERT INTO scans (id, artist, album, album_art_url, genius_album_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, artist, album, albumArtUrl, geniusAlbumId, new Date().toISOString());
  },

  /**
   * Snapshot on demand — called after each completed scan so a wipe or crash
   * costs at most the last half hour, not a day of scanning.
   */
  backupNow(minIntervalMs = 0) {
    backupDaily(getDb(), resolveDbPath(), minIntervalMs);
  },

  // --- Scan queue (2 scans at a time, the rest wait in the database) ---
  enqueueScan(scanId: string, kind: string, fresh: number): number {
    const d = getDb();
    d.prepare(
      "INSERT OR IGNORE INTO scan_queue (scan_id, kind, fresh, enqueued_at) VALUES (?, ?, ?, ?)"
    ).run(scanId, kind, fresh, new Date().toISOString());
    const row = d
      .prepare(
        "SELECT COUNT(*) c FROM scan_queue WHERE id <= (SELECT id FROM scan_queue WHERE scan_id = ?)"
      )
      .get(scanId) as { c: number };
    return row.c;
  },

  popNextQueued(): { scan_id: string; kind: string; fresh: number } | null {
    const d = getDb();
    const row = d
      .prepare("SELECT id, scan_id, kind, fresh FROM scan_queue ORDER BY id LIMIT 1")
      .get() as { id: number; scan_id: string; kind: string; fresh: number } | undefined;
    if (!row) return null;
    d.prepare("DELETE FROM scan_queue WHERE id = ?").run(row.id);
    return row;
  },

  getQueuedScans() {
    return getDb()
      .prepare(
        `SELECT q.scan_id, q.kind, q.fresh, q.enqueued_at,
                s.artist, s.album, s.album_art_url
         FROM scan_queue q JOIN scans s ON s.id = q.scan_id
         ORDER BY q.id`
      )
      .all() as Record<string, unknown>[];
  },

  removeQueuedScan(scanId: string) {
    const d = getDb();
    d.prepare("DELETE FROM scan_queue WHERE scan_id = ?").run(scanId);
    // The scan never ran: a phantom 'pending' row would only clutter the
    // history — clean it up entirely, but never touch a scan that has run.
    const scan = d.prepare("SELECT status FROM scans WHERE id = ?").get(scanId) as
      | { status?: string }
      | undefined;
    if (scan?.status === "pending") {
      d.prepare("DELETE FROM producers WHERE scan_id = ?").run(scanId);
      d.prepare("DELETE FROM tracks WHERE scan_id = ?").run(scanId);
      d.prepare("DELETE FROM scan_events WHERE scan_id = ?").run(scanId);
      d.prepare("DELETE FROM scans WHERE id = ?").run(scanId);
    }
  },

  updateScanStatus(id: string, status: string) {
    const now = new Date().toISOString();
    const completedAt = status === "complete" || status === "failed" ? now : null;
    // Entering a running state also opens the heartbeat window.
    const heartbeat = status === "credits" || status === "instagram" ? now : null;
    getDb()
      .prepare(
        `UPDATE scans
         SET status = ?,
             completed_at = COALESCE(?, completed_at),
             heartbeat_at = COALESCE(?, heartbeat_at)
         WHERE id = ?`
      )
      .run(status, completedAt, heartbeat, id);
  },

  /** Proof of life for a running scan — keeps the reaper from killing it. */
  touchScanHeartbeat(id: string) {
    getDb()
      .prepare("UPDATE scans SET heartbeat_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  },

  updateScanCounts(id: string, trackCount: number, producerCount: number) {
    getDb()
      .prepare("UPDATE scans SET track_count = ?, producer_count = ? WHERE id = ?")
      .run(trackCount, producerCount, id);
  },

  getScan(id: string) {
    return getDb().prepare("SELECT * FROM scans WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  },

  getAllScans() {
    return getDb().prepare("SELECT * FROM scans ORDER BY created_at DESC").all() as Record<string, unknown>[];
  },

  // Tracks
  insertTrack(
    scanId: string,
    title: string,
    geniusSongId: number,
    geniusUrl: string,
    spotifyTrackId: string | null = null,
    spotifyUrl: string | null = null
  ) {
    getDb()
      .prepare(
        "INSERT INTO tracks (scan_id, title, genius_song_id, genius_url, spotify_track_id, spotify_url) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(scanId, title, geniusSongId, geniusUrl, spotifyTrackId, spotifyUrl);
  },

  getTracks(scanId: string) {
    return getDb().prepare("SELECT * FROM tracks WHERE scan_id = ?").all(scanId) as Record<string, unknown>[];
  },

  // Producers
  insertProducer(
    scanId: string,
    name: string,
    aliases: string[],
    sources: string[],
    geniusArtistId: number | null,
    trackTitles: string[]
  ) {
    getDb()
      .prepare(
        "INSERT INTO producers (scan_id, name, aliases, sources, genius_artist_id, track_titles) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(scanId, name, JSON.stringify(aliases), JSON.stringify(sources), geniusArtistId, JSON.stringify(trackTitles));
  },

  /** Rewrite the grouping fields of a producer row (retro regroup pass). */
  updateProducerGroup(
    id: number,
    name: string,
    aliases: string[],
    sources: string[],
    trackTitles: string[]
  ) {
    getDb()
      .prepare(
        "UPDATE producers SET name = ?, aliases = ?, sources = ?, track_titles = ? WHERE id = ?"
      )
      .run(
        name,
        JSON.stringify(aliases),
        JSON.stringify(sources),
        JSON.stringify(trackTitles),
        id
      );
  },

  deleteProducerById(id: number) {
    getDb().prepare("DELETE FROM producers WHERE id = ?").run(id);
  },

  updateProducerIg(
    id: number,
    instagram: string | null,
    igStatus: string,
    igConfidence: number,
    igCandidates: unknown[],
    igProfileData: unknown,
    igValidation: unknown
  ) {
    getDb()
      .prepare(
        "UPDATE producers SET instagram = ?, ig_status = ?, ig_confidence = ?, ig_candidates = ?, ig_profile_data = ?, ig_validation = ? WHERE id = ?"
      )
      .run(
        instagram,
        igStatus,
        igConfidence,
        JSON.stringify(igCandidates),
        JSON.stringify(igProfileData),
        JSON.stringify(igValidation),
        id
      );
  },

  getProducers(scanId: string) {
    return getDb().prepare("SELECT * FROM producers WHERE scan_id = ?").all(scanId) as Record<string, unknown>[];
  },

  // Wipe a scan's producers so re-running the credits phase replaces them
  // instead of appending duplicates.
  deleteProducers(scanId: string) {
    getDb().prepare("DELETE FROM producers WHERE scan_id = ?").run(scanId);
  },

  // Clear Instagram results so a FRESH re-scan re-verifies every producer.
  // Without this the resume logic would skip them all and the re-scan would be
  // a no-op.
  resetProducerIg(scanId: string) {
    getDb()
      .prepare(
        `UPDATE producers SET instagram = NULL, ig_status = 'pending',
           ig_confidence = 0, ig_candidates = '[]',
           ig_profile_data = NULL, ig_validation = NULL
         WHERE scan_id = ?`
      )
      .run(scanId);
  },

  // Scans left mid-flight when the server died. At boot nothing is running, so
  // any scan still marked credits/instagram is orphaned and must not appear to
  // the user as "in progress" forever.
  getOrphanedScans() {
    return getDb()
      .prepare("SELECT id FROM scans WHERE status IN ('credits','instagram')")
      .all() as { id: string }[];
  },

  // Events
  insertEvent(scanId: string, type: string, agent: string, message: string, data?: unknown) {
    getDb()
      .prepare("INSERT INTO scan_events (scan_id, timestamp, type, agent, message, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(scanId, new Date().toISOString(), type, agent, message, data ? JSON.stringify(data) : null);
  },

  getEventsSince(scanId: string, lastId: number) {
    return getDb()
      .prepare("SELECT * FROM scan_events WHERE scan_id = ? AND id > ? ORDER BY id ASC")
      .all(scanId, lastId) as Record<string, unknown>[];
  },

  getEvents(scanId: string) {
    return getDb()
      .prepare("SELECT * FROM scan_events WHERE scan_id = ? ORDER BY id ASC")
      .all(scanId) as Record<string, unknown>[];
  },

  // Producer cache (cross-scan, keyed by normalized name)
  getProducerCache(nameNormalized: string) {
    return getDb()
      .prepare("SELECT * FROM producer_cache WHERE name_normalized = ?")
      .get(nameNormalized) as Record<string, unknown> | undefined;
  },

  upsertProducerCache(entry: {
    name_normalized: string;
    display_name: string;
    instagram: string | null;
    genius_artist_id: number | null;
    ig_status: string;
    ig_confidence: number;
    ig_profile_data: unknown;
    ig_validation: unknown;
    ig_candidates: unknown;
  }) {
    getDb()
      .prepare(
        `INSERT INTO producer_cache (
           name_normalized, display_name, instagram, genius_artist_id,
           ig_status, ig_confidence, ig_profile_data, ig_validation,
           ig_candidates, last_verified_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name_normalized) DO UPDATE SET
           display_name = excluded.display_name,
           instagram = excluded.instagram,
           genius_artist_id = excluded.genius_artist_id,
           ig_status = excluded.ig_status,
           ig_confidence = excluded.ig_confidence,
           ig_profile_data = excluded.ig_profile_data,
           ig_validation = excluded.ig_validation,
           ig_candidates = excluded.ig_candidates,
           last_verified_at = excluded.last_verified_at`
      )
      .run(
        entry.name_normalized,
        entry.display_name,
        entry.instagram,
        entry.genius_artist_id,
        entry.ig_status,
        entry.ig_confidence,
        entry.ig_profile_data ? JSON.stringify(entry.ig_profile_data) : null,
        entry.ig_validation ? JSON.stringify(entry.ig_validation) : null,
        JSON.stringify(entry.ig_candidates ?? []),
        new Date().toISOString()
      );
  },

  // Generic API cache
  getApiCache(cacheKey: string) {
    return getDb()
      .prepare(
        "SELECT * FROM api_cache WHERE cache_key = ? AND expires_at > ?"
      )
      .get(cacheKey, new Date().toISOString()) as
      | Record<string, unknown>
      | undefined;
  },

  setApiCache(
    cacheKey: string,
    source: string,
    response: unknown,
    ttlSeconds: number
  ) {
    const now = new Date();
    const expires = new Date(now.getTime() + ttlSeconds * 1000);
    getDb()
      .prepare(
        `INSERT INTO api_cache (cache_key, source, response, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           response = excluded.response,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`
      )
      .run(
        cacheKey,
        source,
        JSON.stringify(response),
        now.toISOString(),
        expires.toISOString()
      );
  },

  pruneApiCache() {
    getDb()
      .prepare("DELETE FROM api_cache WHERE expires_at <= ?")
      .run(new Date().toISOString());
  },

  /**
   * Every producer with an Instagram handle, across all scans, joined to the
   * album they were credited on. Deduplication happens in the API layer so it
   * can keep the highest-confidence row per producer while still listing all
   * the albums they appear on.
   */
  getAllContacts() {
    return getDb()
      .prepare(
        `SELECT p.name, p.instagram, p.ig_status, p.ig_confidence,
                p.track_titles, p.ig_profile_data,
                s.artist, s.album, s.id AS scan_id, s.created_at
         FROM producers p
         JOIN scans s ON s.id = p.scan_id
         WHERE p.instagram IS NOT NULL AND p.instagram != ''
         ORDER BY p.ig_confidence DESC`
      )
      .all() as Record<string, unknown>[];
  },

  // ── Outreach tracking (CRM) ──────────────────────────────────────────
  getAllCrm() {
    return getDb()
      .prepare("SELECT * FROM contact_crm")
      .all() as Record<string, unknown>[];
  },

  /**
   * Upsert only the provided fields. Passing `undefined` leaves a column
   * untouched, so toggling "emailed" never wipes a manually-typed address.
   */
  upsertCrm(entry: {
    name_normalized: string;
    display_name?: string;
    email?: string | null;
    email_source?: string | null;
    emailed_at?: string | null;
    follow_up_at?: string | null;
    notes?: string | null;
  }) {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO contact_crm (
           name_normalized, display_name, email, email_source,
           emailed_at, follow_up_at, notes, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name_normalized) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, display_name),
           email        = COALESCE(excluded.email, email),
           email_source = COALESCE(excluded.email_source, email_source),
           emailed_at   = COALESCE(excluded.emailed_at, emailed_at),
           follow_up_at = COALESCE(excluded.follow_up_at, follow_up_at),
           notes        = COALESCE(excluded.notes, notes),
           updated_at   = excluded.updated_at`
      )
      .run(
        entry.name_normalized,
        entry.display_name ?? null,
        entry.email ?? null,
        entry.email_source ?? null,
        entry.emailed_at ?? null,
        entry.follow_up_at ?? null,
        entry.notes ?? null,
        now
      );
  },

  /**
   * Explicitly blank a field. COALESCE in upsertCrm can only set values, so
   * clearing an email or un-marking "emailed" needs its own path.
   */
  clearCrmField(
    nameNormalized: string,
    field: "email" | "emailed_at" | "follow_up_at" | "notes"
  ) {
    getDb()
      .prepare(
        `UPDATE contact_crm SET ${field} = NULL, updated_at = ? WHERE name_normalized = ?`
      )
      .run(new Date().toISOString(), nameNormalized);
  },
};
