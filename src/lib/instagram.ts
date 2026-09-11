import { createPage } from "./browser";
import { curlInstagramProfile, curlText, type IgRawProfile } from "./curl";

/**
 * Instagram access layer.
 *
 * Instagram now hard-blocks plain curl (returns 0 bytes, even for @instagram),
 * which silently destroyed handle discovery: existence checks all returned
 * false, so producers ended up with zero candidates. We therefore probe once
 * per process and fall back to a real browser (the user's logged-in Chrome via
 * CDP when available, else headless Chromium).
 */

let curlUsable: boolean | null = null;

/** One-shot probe: is curl still able to read Instagram? */
export async function isCurlUsable(): Promise<boolean> {
  if (curlUsable !== null) return curlUsable;
  const html = await curlText("https://www.instagram.com/instagram/", {
    timeoutMs: 8000,
  });
  curlUsable = Boolean(html && html.includes('"username"'));
  return curlUsable;
}

export function resetCurlProbe(): void {
  curlUsable = null;
}

/** Parse the JSON blob Instagram embeds in the profile HTML. */
function parseProfileHtml(html: string, handle: string): IgRawProfile | null {
  if (!html) return null;
  if (html.includes("Page Not Found") || html.includes("page isn't available")) {
    return null;
  }
  const usernameMatch = html.match(/"username":"([^"]+)"/);
  if (!usernameMatch) return null;

  const unesc = (s: string) =>
    s
      .replace(/\\n/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\\\//g, "/")
      .replace(/\\u[\dA-Fa-f]{4}/g, (m) =>
        String.fromCharCode(parseInt(m.slice(2), 16))
      )
      .trim();

  const bioMatch = html.match(/"biography":"((?:[^"\\]|\\.)*)"/);
  const nameMatch = html.match(/"full_name":"((?:[^"\\]|\\.)*)"/);
  const followersMatch = html.match(/"edge_followed_by":\{"count":(\d+)\}/);
  const privateMatch = html.match(/"is_private":(true|false)/);
  const verifiedMatch = html.match(/"is_verified":(true|false)/);
  const extUrlMatch = html.match(/"external_url":"((?:[^"\\]|\\.)*)"/);
  const catMatch = html.match(/"category_name":"((?:[^"\\]|\\.)*)"/);

  const posts: string[] = [];
  for (const m of html.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)) {
    const text = unesc(m[1]);
    if (text.length > 10 && text.length < 400) {
      posts.push(text);
      if (posts.length >= 8) break;
    }
  }

  return {
    username: usernameMatch[1] || handle,
    fullName: nameMatch ? unesc(nameMatch[1]) : "",
    bio: bioMatch ? unesc(bioMatch[1]) : "",
    followers: followersMatch ? Number(followersMatch[1]) : null,
    isPrivate: privateMatch ? privateMatch[1] === "true" : false,
    isVerified: verifiedMatch ? verifiedMatch[1] === "true" : false,
    posts,
    externalUrl: extUrlMatch && extUrlMatch[1] ? unesc(extUrlMatch[1]) : null,
    category: catMatch && catMatch[1] ? unesc(catMatch[1]) : null,
  };
}

/** A profile whose fields are all empty carries no evidence — treat as thin. */
function isThin(p: IgRawProfile | null): boolean {
  if (!p) return true;
  return !p.fullName && !p.bio && p.followers === null && p.posts.length === 0;
}

function parseFollowerCount(text: string): number | null {
  // Matches "8,185 followers", "97K followers", "97,3 k followers", "1.2M followers"
  const m = text.match(/([\d][\d\s.,]*)\s*([KkMm])?\s*(?:followers|abonn)/i);
  if (!m) return null;
  const raw = m[1].replace(/\s/g, "");
  // French uses "," as decimal separator ("97,3 k"); English uses it as thousands
  const suffix = (m[2] || "").toLowerCase();
  let n: number;
  if (suffix && /,\d{1,2}$/.test(raw)) n = parseFloat(raw.replace(",", "."));
  else n = parseFloat(raw.replace(/,/g, ""));
  if (!isFinite(n)) return null;
  if (suffix === "k") n *= 1_000;
  if (suffix === "m") n *= 1_000_000;
  return Math.round(n);
}

