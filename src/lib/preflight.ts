import { chromium } from "playwright";
import { spotifyApi } from "./spotify-api";
import { curlText } from "./curl";
import { probeCdp, CDP_PORT, CDP_URL } from "./browser";

/**
 * Pre-flight dependency checks.
 *
 * Rationale: a missing Playwright browser silently killed BOTH the Spotify
 * credits agent and the Google Instagram agent, and the scan still reported
 * "success" with a fraction of the real producers. A broken dependency must be
 * loud and visible BEFORE the user waits ten minutes for a degraded scan.
 */

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
  critical: boolean;
}

export interface HealthReport {
  ok: boolean;
  degraded: boolean;
  checks: HealthCheck[];
  checkedAt: string;
}

let cached: { report: HealthReport; at: number } | null = null;
const CACHE_MS = 60_000;

/**
 * Which browser will actually drive the agents?
 *
 * `getBrowser()` prefers the user's dedicated Chrome over CDP and only falls
 * back to Playwright's headless Chromium when that Chrome is absent. The old
 * check ignored that order and launched Chromium unconditionally: on an
 * end-user PC (installer, no `playwright install`) it showed a critical
 * "Chromium non installé" while every agent was happily running in Chrome.
 * Chromium is now only probed — and only critical — when Chrome is missing.
 */
async function checkBrowser(cdpOk: boolean): Promise<HealthCheck> {
  const name = "Navigateur des agents";
  if (cdpOk) {
    return {
      name,
      ok: true,
      detail: "Chrome dédié connecté — c'est lui qui pilote les agents (Chromium de secours non requis)",
      critical: false,
    };
  }
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return {
      name,
      ok: true,
      // Usable, but blind: no Spotify/Instagram session → the Chrome check
      // below says what is lost.
      detail: "Chrome dédié absent — repli sur Chromium headless (sans session Spotify ni Instagram)",
      critical: false,
    };
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    const missing = /Executable doesn't exist/i.test(msg);
    return {
      name,
      ok: false,
      detail: missing
        ? "Aucun navigateur : ni Chrome dédié, ni Chromium → agents Spotify, Google et Instagram HORS SERVICE. Relance le raccourci Genius Scout (Chrome), ou installe le secours : npx playwright install chromium"
        : msg,
      critical: true,
    };
  }
}

function checkSpotify(): HealthCheck {
  const ok = spotifyApi.isConfigured();
  return {
    name: "Spotify API",
    ok,
    detail: ok
      ? "Identifiants présents"
      : "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET manquants dans .env.local",
    critical: true,
  };
}

async function checkCurl(): Promise<HealthCheck> {
  const out = await curlText("https://www.instagram.com/instagram/", {
    timeoutMs: 8000,
  });
  const ok = out !== null && out.includes('"username"');
  return {
    name: "Accès Instagram (curl)",
    ok,
    detail: ok
      ? "Profils Instagram lisibles"
      : "Instagram ne renvoie pas de données (curl absent, réseau, ou rate-limit)",
    critical: false,
  };
}

/**
 * Can a profile actually be read, by the pathway the app really uses?
 *
 * The old check surfaced curl directly and showed a permanent "KO" once
 * Instagram blocked anonymous curl for everyone. Users read that as "Instagram
 * is broken" even while logged in — but a login can never fix curl, which sends
 * no cookies. What matters is the fallback the app actually uses: the dedicated
 * Chrome and its `sessionid` cookie.
 */
async function checkInstagramAccess(
  curlWorks: boolean,
  cdpOk: boolean
): Promise<HealthCheck> {
  const name = "Lecture des profils Instagram";
  if (curlWorks) {
    return {
      name,
      ok: true,
      critical: false,
      detail: "Profils lisibles en direct (curl)",
    };
  }
  if (!cdpOk) {
    return {
      name,
      ok: false,
      critical: true,
      detail:
        "curl est bloqué par Instagram ET le Chrome dédié est absent : aucun profil ne peut être lu. Relance le raccourci Genius Scout.",
    };
  }
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const ctx = browser.contexts()[0];
    const cookies = ctx ? await ctx.cookies("https://www.instagram.com") : [];
    // Do NOT close the browser: it is the user's window.
    const signedIn = cookies.some((c) => c.name === "sessionid" && c.value);
    return {
      name,
      ok: signedIn,
      critical: !signedIn,
      detail: signedIn
        ? "Profils lus via le Chrome dédié (session Instagram active). La voie rapide curl est bloquée par Instagram pour tout le monde — sans impact."
        : "Chrome dédié ouvert mais PAS connecté à Instagram → ouvre instagram.com dans la fenêtre Chrome dédiée, connecte-toi, puis relance la vérification.",
    };
  } catch (e) {
    return {
      name,
      ok: false,
      critical: true,
      detail: `Vérification impossible : ${(e as Error).message.split("\n")[0]}`,
    };
  }
}

