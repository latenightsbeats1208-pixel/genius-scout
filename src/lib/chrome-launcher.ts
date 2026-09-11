import { spawn } from "child_process";
import { cpSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { probeCdp, CDP_PORT, resetBrowser } from "./browser";

/**
 * Launches (or reuses) the dedicated Chrome that carries the Spotify and
 * Instagram sessions.
 *
 * Instagram blocks curl, so a logged-in browser is the ONLY way to read a
 * profile. Requiring the user to remember to start Chrome-Spotify.bat first
 * meant "Compléter les emails" silently did nothing. Now the server starts it.
 *
 * The profile directory matches Chrome-Spotify.bat exactly, so the already
 * logged-in session is reused rather than a fresh, signed-out one.
 */

// Under the user profile root: the old LOCALAPPDATA location was silently
// wiped around some reboots, which logged the user out of everything.
const PROFILE_DIR = path.join(
  process.env.USERPROFILE || ".",
  "GeniusScoutData",
  "ChromeProfile"
);
const LEGACY_PROFILE_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || ".", "AppData", "Local"),
  "GeniusScoutChrome"
);

function findChrome(): string | null {
  const candidates = [
    path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      "Google/Chrome/Application/chrome.exe"
    ),
    path.join(
      process.env.LOCALAPPDATA || "",
      "Google/Chrome/Application/chrome.exe"
    ),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ChromeStatus {
  ok: boolean;
  launched: boolean;
  detail: string;
}

/**
 * Guarantee a CDP-reachable Chrome. Returns ok=false with an actionable reason
 * rather than throwing, so callers can surface it to the user.
 */
export async function ensureChrome(): Promise<ChromeStatus> {
  const initial = await probeCdp();
  if (initial.ok) {
    return { ok: true, launched: false, detail: `Chrome déjà ouvert (${initial.browser})` };
  }

  // Port taken by something that isn't Chrome (Adobe UXP squats 9222 on this
  // machine). Launching would not help — tell the user instead.
  if (initial.browser) {
    return {
      ok: false,
      launched: false,
      detail: `Le port ${CDP_PORT} est occupé par « ${initial.browser} », pas Chrome. Ferme cette application ou change GENIUS_CDP_PORT.`,
    };
  }

  const chrome = findChrome();
  if (!chrome) {
    return {
      ok: false,
      launched: false,
      detail: "Google Chrome introuvable sur cette machine.",
    };
  }

  try {
    // Salvage whatever sessions survived in the legacy location, once.
    if (!existsSync(PROFILE_DIR) && existsSync(LEGACY_PROFILE_DIR)) {
      cpSync(LEGACY_PROFILE_DIR, PROFILE_DIR, { recursive: true });
    }
  } catch {
    /* fresh profile then */
  }
  try {
    mkdirSync(PROFILE_DIR, { recursive: true });
  } catch {
    /* directory may already exist */
  }

  // detached + ignored stdio so Chrome outlives this request and never blocks
  // the Node event loop on a full pipe buffer.
  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://www.instagram.com/",
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();

  // Chrome needs a moment before the debugging endpoint answers.
  for (let i = 0; i < 20; i++) {
    await sleep(750);
    const probe = await probeCdp();
    if (probe.ok) {
      // Drop any cached headless browser so the next read uses this session.
      await resetBrowser();
      return {
        ok: true,
        launched: true,
        detail: `Chrome lancé (${probe.browser})`,
      };
    }
  }

  return {
    ok: false,
    launched: true,
    detail:
      "Chrome a été lancé mais ne répond pas sur le port de debug. Vérifie qu'aucune autre fenêtre Chrome ne bloque le profil dédié.",
  };
}
