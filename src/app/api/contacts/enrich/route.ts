import { db } from "@/lib/db";
import { normalizeProducerName } from "@/lib/cache";
import { extractContactFromText } from "@/lib/extract-email";
import { fetchInstagramProfile } from "@/lib/instagram";
import { ensureChrome } from "@/lib/chrome-launcher";
import { probeCdp } from "@/lib/browser";

/**
 * Fill the email column for contacts that don't have one yet.
 *
 * Most historical contacts carry no bio: they were scanned before the
 * browser-based Instagram reader existed (curl was blocked, so profiles came
 * back empty), and the old Genius fast-path confirmed handles without ever
 * visiting the profile. Re-scanning whole albums just to collect bios would be
 * wasteful, so this re-reads only the profiles we still lack an email for.
 *
 * Bounded batches: each profile is a real browser page load, so the client calls
 * this repeatedly and shows progress rather than hanging on one huge request.
 */
const BATCH_SIZE = 15;

/**
 * Consecutive unreadable profiles that mean "the browser is broken" rather than
 * "these accounts have no bio". Without this guard a closed Chrome made every
 * contact look permanently checked: 42 rows were burned that way.
 */
const FAILURE_ABORT_THRESHOLD = 3;

export async function POST() {
  // Start the logged-in Chrome if it isn't already up — without it Instagram is
  // unreadable and the whole pass would be pointless.
  const chrome = await ensureChrome();
  if (!chrome.ok) {
    return Response.json(
      { error: chrome.detail, processed: 0, found: 0, remaining: -1 },
      { status: 503 }
    );
  }

  const rows = db.getAllContacts();
  const crmByKey = new Map<string, Record<string, unknown>>();
  for (const c of db.getAllCrm()) crmByKey.set(c.name_normalized as string, c);

  // One entry per producer, keeping only those with no known email.
  const pending = new Map<string, { name: string; handle: string }>();
  for (const r of rows) {
    const name = r.name as string;
    const handle = r.instagram as string;
    if (!handle) continue;
    const key = normalizeProducerName(name) || handle.toLowerCase();
    if (pending.has(key)) continue;

    const crm = crmByKey.get(key);
    if (crm?.email) continue; // already known

    let bio = "";
    try {
      const raw = r.ig_profile_data;
      if (typeof raw === "string" && raw && raw !== "null") {
        bio = (JSON.parse(raw).bio as string) || "";
      }
    } catch {
      /* ignore */
    }
    if (bio && extractContactFromText(bio)) continue;

    // Already read successfully and found nothing: don't re-read forever.
    if (crm?.email_source === "none") continue;

    pending.set(key, { name, handle });
  }

  const batch = [...pending.entries()].slice(0, BATCH_SIZE);
  let found = 0;
  let processed = 0;
  let consecutiveFailures = 0;
  let aborted = false;

  for (const [key, { name, handle }] of batch) {
    const profile = await fetchInstagramProfile(handle);

    if (!profile) {
      // Could be a dead account OR a broken browser. Only the latter must not
      // be recorded, so ask the browser whether it is still alive.
      const stillUp = await probeCdp();
      if (!stillUp.ok) {
        aborted = true;
        break;
      }
      consecutiveFailures++;
      if (consecutiveFailures >= FAILURE_ABORT_THRESHOLD) {
        aborted = true;
        break;
      }
      // Genuinely unreadable profile: record it so we move on next time.
      db.upsertCrm({
        name_normalized: key,
        display_name: name,
        email_source: "none",
      });
      processed++;
      continue;
    }

    consecutiveFailures = 0;
    // Email when published, otherwise the real booking route (manager IG,
    // phone, site) — producers rarely list an address.
    const route = extractContactFromText(profile.bio || "");
    if (route) {
      db.upsertCrm({
        name_normalized: key,
        display_name: name,
        email: route.value,
        email_source: route.kind,
      });
      found++;
    } else {
      db.upsertCrm({
        name_normalized: key,
        display_name: name,
        email_source: "none",
      });
    }
    processed++;
  }

  if (aborted) {
    return Response.json(
      {
        error:
          "Lecture Instagram interrompue (profils illisibles à la suite). Vérifie que tu es connecté à Instagram dans la fenêtre Chrome dédiée, puis relance.",
        processed,
        found,
        remaining: Math.max(0, pending.size - processed),
        chrome: chrome.detail,
      },
      { status: 503 }
    );
  }

  return Response.json({
    processed,
    found,
    remaining: Math.max(0, pending.size - processed),
    chrome: chrome.detail,
  });
}
