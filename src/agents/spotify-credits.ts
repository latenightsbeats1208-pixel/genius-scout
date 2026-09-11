import type { ProducerCredit, EventEmitter } from "./types";
import { createPage, isCdpMode } from "@/lib/browser";
import { delay } from "@/lib/delays";
import { spotifyApi, type SpotifyTrack } from "@/lib/spotify-api";
import type { Page } from "playwright";

/**
 * Dismiss the OneTrust consent banner.
 *
 * This was the reason Spotify credits never worked: the banner stays on top and
 * swallows every click, so opening a track's "…" menu actually landed on the
 * cookie/privacy dialog. The previous selector (#onetrust-accept-btn-handler)
 * does not exist on this page — the real ids are the reject/allow handlers below.
 * We decline non-essential cookies, which dismisses the banner just as well.
 */
async function dismissConsent(page: Page) {
  const selectors = [
    "#onetrust-reject-all-handler",
    ".ot-pc-refuse-all-handler",
    "#onetrust-accept-btn-handler",
    "#accept-recommended-btn-handler",
    'button[data-testid*="accept"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn && (await btn.isVisible().catch(() => false))) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        await delay.short();
        break;
      }
    } catch {
      // try the next selector
    }
  }

  // Whatever remains (privacy/language dialogs stacked on top) is removed so it
  // cannot intercept pointer events.
  try {
    await page.evaluate(() => {
      document
        .querySelectorAll("#onetrust-consent-sdk, #onetrust-banner-sdk, .onetrust-pc-dark-filter")
        .forEach((el) => el.remove());
    });
  } catch {
    // ignore
  }
}

