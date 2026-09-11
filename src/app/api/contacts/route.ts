import { db } from "@/lib/db";
import { normalizeProducerName } from "@/lib/cache";
import { extractContactFromText } from "@/lib/extract-email";

export interface Contact {
  key: string;
  name: string;
  instagram: string;
  ig_status: string;
  ig_confidence: number;
  bio: string;
  followers: number | null;
  /** Every album this producer was credited on. */
  albums: { artist: string; album: string; scanId: string }[];
  /** Outreach state (persisted, survives re-scans). */
  email: string;
  /** "bio" = auto-detected from the Instagram bio, "manual" = typed by the user. */
  emailSource: string;
  emailedAt: string | null;
  followUpAt: string | null;
  notes: string;
}

function parseFollowers(raw: unknown): number | null {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

export async function GET() {
  const rows = db.getAllContacts();

  const crmByKey = new Map<string, Record<string, unknown>>();
  for (const c of db.getAllCrm()) {
    crmByKey.set(c.name_normalized as string, c);
  }

  // Deduplicate by producer identity: the same producer appears once per scanned
  // album. Keep the highest-confidence record (rows arrive sorted desc) and
  // accumulate every album they show up on.
  const byProducer = new Map<string, Contact>();

  for (const r of rows) {
    const name = r.name as string;
    const instagram = r.instagram as string;
    const key = normalizeProducerName(name) || instagram.toLowerCase();

    let profile: { bio?: string; followers?: unknown } = {};
    try {
      const raw = r.ig_profile_data;
      if (typeof raw === "string" && raw && raw !== "null") {
        profile = JSON.parse(raw);
      }
    } catch {
      // keep defaults
    }

    const albumEntry = {
      artist: r.artist as string,
      album: r.album as string,
      scanId: r.scan_id as string,
    };

    const existing = byProducer.get(key);
    if (existing) {
      const already = existing.albums.some(
        (a) => a.album === albumEntry.album && a.artist === albumEntry.artist
      );
      if (!already) existing.albums.push(albumEntry);
      // A later (lower-confidence) row may still carry the bio that holds the email.
      if (!existing.bio && profile.bio) existing.bio = profile.bio as string;
      if (!existing.email && existing.bio) {
        const auto = extractContactFromText(existing.bio);
        if (auto) {
          existing.email = auto.value;
          existing.emailSource = auto.kind;
        }
      }
      continue;
    }

    const bio = (profile.bio as string) || "";
    const crm = crmByKey.get(key);

    // A user-entered address always wins over auto-detection.
    const storedEmail = (crm?.email as string) || "";
    const autoRoute = storedEmail ? null : extractContactFromText(bio);
    const autoEmail = autoRoute?.value || "";

    byProducer.set(key, {
      key,
      name,
      instagram,
      ig_status: r.ig_status as string,
      ig_confidence: (r.ig_confidence as number) || 0,
      bio,
      followers: parseFollowers(profile.followers),
      albums: [albumEntry],
      email: storedEmail || autoEmail,
      // "none" is an internal marker meaning "already probed, nothing found";
      // it must never surface as a source label in the UI.
      emailSource: storedEmail
        ? ((crm?.email_source as string) === "none"
            ? "manual"
            : (crm?.email_source as string) || "manual")
        : autoRoute
          ? autoRoute.kind
          : "",
      emailedAt: (crm?.emailed_at as string) || null,
      followUpAt: (crm?.follow_up_at as string) || null,
      notes: (crm?.notes as string) || "",
    });
  }

  const contacts = [...byProducer.values()].sort((a, b) => {
    const rank = (c: Contact) => (c.ig_status === "confirmed" ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (b.ig_confidence !== a.ig_confidence) return b.ig_confidence - a.ig_confidence;
    return a.name.localeCompare(b.name);
  });

  return Response.json({
    contacts,
    stats: {
      total: contacts.length,
      confirmed: contacts.filter((c) => c.ig_status === "confirmed").length,
      probable: contacts.filter((c) => c.ig_status === "probable").length,
      withEmail: contacts.filter((c) => c.email).length,
      emailed: contacts.filter((c) => c.emailedAt).length,
    },
  });
}

/** Update one contact's outreach fields. Empty string clears a field. */
export async function PATCH(request: Request) {
  const body = await request.json();
  const { key, name, email, emailedAt, followUpAt, notes } = body as {
    key?: string;
    name?: string;
    email?: string;
    emailedAt?: string | null;
    followUpAt?: string | null;
    notes?: string;
  };

  if (!key) {
    return Response.json({ error: "Missing key" }, { status: 400 });
  }

  try {
    db.upsertCrm({
      name_normalized: key,
      display_name: name,
      // Typed values are always "manual" so auto-detection can't overwrite them.
      email: email ? email.trim() : undefined,
      email_source: email ? "manual" : undefined,
      emailed_at: emailedAt || undefined,
      follow_up_at: followUpAt || undefined,
      notes: notes || undefined,
    });

    // Explicit clears (COALESCE upsert can only set values).
    if (email === "") db.clearCrmField(key, "email");
    if (emailedAt === null) db.clearCrmField(key, "emailed_at");
    if (followUpAt === null) db.clearCrmField(key, "follow_up_at");
    if (notes === "") db.clearCrmField(key, "notes");

    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
