import type { IgCandidate, Producer, EventEmitter } from "./types";
import { createPage } from "@/lib/browser";
import { delay } from "@/lib/delays";
import { instagramHandleExists, isCurlUsable } from "@/lib/instagram";
import { nameMatchHandle } from "@/lib/name-match";

// Strip curly quotes, parentheses, brackets, and other punctuation that
// breaks variant generation (e.g. Mark "Keitel Jr" Lowe).
function cleanName(s: string): string {
  return s
    .replace(/[‘’“”'"`]/g, "")
    .replace(/[()[\]{}]/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  return cleanName(s)
    .toLowerCase()
    .split(/[\s\-]+/)
    .map((p) => p.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
}

function pushUnique(arr: string[], v: string) {
  if (v && v.length >= 3 && !arr.includes(v)) arr.push(v);
}

// Conservative variant generation. We intentionally DROP generic decorations
// (xbeats / xmusic / djx / thex / imx) and bare short single tokens, because
// those match random unrelated accounts and were the main source of false
// positives. Only variants that plausibly ARE the producer's handle are kept;
// the arbiter's name gate still re-verifies every survivor.
function variantsForName(name: string): string[] {
  const out: string[] = [];
  const cleaned = cleanName(name);
  const norm = cleaned.toLowerCase().replace(/[^a-z0-9]/g, "");
  const parts = tokenize(name);

  pushUnique(out, norm);
  if (parts.length > 1) {
    pushUnique(out, parts.join("."));
    pushUnique(out, parts.join("_"));
  }

  // First + last only (skips middle nicknames like Mark "Keitel Jr" Lowe → marklowe)
  if (parts.length >= 3) {
    const fl = parts[0] + parts[parts.length - 1];
    pushUnique(out, fl);
    pushUnique(out, `${parts[0]}.${parts[parts.length - 1]}`);
    pushUnique(out, `${parts[0]}_${parts[parts.length - 1]}`);
  }

  // Single-token variant ONLY if it is a distinctive stage name (>= 6 chars).
  // Short first names like "mike"/"alex" match random people → excluded.
  for (const p of parts) {
    if (p.length >= 6) pushUnique(out, p);
  }

  return out;
}

function extractQuotedNickname(name: string): string | null {
  const m = name.match(/[‘’“”'"`]([^‘’“”'"`]{2,40})[‘’“”'"`]/);
  return m ? m[1].trim() : null;
}

function generateHandleVariants(
  name: string,
  aliases: string[],
  twitterHandle?: string
): string[] {
  const variants: string[] = [];

  for (const v of variantsForName(name)) pushUnique(variants, v);

  const nick = extractQuotedNickname(name);
  if (nick) {
    for (const v of variantsForName(nick)) pushUnique(variants, v);
  }

  for (const alias of aliases) {
    for (const v of variantsForName(alias)) pushUnique(variants, v);
  }

  // Twitter handle (strong signal — often identical to the IG handle)
  if (twitterHandle) {
    const tw = twitterHandle
      .replace("@", "")
      .toLowerCase()
      .replace(/[^a-z0-9._]/g, "");
    pushUnique(variants, tw);
  }

  return variants;
}

// Async existence check (curl when usable, browser otherwise).
async function handleExists(handle: string): Promise<boolean> {
  return instagramHandleExists(handle);
}

export async function agentGoogle(
  producer: Producer,
  artist: string,
  emit: EventEmitter
): Promise<IgCandidate[]> {
  const candidates: IgCandidate[] = [];

  // Strategy 1: Handle guessing + existence verification.
  const twitterCandidate = producer.ig_candidates.find(
    (c) => c.source === "GENIUS_TWITTER"
  );
  const variants = generateHandleVariants(
    producer.name,
    producer.aliases,
    twitterCandidate?.handle
  );

  const curlOk = await isCurlUsable();

  if (curlOk) {
    emit(
      "ig_search",
      "agent_google",
      `Test de ${Math.min(variants.length, 16)} variantes pour ${producer.name}`
    );
    for (const handle of variants.slice(0, 16)) {
      if (await handleExists(handle)) {
        const m = nameMatchHandle(producer.name, producer.aliases, handle);
        const score = m.level === "strong" ? 8 : m.level === "moderate" ? 6 : 4;
        candidates.push({ handle, score, source: "HANDLE_GUESS" });
        emit("ig_found", "agent_google", `Handle existe → @${handle} (nom: ${m.level})`);
      }
      await delay.short();
    }
  } else {
    // curl is blocked by Instagram: verifying 16 variants through a real browser
    // would take minutes per producer. Instead we propose the best name-matching
    // variants unverified and let the arbiter (which visits profiles anyway)
    // decide. Without this the producer ended up with ZERO candidates.
    const scored = variants
      .map((h) => ({ h, m: nameMatchHandle(producer.name, producer.aliases, h) }))
      .filter((x) => x.m.level === "strong" || x.m.level === "moderate")
      .slice(0, 5);

    emit(
      "ig_search",
      "agent_google",
      `curl bloqué par Instagram → ${scored.length} variante(s) proposée(s) sans pré-vérification pour ${producer.name}`
    );

    for (const { h, m } of scored) {
      candidates.push({
        handle: h,
        score: m.level === "strong" ? 6 : 4,
        source: "HANDLE_GUESS",
      });
    }
  }

  // Strategy 2: Google search (catches handles that don't follow the name).
  let page;
  try {
    page = await createPage();
    const cleanedName = cleanName(producer.name);
    const query = `"${cleanedName}" "${artist}" instagram producer`;
    await page.goto(
      `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 15000 }
    );
    await delay.medium();

    const consentBtn = await page.$(
      'button:has-text("Tout accepter"), button:has-text("Accept all")'
    );
    if (consentBtn) {
      await consentBtn.click().catch(() => {});
      await delay.short();
    }

    const igHandles = await page.evaluate(() => {
      const handles: string[] = [];
      const links = document.querySelectorAll("a[href*='instagram.com']");
      for (const link of links) {
        const href = (link as HTMLAnchorElement).href;
        const match = href.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
        if (
          match &&
          !["explore", "p", "reel", "accounts", "stories"].includes(match[1])
        ) {
          handles.push(match[1]);
        }
      }
      const bodyText = document.body.innerText;
      const textMatches = bodyText.matchAll(
        /instagram\.com\/([a-zA-Z0-9._]{2,30})/g
      );
      for (const m of textMatches) {
        if (!["explore", "p", "reel", "accounts", "stories"].includes(m[1])) {
          handles.push(m[1]);
        }
      }
      return [...new Set(handles)];
    });

    for (const handle of igHandles) {
      if (
        !candidates.find((c) => c.handle.toLowerCase() === handle.toLowerCase())
      ) {
        // Google results are noisy; score them by name correspondence so the
        // arbiter visits the plausible ones first.
        const m = nameMatchHandle(producer.name, producer.aliases, handle);
        const score = m.level === "strong" ? 7 : m.level === "moderate" ? 5 : 3;
        candidates.push({ handle, score, source: "GOOGLE_SEARCH" });
        emit(
          "ig_found",
          "agent_google",
          `Google → @${handle} (nom: ${m.level})`
        );
      }
    }
  } catch (e) {
    emit(
      "error",
      "agent_google",
      `Erreur Google pour ${producer.name}: ${(e as Error).message}`
    );
  } finally {
    if (page) await page.close().catch(() => {});
  }

  return candidates;
}