async function extractCreditsFromModal(page: Page): Promise<string[]> {
  await page
    .waitForSelector(
      '[role="dialog"], [data-testid="credits-modal"], div[aria-label*="redits"]',
      { timeout: 8000 }
    )
    .catch(() => {});
  await delay.medium();

  return page.evaluate(() => {
    const credits = new Set<string>();

    // The page keeps several hidden [role="dialog"] nodes (language picker,
    // localisation, privacy). Taking the first one returned the language list
    // instead of the credits, so pick the VISIBLE dialog that actually contains
    // credit role labels.
    const ROLE_HINT =
      /(?:interpr[ée]t|[ée]crit par|produit par|performed by|written by|produced by|source\s*:)/i;

    const candidates = [
      ...document.querySelectorAll('[data-testid="credits-modal"], [role="dialog"]'),
    ].filter((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    const dialog =
      candidates.find((el) => ROLE_HINT.test((el as HTMLElement).innerText || "")) ||
      candidates[candidates.length - 1] ||
      document.body;

    const allText = ((dialog as HTMLElement).innerText || dialog.textContent || "").split("\n");
    let currentRole = "";
    for (let i = 0; i < allText.length; i++) {
      const line = allText[i].trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      if (
        lower === "performers" ||
        lower === "performed by" ||
        lower === "writers" ||
        lower === "written by" ||
        lower === "producers" ||
        lower === "produced by" ||
        lower === "composers" ||
        lower === "composed by" ||
        lower === "engineers" ||
        lower === "interprete" ||
        lower === "compositeur" ||
        lower === "compositeurs" ||
        lower === "producteur" ||
        lower === "producteurs"
      ) {
        currentRole = lower;
        continue;
      }
      if (
        currentRole.includes("produc") ||
        currentRole.includes("composer") ||
        currentRole.includes("written") ||
        currentRole.includes("writers") ||
        currentRole.includes("compos") ||
        currentRole.includes("engineer")
      ) {
        if (
          line.length > 1 &&
          line.length < 80 &&
          !line.includes("Source") &&
          !line.includes("Released") &&
          !line.match(/^\d/) &&
          !line.toLowerCase().includes("spotify")
        ) {
          credits.add(line);
        }
      }
    }

    const blocks = dialog.querySelectorAll(
      'div[class*="credit"], li[class*="credit"], span[class*="credit"]'
    );
    blocks.forEach((b) => {
      const txt = b.textContent?.trim();
      if (txt && txt.length > 1 && txt.length < 80) {
        const parent = b.closest('div[class*="role"], section, div[class*="Credit"]');
        if (parent) {
          const parentText = parent.textContent?.toLowerCase() || "";
          if (
            parentText.includes("produc") ||
            parentText.includes("composer") ||
            parentText.includes("written") ||
            parentText.includes("compos")
          ) {
            credits.add(txt);
          }
        }
      }
    });

    return Array.from(credits);
  });
}

/**
 * Lift the web player's own Bearer token by observing its outgoing requests.
 *
 * The credits endpoint rejects cookies alone (401) and Spotify's public token
 * endpoint now answers 400, so reverse-engineering the token flow is a dead end.
 * Letting the player authenticate itself and reusing the header it sends is both
 * simpler and far more robust. It also means ONE page load for the whole album
 * instead of one per track.
 */
async function captureBearerToken(
  page: Page,
  anyTrackUrl: string
): Promise<string | null> {
  let bearer: string | null = null;
  const onRequest = (req: { headers(): Record<string, string> }) => {
    if (bearer) return;
    const auth = req.headers()["authorization"];
    if (auth && auth.startsWith("Bearer ")) bearer = auth.slice(7);
  };
  page.on("request", onRequest);
  try {
    await page.goto(anyTrackUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissConsent(page);
    // The player issues its authenticated calls shortly after hydration.
    for (let i = 0; i < 12 && !bearer; i++) {
      await page.waitForTimeout(600);
    }
  } catch {
    // fall through with whatever we captured
  } finally {
    page.off("request", onRequest);
  }
  return bearer;
}

const CREDIT_ROLE_RE = /produc|compos|writ|beat|mix|engineer/i;

/** Structured credits straight from Spotify's own endpoint. */
async function getCreditsViaToken(
  page: Page,
  trackId: string,
  token: string
): Promise<{ credits: string[]; statut: string }> {
  try {
    const resp = (await page.evaluate(
      async ([id, tok]) => {
        try {
          const r = await fetch(
            `https://spclient.wg.spotify.com/track-credits-view/v0/experimental/${id}/credits`,
            { headers: { Authorization: `Bearer ${tok}`, "app-platform": "WebPlayer" } }
          );
          if (!r.ok) return { status: r.status, data: null };
          return { status: 200, data: await r.json() };
        } catch {
          return { status: -1, data: null };
        }
      },
      [trackId, token]
    )) as {
      status: number;
      data: { roleCredits?: { roleTitle: string; artists: { name: string }[] }[] } | null;
    };

    if (resp.status === 200 && resp.data?.roleCredits) {
      const credits: string[] = [];
      for (const role of resp.data.roleCredits) {
        if (!CREDIT_ROLE_RE.test(role.roleTitle || "")) continue;
        for (const a of role.artists || []) {
          if (a.name && !credits.includes(a.name)) credits.push(a.name);
        }
      }
      if (credits.length > 0) return { credits, statut: "OK_TOKEN_API" };
      return { credits: [], statut: "SPOTIFY_NO_CREDITS" };
    }
    return { credits: [], statut: `SPOTIFY_TOKEN_${resp.status}` };
  } catch {
    return { credits: [], statut: "SPOTIFY_TOKEN_ERROR" };
  }
}

async function getCreditsForTrack(
  page: Page,
  trackUrl: string,
  trackId: string
): Promise<{ credits: string[]; statut: string }> {
  // Method 1: Internal API (works only with logged-in session cookies via CDP)
  try {
    const creditsUrl = `https://spclient.wg.spotify.com/track-credits-view/v0/experimental/${trackId}/credits`;
    // We must navigate to a Spotify page first so the page evaluator runs in the right origin
    if (!page.url().includes("open.spotify.com")) {
      await page.goto(trackUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await delay.medium();
    }
    const resp = (await page.evaluate(async (url: string) => {
      try {
        const r = await fetch(url, {
          headers: {
            "app-platform": "WebPlayer",
            "spotify-app-version": "1.2.46.25",
          },
        });
        if (r.ok) return await r.json();
        return null;
      } catch {
        return null;
      }
    }, creditsUrl)) as
      | { roleCredits?: { roleTitle: string; artists: { name: string }[] }[] }
      | null;

    if (resp?.roleCredits) {
      const credits: string[] = [];
      for (const role of resp.roleCredits) {
        const t = (role.roleTitle || "").toLowerCase();
        if (
          t.includes("produc") ||
          t.includes("compos") ||
          t.includes("writ") ||
          t.includes("beat")
        ) {
          for (const a of role.artists || []) {
            if (a.name && !credits.includes(a.name)) credits.push(a.name);
          }
        }
      }
      if (credits.length > 0) return { credits, statut: "OK_INTERNAL_API" };
    }
  } catch {
    // continue to UI scrape
  }

  // Method 2: UI scrape with "Show credits"
  try {
    if (!page.url().includes(trackId)) {
      await page.goto(trackUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
      await delay.long();
    }
    // Must run AFTER navigation: the banner is re-injected on each page load.
    await dismissConsent(page);

    // The page lists related tracks, each with its own "…" button. Take the one
    // in the main action bar, otherwise we open the menu of a random other song.
    const moreBtn =
      (await page.$('[data-testid="action-bar-row"] button[aria-label*="options" i]')) ||
      (await page.$('main [data-testid="more-button"]')) ||
      (await page.$('main button[aria-label*="options" i], main button[aria-label*="More" i]'));

    if (moreBtn) {
      await moreBtn.click({ timeout: 5000 }).catch(() => {});
      await delay.medium();

      // Scope to the menu that just opened; "Crédits" (FR) / "Credits" (EN).
      const creditsItem =
        (await page.$('[role="menu"] [role="menuitem"]:has-text("rédit")')) ||
        (await page.$('[role="menu"] [role="menuitem"]:has-text("redit")')) ||
        (await page.$('[role="menuitem"]:has-text("rédit"), [role="menuitem"]:has-text("redit")'));

      if (creditsItem) {
        await creditsItem.click({ timeout: 5000 }).catch(() => {});
        await delay.medium();

        const credits = await extractCreditsFromModal(page);
        if (credits.length > 0) {
          return { credits, statut: "OK_WEBPLAYER" };
        }
      }
    }
  } catch {
    // fall through
  }

  return { credits: [], statut: "SPOTIFY_NO_CREDITS" };
}

function matchTitle(spotifyTitle: string, geniusTracks: string[]): string {
  const sLower = spotifyTitle.toLowerCase();
  return (
    geniusTracks.find(
      (t) =>
        t.toLowerCase().includes(sLower.slice(0, 8)) ||
        sLower.includes(t.toLowerCase().slice(0, 8))
    ) || spotifyTitle
  );
}

export async function extractSpotifyCredits(
  artist: string,
  album: string,
  tracks: string[],
  emit: EventEmitter
): Promise<ProducerCredit[]> {
  if (!spotifyApi.isConfigured()) {
    emit(
      "error",
      "spotify",
      "SPOTIFY_CLIENT_ID/SECRET manquants dans .env.local — agent Spotify desactive"
    );
    return tracks.map((t) => ({
      titre: t,
      credits: [],
      statut: "SPOTIFY_NOT_CONFIGURED",
      sourceUrl: null,
    }));
  }

  emit("step_start", "spotify", `Recherche album "${album}" via API officielle...`);

  const albumMatch = await spotifyApi.searchAlbum(artist, album);
  if (!albumMatch) {
    emit("error", "spotify", `Album "${album}" non trouve sur Spotify API`);
    return tracks.map((t) => ({
      titre: t,
      credits: [],
      statut: "SPOTIFY_ALBUM_NOT_FOUND",
      sourceUrl: null,
    }));
  }

  emit(
    "track_done",
    "spotify",
    `Album trouve: ${albumMatch.name} (${albumMatch.total_tracks} titres)`
  );

  const spotifyTracks: SpotifyTrack[] = await spotifyApi.getAlbumTracks(albumMatch.id);
  emit("track_done", "spotify", `${spotifyTracks.length} titres recuperes via API`);

  if (spotifyTracks.length === 0) {
    return tracks.map((t) => ({
      titre: t,
      credits: [],
      statut: "SPOTIFY_NO_TRACKS",
      sourceUrl: null,
    }));
  }

  // Now we need Playwright only to fetch credits per track (not in official API).
  const results: ProducerCredit[] = [];
  let page: Page | null = null;
  const headless = !isCdpMode();
  // In headless mode, Spotify's "Show credits" menu is rarely accessible
  // (no logged-in session). Bail out early after N consecutive empty tracks
  // to avoid wasting ~20s per track for nothing.
  const HEADLESS_ABORT_AFTER = 3;
  let consecutiveEmpty = 0;
  let aborted = false;

  try {
    page = await createPage();

    // Preferred path: one page load to lift the player's Bearer token, then a
    // direct API call per track. Orders of magnitude faster and more reliable
    // than driving the "Show credits" menu for every song.
    let token: string | null = null;
    if (isCdpMode()) {
      emit("step_start", "spotify", "Session Chrome - recuperation du jeton d'acces...");
      token = await captureBearerToken(page, spotifyTracks[0].url);
      emit(
        token ? "step_complete" : "error",
        "spotify",
        token
          ? "Jeton obtenu - extraction des credits via l'API Spotify"
          : "Jeton non obtenu - repli sur l'interface (plus lent). Verifie que tu es connecte a Spotify dans le Chrome dedie."
      );
    } else {
      emit(
        "step_start",
        "spotify",
        `Mode headless - extraction credits via UI publique (abandon apres ${HEADLESS_ABORT_AFTER} echecs)`
      );
    }

    for (const sTrack of spotifyTracks) {
      const matchedTitle = matchTitle(sTrack.title, tracks);

      if (aborted) {
        results.push({
          titre: matchedTitle,
          credits: [],
          statut: "SPOTIFY_HEADLESS_ABORTED",
          sourceUrl: sTrack.url,
        });
        continue;
      }

      emit("track_processing", "spotify", `Spotify credits → "${sTrack.title}"`);

      const { credits, statut } = token
        ? await getCreditsViaToken(page, sTrack.id, token)
        : await getCreditsForTrack(page, sTrack.url, sTrack.id);

      results.push({
        titre: matchedTitle,
        credits,
        statut,
        sourceUrl: sTrack.url,
      });

      emit(
        "track_done",
        "spotify",
        `${credits.length} credit(s) Spotify : ${credits.join(", ") || "aucun"} [${statut}]`
      );

      // Headless abort logic: stop after N consecutive empty results
      if (headless) {
        if (credits.length === 0) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= HEADLESS_ABORT_AFTER) {
            aborted = true;
            emit(
              "step_complete",
              "spotify",
              `Mode headless inefficace (${HEADLESS_ABORT_AFTER} echecs consecutifs) - abandon de l'extraction Spotify`
            );
          }
        } else {
          consecutiveEmpty = 0;
        }
      }

      await delay.short();
    }
  } catch (e) {
    emit("error", "spotify", `Erreur Spotify : ${(e as Error).message}`);
  } finally {
    if (page) await page.close().catch(() => {});
  }

  return results;
}