/**
 * Read a profile through a real browser.
 *
 * IMPORTANT: when the browser is LOGGED IN, Instagram embeds the *viewer's own*
 * account in the page JSON first, so a naive `"username":"..."` regex returns
 * the signed-in user for every profile visited. We therefore drive the read off
 * og:title, which always names the profile actually being viewed, and we verify
 * the handle it reports matches the one we requested before trusting anything.
 */
async function fetchViaBrowser(handle: string): Promise<IgRawProfile | null> {
  const safe = handle.replace(/[^a-zA-Z0-9._]/g, "");
  if (!safe) return null;
  let page;
  try {
    page = await createPage();
    const resp = await page.goto(`https://www.instagram.com/${safe}/`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    if (resp && resp.status() === 404) return null;
    await page.waitForTimeout(1800);

    // NOTE: no named inner functions inside evaluate — bundlers (esbuild/tsx)
    // rewrite them to reference a `__name` helper that does not exist in the
    // page, which throws "ReferenceError: __name is not defined".
    const info = await page.evaluate(() => {
      const ogTitle =
        document
          .querySelector('meta[property="og:title"]')
          ?.getAttribute("content") || "";
      const ogDesc =
        document
          .querySelector('meta[property="og:description"]')
          ?.getAttribute("content") || "";
      const header = document.querySelector("header");
      const posts: string[] = [];
      const imgs = document.querySelectorAll("article img[alt], main img[alt]");
      for (let i = 0; i < imgs.length && posts.length < 8; i++) {
        const alt = imgs[i].getAttribute("alt") || "";
        if (alt.length > 15 && !/photo de profil|profile picture/i.test(alt)) {
          posts.push(alt.slice(0, 200));
        }
      }
      const body = document.body.innerText || "";
      return {
        ogTitle,
        ogDesc,
        headerText: header ? (header as HTMLElement).innerText : "",
        posts,
        isPrivate:
          /Ce compte est privé|This account is private|Ce compte est prive/i.test(body),
        notFound:
          /Page Not Found|page isn't available|Cette page n'est pas disponible/i.test(
            body
          ),
      };
    });

    if (info.notFound) return null;

    // og:title → "Daniel Gonzalez (@playpicasso) • Photos et vidéos Instagram"
    const handleInTitle = info.ogTitle.match(/\(@([A-Za-z0-9._]+)\)/);
    if (handleInTitle && handleInTitle[1].toLowerCase() !== safe.toLowerCase()) {
      // We were redirected or read the wrong profile — refuse rather than guess.
      return null;
    }

    let fullName = "";
    if (info.ogTitle) {
      const before = info.ogTitle.split(/\s*\(@/)[0];
      fullName = before.trim();
    }

    // Non-existent profiles render an empty shell: no og:title, no header.
    if (!info.ogTitle && !info.headerText.trim()) return null;

    // Header lines: handle, display name, "N publications", "N followers",
    // "N suivi(e)s", then the bio lines. Drop the structural ones.
    const bioLines = info.headerText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l.toLowerCase() !== safe.toLowerCase())
      .filter((l) => !fullName || l !== fullName)
      .filter(
        (l) =>
          !/^[\d\s.,kKmM]+\s*(publications?|posts?|followers|abonn|suivi|following)/i.test(
            l
          )
      )
      // Instagram's own action buttons render inside <header> and leaked into
      // the bio ("… | Contacter | Suivi(e)"). Drop them.
      .filter(
        (l) =>
          !/^(Suivre|Follow(ing)?|Message|S'abonner|Contacter?|Suivi\(e\)|Abonn[ée]|Highlights|Modifier le profil)$/i.test(
            l
          )
      )
      // "vawn_, geminichxld et 21 autres personnes suivent" / "Followed by ..."
      .filter((l) => !/(autres personnes suivent|personnes suivent|^Followed by )/i.test(l));

    const followers =
      parseFollowerCount(info.headerText) || parseFollowerCount(info.ogDesc);

    const result: IgRawProfile = {
      username: safe,
      fullName,
      bio: bioLines.join(" | ").slice(0, 500),
      followers,
      isPrivate: info.isPrivate,
      isVerified: false,
      posts: info.posts,
      externalUrl: null,
      category: null,
    };

    if (isThin(result)) {
      // Last resort: the embedded JSON, but only if it names OUR handle.
      const parsed = parseProfileHtml(await page.content(), safe);
      if (parsed && parsed.username.toLowerCase() === safe.toLowerCase()) {
        return parsed;
      }
      return result.fullName || result.bio ? result : null;
    }
    return result;
  } catch (e) {
    // Surface the reason: a silently-swallowed error here previously looked
    // identical to "profile does not exist" and hid real breakage.
    console.error(
      `[instagram] lecture @${safe} echouee:`,
      (e as Error).message.split("\n")[0]
    );
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Best-effort profile read: curl when it still works (fast), browser otherwise.
 * Returns null when the profile does not exist.
 */
export async function fetchInstagramProfile(
  handle: string
): Promise<IgRawProfile | null> {
  if (await isCurlUsable()) {
    const viaCurl = await curlInstagramProfile(handle);
    if (viaCurl && !isThin(viaCurl)) return viaCurl;
    if (viaCurl) {
      // Exists but thin — try the browser for real fields, keep curl as floor.
      const rich = await fetchViaBrowser(handle);
      return rich ?? viaCurl;
    }
    return null;
  }
  return fetchViaBrowser(handle);
}

/** Does this handle exist? Cheap when curl works, browser-backed otherwise. */
export async function instagramHandleExists(handle: string): Promise<boolean> {
  const p = await fetchInstagramProfile(handle);
  return p !== null;
}

export interface IgPost {
  url: string;
  caption: string;
  tagged: string[];
}

/**
 * Read recent post captions.
 *
 * This is the decisive evidence source: producers announce their placements,
 * e.g. "@torylanez Made You Think I Was Gone…But — 5. “Kody” [produced by Rowan
 * & @_2one2]". That proves BOTH that the account makes music AND that it worked
 * on this specific record — which a name match alone can never establish.
 *
 * Captions are not present in the profile HTML; they live on each post page in
 * og:description, so we open the top posts individually.
 */
export async function fetchRecentPosts(
  handle: string,
  maxPosts = 3
): Promise<IgPost[]> {
  const safe = handle.replace(/[^a-zA-Z0-9._]/g, "");
  if (!safe) return [];
  let page;
  const posts: IgPost[] = [];
  try {
    page = await createPage();
    await page.goto(`https://www.instagram.com/${safe}/`, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
    await page
      .waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 12000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    const links = await page.evaluate(() => {
      const out: { href: string; alt: string }[] = [];
      const els = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
      for (let i = 0; i < els.length && out.length < 8; i++) {
        const href = els[i].getAttribute("href") || "";
        const img = els[i].querySelector("img");
        out.push({ href, alt: img ? img.getAttribute("alt") || "" : "" });
      }
      return out;
    });

    for (const link of links.slice(0, maxPosts)) {
      if (!link.href) continue;
      try {
        await page.goto(`https://www.instagram.com${link.href}`, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
        await page.waitForTimeout(1200);
        const caption = await page.evaluate(() => {
          return (
            document
              .querySelector('meta[property="og:description"]')
              ?.getAttribute("content") || ""
          );
        });
        const combined = `${caption} ${link.alt}`;
        const tagged = [
          ...new Set(
            [...combined.matchAll(/@([A-Za-z0-9._]{2,30})/g)].map((m) => m[1])
          ),
        ];
        posts.push({
          url: `https://www.instagram.com${link.href}`,
          caption: combined.slice(0, 1200),
          tagged,
        });
      } catch {
        // skip this post
      }
    }
  } catch (e) {
    console.error(
      `[instagram] posts @${safe} echoue:`,
      (e as Error).message.split("\n")[0]
    );
  } finally {
    if (page) await page.close().catch(() => {});
  }
  return posts;
}