/**
 * The logged-in Chrome (CDP) carries the Spotify AND Instagram sessions.
 *
 * Criticality is dynamic: when curl can still read Instagram, a missing Chrome
 * only costs Spotify credits (degraded). But once Instagram blocks curl — which
 * is now the norm — Chrome becomes the ONLY way to read a profile, and without
 * it every candidate is rejected for "no musical evidence". That produced a scan
 * with 0 confirmed out of 17 producers while the app reported "Dependencies OK".
 */
async function checkChromeSession(curlWorks: boolean): Promise<HealthCheck> {
  const probe = await probeCdp();
  const name = "Session Chrome (Spotify + Instagram)";
  if (probe.ok) {
    return {
      name,
      ok: true,
      detail: `Chrome connecté (${probe.browser}) — sessions Spotify et Instagram utilisées`,
      critical: false,
    };
  }

  const igBlocked = !curlWorks;
  const base = probe.browser
    ? `Le port ${CDP_PORT} est occupé par « ${probe.browser} » (pas Chrome). Ferme cette appli ou change GENIUS_CDP_PORT.`
    : "Chrome debug absent. Lance Chrome-Spotify.bat puis connecte-toi à Spotify et Instagram.";

  return {
    name,
    ok: false,
    critical: igBlocked,
    detail: igBlocked
      ? `${base} ⛔ curl étant bloqué par Instagram, AUCUN profil ne peut être vérifié : tous les producteurs seraient rejetés à tort.`
      : `${base} Les crédits Spotify seront indisponibles (albums récents = peu de producteurs).`,
  };
}

/**
 * Verify the dedicated Chrome is actually SIGNED IN to Spotify.
 *
 * Reachability over CDP is not enough: the browser can be up while signed out,
 * and Spotify only exposes producer credits to a logged-in session. That gap
 * made the app report "Chrome connecté — les crédits Spotify seront extraits"
 * while every Spotify scan silently returned 0 credits (spclient answered 401).
 * The session cookie `sp_dc` is the reliable tell.
 */
async function checkSpotifyLogin(cdpOk: boolean): Promise<HealthCheck> {
  const name = "Connexion Spotify (crédits)";
  if (!cdpOk) {
    return {
      name,
      ok: false,
      critical: false,
      detail: "Chrome dédié absent — impossible de vérifier la session Spotify.",
    };
  }
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const ctx = browser.contexts()[0];
    const cookies = ctx ? await ctx.cookies("https://open.spotify.com") : [];
    // Do NOT close the browser: it is the user's window.
    const signedIn = cookies.some((c) => c.name === "sp_dc");
    return {
      name,
      ok: signedIn,
      critical: false,
      detail: signedIn
        ? "Session Spotify active — les crédits seront extraits"
        : "NON connecté à Spotify → aucun crédit Spotify ne peut être lu (401). Connecte-toi à Spotify dans la fenêtre Chrome dédiée : c'est la seule source de crédits pour les albums que Genius n'a pas encore annotés.",
    };
  } catch (e) {
    return {
      name,
      ok: false,
      critical: false,
      detail: `Vérification impossible : ${(e as Error).message.split("\n")[0]}`,
    };
  }
}

function checkAnthropic(): HealthCheck {
  const ok = Boolean(process.env.ANTHROPIC_API_KEY);
  return {
    name: "Claude (validation IA)",
    ok,
    detail: ok ? "Clé API présente" : "ANTHROPIC_API_KEY manquante — validation heuristique seule",
    critical: false,
  };
}

export async function checkHealth(force = false): Promise<HealthReport> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.report;
  }

  // Curl status decides whether Chrome is merely useful or strictly required.
  const curlCheck = await checkCurl();
  const chromeCheck = await checkChromeSession(curlCheck.ok);
  const checks: HealthCheck[] = [
    await checkBrowser(chromeCheck.ok),
    checkSpotify(),
    chromeCheck,
    await checkSpotifyLogin(chromeCheck.ok),
    // curl reste sondé (il pilote la criticité de Chrome) mais n'est plus
    // affiché tel quel : on montre la lecture réelle des profils.
    await checkInstagramAccess(curlCheck.ok, chromeCheck.ok),
    checkAnthropic(),
  ];

  const report: HealthReport = {
    ok: checks.every((c) => c.ok),
    degraded: checks.some((c) => !c.ok && c.critical),
    checks,
    checkedAt: new Date().toISOString(),
  };

  cached = { report, at: Date.now() };
  return report;
}
