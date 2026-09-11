/**
 * Pull a business email out of an Instagram bio.
 *
 * Producers routinely publish their booking address in the bio
 * ("Music Producer | mgmt@fri3nds.lol"), so the contact column can be
 * pre-filled for free instead of being researched by hand.
 *
 * The regex deliberately requires a dotted TLD: bios are full of "@handle"
 * mentions, and matching those as emails would fill the column with garbage.
 */
const EMAIL_RE =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g;

/** Addresses that are never a real contact route. */
const BLOCKED = [
  /@(?:instagram|facebook|threads|tiktok|twitter|x)\.com$/i,
  /\.(?:png|jpe?g|gif|webp|mp3|wav)$/i,
  /^(?:no-?reply|noreply|donotreply)@/i,
  /@(?:example|test|domain)\.(?:com|org)$/i,
];

/** Prefer a business inbox over a personal one when several are present. */
const PRIORITY = [
  /^(?:mgmt|management)@/i,
  /^(?:booking|bookings)@/i,
  /^(?:contact|hello|info)@/i,
  /^(?:business|biz|sync|licensing)@/i,
];

/**
 * Contact routes other than email.
 *
 * Reading 75 producer bios returned zero emails but plenty of real routes:
 * "@brandon_bfm for all inquiries", "MGMT: @bytialong", "Text Me: 689-…".
 * In this industry the booking path is usually a manager's Instagram, so
 * treating email as the only valid contact left the column almost empty.
 */
export type ContactKind = "email" | "mgmt_ig" | "phone" | "site";

export interface ContactRoute {
  value: string;
  kind: ContactKind;
}

/** Keywords that mark a nearby handle as the business contact. */
const MGMT_CONTEXT =
  /(?:mgmt|management|manager|booking|bookings|inquir(?:y|ies)|contact|business|features?|beats?\s+for\s+sale|for\s+all)/i;

function extractMgmtHandle(text: string): string | null {
  if (!text) return null;
  // Look at each bio segment; keep a handle only when the same segment also
  // carries a business keyword, so ordinary shout-outs aren't mistaken for it.
  for (const segment of text.split(/[|\n•]/)) {
    if (!MGMT_CONTEXT.test(segment)) continue;
    const handles = [...segment.matchAll(/@([A-Za-z0-9._]{3,30})/g)].map((m) => m[1]);
    for (const h of handles) {
      // Skip platform names and obvious non-accounts.
      if (/^(?:gmail|yahoo|hotmail|outlook|icloud|instagram|threads)$/i.test(h)) continue;
      return `@${h}`;
    }
  }
  return null;
}

function extractPhone(text: string): string | null {
  if (!text) return null;
  // Only trust a number when the bio explicitly invites contact, otherwise
  // dates and stats would match.
  if (!/(?:text|call|whatsapp|sms|t[ée]l|phone)/i.test(text)) return null;
  const m = text.match(/(\+?\d[\d\s().-]{7,17}\d)/);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return m[1].trim();
}

/**
 * Link aggregators: these reliably lead to a contact/booking section, so they
 * count as a route.
 */
const AGGREGATORS =
  /^(?:linktr\.ee|beacons\.ai|linkin\.bio|komi\.io|solo\.to|hoo\.be|link\.me|taplink\.\w+|milkshake\.app|campsite\.bio|allmylinks\.com|snipfeed\.co)/i;

/**
 * Domains that are a reference or a release link, never a way to reach someone.
 * Without this the column filled up with wikipedia.org/wiki/Dre_Moon and
 * genius.com/artists/… — which look like data but are useless for outreach.
 */
const NOT_CONTACT_DOMAINS =
  /(?:soundcloud|spotify|music\.apple|apple\.co|youtube|youtu\.be|deezer|tidal|audiomack|bandcamp|wikipedia|genius|discogs|allmusic|imdb|orcd\.co|ffm\.to|fanlink|distrokid|smarturl|lnk\.to|songwhip|hypeddit|unitedmasters|found\.ee|bfan\.link|twitter|x\.com|facebook|tiktok|threads|snapchat|onlyfans)/i;

function extractSite(text: string): string | null {
  if (!text) return null;
  const matches = [
    ...text.matchAll(
      /\b([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|co|io|lol|me|fm|bio|app|link|to|ee|ai)(?:\/[A-Za-z0-9._~\-/?=&%]*)?)/gi
    ),
  ].map((m) => m[1].replace(/[.,;:]+$/, ""));

  // Aggregators first — they're the most likely to carry booking details.
  const aggregator = matches.find((v) => AGGREGATORS.test(v));
  if (aggregator) return aggregator;

  const own = matches.find((v) => !NOT_CONTACT_DOMAINS.test(v));
  return own || null;
}

/**
 * Best available contact route, email first. Returns null when the bio offers
 * nothing actionable.
 */
export function extractContactFromText(text: string): ContactRoute | null {
  const email = extractEmailFromText(text);
  if (email) return { value: email, kind: "email" };

  const mgmt = extractMgmtHandle(text);
  if (mgmt) return { value: mgmt, kind: "mgmt_ig" };

  const phone = extractPhone(text);
  if (phone) return { value: phone, kind: "phone" };

  const site = extractSite(text);
  if (site) return { value: site, kind: "site" };

  return null;
}

export function extractEmailFromText(text: string): string | null {
  if (!text) return null;

  // Bios often mangle the address: "name (at) domain.com" / "name [at] domain"
  const deobfuscated = text
    .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@")
    .replace(/\s+at\s+(?=[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi, "@")
    .replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".");

  const found = [...deobfuscated.matchAll(EMAIL_RE)]
    .map((m) => m[0].replace(/[.,;:]+$/, ""))
    .filter((e) => !BLOCKED.some((re) => re.test(e)));

  if (found.length === 0) return null;

  for (const pattern of PRIORITY) {
    const hit = found.find((e) => pattern.test(e));
    if (hit) return hit.toLowerCase();
  }
  return found[0].toLowerCase();
}
