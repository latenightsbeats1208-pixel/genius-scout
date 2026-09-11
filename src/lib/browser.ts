import { chromium, type Browser, type Page } from "playwright";

let _browser: Browser | null = null;
let _cdpMode = false;

/**
 * CDP port for the user's logged-in Chrome.
 *
 * NOT 9222: on this machine Adobe UXP (Creative Cloud plugin runtime) squats
 * 9222 and answers /json/version, so Playwright would try to drive Adobe's
 * runtime instead of Chrome. We use a port nothing else claims, and we verify
 * the endpoint is really Chrome/Chromium before trusting it.
 */
export const CDP_PORT = Number(process.env.GENIUS_CDP_PORT || 9333);
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

/** True only if the CDP endpoint is an actual Chrome/Chromium browser. */
export async function probeCdp(): Promise<{ ok: boolean; browser: string }> {
  try {
    const resp = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!resp.ok) return { ok: false, browser: "" };
    const info = (await resp.json()) as { Browser?: string };
    const name = info.Browser || "";
    const isChrome = /chrome|chromium|headless/i.test(name);
    return { ok: isChrome, browser: name };
  } catch {
    return { ok: false, browser: "" };
  }
}

export async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;

  // Try the user's logged-in Chrome first (needed for Spotify credits).
  const probe = await probeCdp();
  if (probe.ok) {
    try {
      _browser = await chromium.connectOverCDP(CDP_URL);
      _cdpMode = true;
      console.log(`[browser] Connected via CDP ${CDP_URL} (${probe.browser})`);
      return _browser;
    } catch {
      // fall through to headless
    }
  }

  _browser = await chromium.launch({ headless: true });
  _cdpMode = false;
  console.log("[browser] Launched headless Chromium (no logged-in Chrome on CDP)");
  return _browser;
}

export async function createPage(): Promise<Page> {
  const browser = await getBrowser();
  const context = _cdpMode
    ? browser.contexts()[0] || (await browser.newContext())
    : await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        locale: "fr-FR",
        timezoneId: "Europe/Paris",
        viewport: { width: 1366, height: 768 },
      });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  return page;
}

export function isCdpMode(): boolean {
  return _cdpMode;
}

/**
 * Drop the cached browser so the next call re-probes for CDP. Without this, a
 * headless browser created before the user started their Chrome would be reused
 * forever and Spotify credits would stay empty for the whole session.
 */
export async function resetBrowser(): Promise<void> {
  if (_browser && !_cdpMode) {
    await _browser.close().catch(() => {});
  }
  _browser = null;
  _cdpMode = false;
}
