// ============================================================================
// installer/build.mjs — chaîne de release complète de Genius Scout (Windows).
//
//   npm run package                            build Next + assemblage + anti-fuite
//                                              + démarrage à blanc + Inno Setup
//   node installer/build.mjs --no-next-build   réutilise le .next existant
//   node installer/build.mjs --assemble-only   s'arrête avant Inno Setup
//   node installer/build.mjs --smoke-port N    port du démarrage à blanc (3033,
//                                              repli automatique 3933+ si occupé)
//
// Charge utile produite dans installer/dist/GeniusScout :
//
//   GeniusScout/
//     GeniusScout.bat     lanceur (Chrome dédié port 9333 + serveur + navigateur)
//     server.bat          fenêtre du serveur (appelée par le lanceur)
//     GeniusScout.ico     icône des raccourcis
//     LISEZ-MOI.txt
//     env.example         modèle du fichier de clés (copié dans les données)
//     runtime/node.exe    Node embarqué (copie du node.exe du poste de build)
//     runtime/VERSION.txt
//     app/                sortie « standalone » de Next + .next/static + public
//       start.js          charge %USERPROFILE%\GeniusScoutData\.env puis server.js
//
// Les trois pièges du packaging Next « standalone », traités ici :
//  1. la sortie standalone recopie .env et tout ce que le traceur croise (ici :
//     le projet ENTIER, dist/ et legacy/ compris) → copie SÉLECTIVE, jamais brute ;
//  2. les chemins absolus du poste de build inscrits dans .next/server → réécrits
//     uniformément vers une racine neutre ;
//  3. les modules internes de Next ratés par le traceur → sous-arbres
//     next/dist/{lib,shared,server,client} complétés.
//
// Le contrôle anti-fuite est un VERROU : un seul terme personnel (identité,
// chemin du poste, secret de .env.local) dans la charge utile = pas d'installeur.
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(HERE);
const DIST = path.join(HERE, "dist");
const PAYLOAD = path.join(DIST, "GeniusScout");
const APP = path.join(PAYLOAD, "app");
const OUTPUT = path.join(HERE, "output");
const RUNTIME_CACHE = path.join(HERE, "runtime");

const APP_NAME = "Genius Scout";
const PORT = 3033;
const CDP_PORT = 9333;
const DATA_DIR_NAME = "GeniusScoutData";
/** Racine neutre substituée aux chemins absolus du poste de build. */
const NEUTRAL_ROOT = "C:\\GeniusScout\\build";

const log = (m) => process.stdout.write(`[build] ${m}\n`);
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " Mo";

// ---------------------------------------------------------------- utilitaires
function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** Sous-dossiers de paquets natifs inutiles à l'exécution (sources C, docs). */
const PACKAGE_JUNK = new Set(["src", "deps", "docs", "test", "benchmark", ".github"]);

/**
 * Copie récursive. Les LIENS SYMBOLIQUES sont matérialisés : Next 16 /
 * Turbopack place les paquets externes (serverExternalPackages, modules
 * natifs) dans `.next/standalone/.next/node_modules/<paquet>-<hash>` sous forme
 * de liens ABSOLUS vers le node_modules du poste de build — inutilisables une
 * fois installés ailleurs. On copie donc la cible réelle à la place du lien.
 */
function copyDir(src, dest, { skip = () => false } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (skip(entry.name, s)) continue;
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(s);
      const st = fs.statSync(target);
      if (st.isDirectory()) {
        copyDir(target, d, {
          skip: (name, full) => skip(name, full) || (path.dirname(full) === target && PACKAGE_JUNK.has(name)),
        });
      } else if (st.isFile()) {
        fs.copyFileSync(target, d);
      }
      continue;
    }
    if (entry.isDirectory()) copyDir(s, d, { skip });
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function dirSize(dir) {
  return walk(dir).reduce((n, f) => n + fs.statSync(f).size, 0);
}

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, "package.json"), "utf-8"));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error(`Version invalide dans package.json : « ${pkg.version} » (attendu X.Y.Z).`);
  }
  return pkg.version;
}

function findIscc() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error("ISCC.exe (Inno Setup 6) introuvable.");
  return found;
}

/**
 * Un port est « libre » si PERSONNE n'y répond. Tester par `listen` ne suffit
 * pas sous Windows : lier 127.0.0.1:3033 réussit même quand un autre serveur
 * écoute déjà sur 0.0.0.0:3033 — et le démarrage à blanc aurait interrogé le
 * serveur de dev au lieu du paquet.
 */
function portFree(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (free) => {
      sock.destroy();
      resolve(free);
    };
    sock.setTimeout(700);
    sock.once("connect", () => done(false));
    sock.once("timeout", () => done(true));
    sock.once("error", () => done(true));
  });
}

async function pickSmokePort(preferred) {
  if (await portFree(preferred)) return preferred;
  for (let p = 3933; p < 3960; p++) {
    if (await portFree(p)) {
      log(`  port ${preferred} occupé (serveur de dev en cours ?) → démarrage à blanc sur ${p}`);
      return p;
    }
  }
  throw new Error(`aucun port libre pour le démarrage à blanc (${preferred}, 3933-3959).`);
}

// ------------------------------------------------------ fichiers à EXCLURE
/** Ne doivent JAMAIS entrer dans la charge utile, quel que soit le dossier. */
const EXCLUDED_NAME = (name) =>
  /^\.env(\..*)?$/i.test(name) || // .env, .env.local, .env.production…
  /\.(db|db-wal|db-shm|db-journal|sqlite|sqlite3)$/i.test(name) ||
  /\.log$/i.test(name) ||
  /^logs?(-.*)?\.txt$/i.test(name) ||
  /\.nft\.json$/i.test(name); // manifests de traçage : listent tout ce que le traceur a vu

/** Dossiers du projet qui n'ont rien à faire à l'exécution. */
const EXCLUDED_TOP_DIRS = new Set(["data", "dist", "legacy", "logs", "src", ".claude", "installer"]);

// ------------------------------------------------- réécriture des chemins abs
/**
 * Webpack/Turbopack sérialisent le chemin absolu du projet dans les bundles
 * serveur et les manifests (identifiants de modules, `dir` de la config). Ce
 * sont des IDENTIFIANTS : seule leur cohérence sur toute l'arborescence compte.
 * Substitution uniforme dans les trois encodages rencontrés (échappé, brut,
 * slashs avant) ; un chemin dans un fichier NON textuel fait échouer le build.
 */
function rewriteAbsolutePaths(root, projectRoot) {
  const bs = projectRoot.replace(/\//g, "\\");
  const forms = [
    [bs.replace(/\\/g, "\\\\"), NEUTRAL_ROOT.replace(/\\/g, "\\\\")], // échappé d'abord
    [bs, NEUTRAL_ROOT],
    [bs.replace(/\\/g, "/"), NEUTRAL_ROOT.replace(/\\/g, "/")],
  ];
  const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".map", ".txt", ".html", ".css", ".ts", ".bat"]);
  let filesTouched = 0;
  let replacements = 0;
  const binaryHits = [];

  for (const file of walk(root)) {
    const buf = fs.readFileSync(file);
    let text = buf.toString("latin1");
    const lower = text.toLowerCase();
    if (!forms.some(([from]) => lower.includes(from.toLowerCase()))) continue;

    if (!TEXT_EXT.has(path.extname(file).toLowerCase())) {
      binaryHits.push(path.relative(root, file));
      continue;
    }
    let count = 0;
    for (const [from, to] of forms) {
      // Insensible à la casse (C:\Users vs c:\users), en préservant le reste.
      const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "gi");
      text = text.replace(re, () => {
        count++;
        return to;
      });
    }
    fs.writeFileSync(file, Buffer.from(text, "latin1"));
    filesTouched++;
    replacements += count;
  }
  if (binaryHits.length) {
    throw new Error(
      "Chemin absolu du poste trouvé dans des fichiers non textuels :\n  " +
        binaryHits.slice(0, 10).join("\n  ")
    );
  }
  return { filesTouched, replacements };
}

/**
 * Complète les sous-arbres du runtime Next ratés par le traceur (require
 * dynamiques) : n'ajoute QUE les fichiers absents, sans sourcemaps ni .d.ts.
 */
function completeNextRuntime() {
  const from = path.join(PROJECT, "node_modules", "next", "dist");
  const to = path.join(APP, "node_modules", "next", "dist");
  if (!fs.existsSync(to)) throw new Error("app/node_modules/next/dist absent de la sortie standalone.");
  let added = 0;
  for (const sub of ["lib", "shared", "server", "client"]) {
    const src = path.join(from, sub);
    if (!fs.existsSync(src)) continue;
    for (const file of walk(src)) {
      if (file.endsWith(".map") || file.endsWith(".d.ts")) continue;
      const dest = path.join(to, path.relative(from, file));
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      added++;
    }
  }
  return added;
}

/**
 * better-sqlite3 est un module natif déclaré en serverExternalPackages : le
 * traceur le copie normalement avec son binaire. On s'en assure, et on
 * recopie le paquet complet (avec ses dépendances d'exécution) s'il manque.
 */
function ensureBetterSqlite() {
  const NATIVE = path.join("build", "Release", "better_sqlite3.node");
  const dest = path.join(APP, "node_modules", "better-sqlite3");
  if (fs.existsSync(path.join(dest, NATIVE))) return "présent dans la sortie standalone";
  for (const pkg of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
    const src = path.join(PROJECT, "node_modules", pkg);
    if (!fs.existsSync(src)) throw new Error(`node_modules/${pkg} introuvable — npm install ?`);
    rmrf(path.join(APP, "node_modules", pkg));
    copyDir(src, path.join(APP, "node_modules", pkg), {
      // Sources C++ et scripts d'installation : inutiles à l'exécution.
      skip: (name, full) => pkg === "better-sqlite3" && path.dirname(full) === src && PACKAGE_JUNK.has(name),
    });
  }
  if (!fs.existsSync(path.join(dest, NATIVE))) {
    throw new Error(`Binaire natif ${NATIVE} introuvable même dans node_modules du projet.`);
  }
  return "recopié depuis node_modules du projet (avec bindings, file-uri-to-path)";
}

// ----------------------------------------------------------- fichiers écrits
/**
 * app/start.js — le server.js standalone de Next ne charge AUCUN fichier .env.
 * Ce bootstrap lit %USERPROFILE%\GeniusScoutData\.env (ou GENIUS_ENV_FILE),
 * pose les variables absentes de l'environnement, puis charge server.js dans
 * le même processus.
 */
const START_JS = `// Genius Scout - bootstrap : charge le fichier .env de l'utilisateur puis
// demarre le serveur Next standalone (server.js ne lit aucun .env lui-meme).
"use strict";
const fs = require("fs");
const path = require("path");

const envFile =
  process.env.GENIUS_ENV_FILE ||
  path.join(process.env.USERPROFILE || process.cwd(), ${JSON.stringify(DATA_DIR_NAME)}, ".env");

const loaded = [];
try {
  let text = fs.readFileSync(envFile, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM du Bloc-notes
  for (const rawLine of text.split(/\\r?\\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (!value) continue; // "CLE=" vide : on laisse la variable indefinie
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  console.log("[genius-scout] " + envFile + " : " + (loaded.length ? loaded.join(", ") : "aucune cle renseignee"));
} catch (e) {
  if (e && e.code === "ENOENT") {
    console.log("[genius-scout] pas de fichier " + envFile + " (mode sans cles API)");
  } else {
    console.log("[genius-scout] " + envFile + " illisible : " + (e && e.message));
  }
}

process.env.NODE_ENV = "production";
if (!process.env.PORT) process.env.PORT = ${JSON.stringify(String(PORT))};
if (!process.env.HOSTNAME) process.env.HOSTNAME = "127.0.0.1";

require("./server.js");
`;

/**
 * server.bat — la fenêtre du serveur, ouverte par le lanceur. Séparée du
 * lanceur pour éviter toute gymnastique de guillemets dans `start cmd /k`.
 */
const SERVER_BAT = `@echo off
title Genius Scout - Serveur (ne pas fermer)
cd /d "%~dp0app"
set "PORT=${PORT}"
set "HOSTNAME=127.0.0.1"
set "NODE_ENV=production"
set "GENIUS_ENV_FILE=%USERPROFILE%\\${DATA_DIR_NAME}\\.env"
echo.
echo  Serveur Genius Scout : http://localhost:${PORT}
echo  Laisse cette fenetre ouverte pendant l'utilisation.
echo  Pour arreter Genius Scout : ferme cette fenetre.
echo.
"%~dp0runtime\\node.exe" start.js
echo.
echo  Le serveur s'est arrete (code %ERRORLEVEL%).
pause
`;

/**
 * GeniusScout.bat — adapté de Genius-Scout.bat (le lanceur de développement) :
 * même logique Chrome dédié (port 9333, profil sous %USERPROFILE%\GeniusScoutData),
 * mais le serveur est le Node embarqué + start.js, et le fichier .env de
 * l'utilisateur est créé au premier lancement depuis env.example.
 * Structure en goto, PAS en blocs parenthésés (voir le commentaire d'origine).
 */
const LAUNCHER_BAT = `@echo off
setlocal
title Genius Scout
cd /d "%~dp0"

REM ============================================================
REM  Genius Scout - lanceur (raccourci Bureau / menu Demarrer)
REM
REM  Structure en goto, PAS en blocs parentheses : dans un bloc
REM  (...) cmd developpe %VAR% au moment du PARSE, avant les
REM  "set" internes (Chrome ne se lancait jamais apres un boot).
REM
REM  Donnees, cles API (.env) et profil Chrome sous
REM  %USERPROFILE%\\${DATA_DIR_NAME} - jamais dans le dossier d'installation.
REM ============================================================

set "PORT=${PORT}"
set "URL=http://localhost:%PORT%"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -Command"
set "GSDATA=%USERPROFILE%\\${DATA_DIR_NAME}"
set "PROFILE=%GSDATA%\\ChromeProfile"
set "ENVFILE=%GSDATA%\\.env"
set "NODE=%~dp0runtime\\node.exe"

REM --- Localisation de Chrome (niveau racine, jamais dans un bloc) ---
set "CHROME="
if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"
if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"
if exist "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe"

echo.
echo  ================================================
echo    GENIUS SCOUT
echo  ================================================
echo.

if not exist "%NODE%" goto :nonode

REM --- Dossier de donnees + fichier de cles (premier lancement) ---
if not exist "%GSDATA%" mkdir "%GSDATA%"
if exist "%ENVFILE%" goto :envok
echo  [1/4] Premier lancement : creation du fichier de cles API
echo         %ENVFILE%
copy /y "%~dp0env.example" "%ENVFILE%" >nul
echo         Colle tes cles dans ce fichier (optionnel), enregistre,
echo         puis relance Genius Scout pour qu'elles soient prises en compte.
start "" notepad "%ENVFILE%"
goto :chrome
:envok
echo  [1/4] Cles API : %ENVFILE%

:chrome
REM --- Chrome dedie (reduit) : sessions Spotify + Instagram ---
%PS% "$c=New-Object Net.Sockets.TcpClient; try{[void]$c.ConnectAsync('127.0.0.1',${CDP_PORT}).Wait(500)}catch{}; if($c.Connected){exit 0}else{exit 1}"
if not errorlevel 1 (
  echo  [2/4] Chrome dedie deja ouvert.
  goto :server
)
if not defined CHROME (
  echo  [2/4] ATTENTION : Google Chrome introuvable sur ce PC.
  echo         Installe Chrome pour lire les credits Spotify et Instagram.
  goto :server
)
echo  [2/4] Ouverture du Chrome dedie - credits Spotify...
REM Recupere les sessions de l'ancien emplacement, une seule fois.
if not exist "%PROFILE%" if exist "%LocalAppData%\\GeniusScoutChrome" robocopy "%LocalAppData%\\GeniusScoutChrome" "%PROFILE%" /E /NFL /NDL /NJH /NJS >nul
if not exist "%PROFILE%" mkdir "%PROFILE%"
REM Port ${CDP_PORT} : le 9222 est squatte par Adobe UXP. /min : la fenetre
REM reste dans la barre des taches, l'app s'ouvre dans TON Chrome normal.
start /min "" "%CHROME%" --remote-debugging-port=${CDP_PORT} --user-data-dir="%PROFILE%" "https://open.spotify.com"
%PS% "for($i=0;$i -lt 20;$i++){$c=New-Object Net.Sockets.TcpClient; try{[void]$c.ConnectAsync('127.0.0.1',${CDP_PORT}).Wait(500)}catch{}; if($c.Connected){exit 0}; Start-Sleep -Milliseconds 700}; exit 1"
if errorlevel 1 (
  echo         ATTENTION : le Chrome dedie n'a pas repondu sur le port ${CDP_PORT}.
)

:server
%PS% "$c=New-Object Net.Sockets.TcpClient; try{[void]$c.ConnectAsync('127.0.0.1',%PORT%).Wait(500)}catch{}; if($c.Connected){exit 0}else{exit 1}"
if not errorlevel 1 (
  echo  [3/4] Serveur deja en cours sur le port %PORT%.
  goto :attente
)
echo  [3/4] Demarrage du serveur sur le port %PORT%...
start "Genius Scout - Serveur (ne pas fermer)" cmd /k call "%~dp0server.bat"

:attente
echo  [4/4] Attente du serveur...
%PS% "for($i=0;$i -lt 90;$i++){try{$r=Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 3; if($r.StatusCode -ge 200){exit 0}}catch{}; Start-Sleep -Milliseconds 700}; exit 1"
if errorlevel 1 (
  echo.
  echo  Le serveur n'a pas repondu. Regarde la fenetre
  echo  "Genius Scout - Serveur" pour le message d'erreur.
  pause
  exit /b 1
)

start "" "%URL%"

echo.
echo  ================================================
echo    Genius Scout est ouvert : %URL%
echo    Pour arreter : ferme la fenetre du serveur.
echo  ================================================
timeout /t 3 /nobreak >nul
exit /b 0

:nonode
echo  [ERREUR] %NODE% introuvable.
echo  Installation incomplete : reinstalle Genius Scout.
pause
exit /b 1
`;

function readmeText(version, nodeVersion) {
  return [
    `Genius Scout ${version}`,
    "=".repeat(20 + version.length),
    "",
    "QU'EST-CE QUE C'EST",
    "  Genius Scout scanne un album, extrait les credits producteurs",
    "  (Genius, Spotify, MusicBrainz, Discogs) et retrouve les comptes",
    "  Instagram des producteurs. Tout tourne en local sur ce PC :",
    `  le serveur n'ecoute que sur http://localhost:${PORT}.`,
    "",
    "LANCER",
    "  Raccourci « Genius Scout » (menu Demarrer ou Bureau). Le lanceur :",
    "    1. cree le fichier de cles API au premier lancement (voir plus bas) ;",
    `    2. ouvre un Chrome dedie (port ${CDP_PORT}, profil separe de ton Chrome`,
    "       habituel) : connecte-toi a Spotify et Instagram DEDANS, une fois,",
    "       et laisse-le ouvert pendant les scans ;",
    "    3. demarre le serveur dans une fenetre « Genius Scout - Serveur » ;",
    "    4. ouvre l'application dans ton navigateur habituel.",
    "  Pour arreter : ferme la fenetre « Genius Scout - Serveur ».",
    "",
    "PREREQUIS",
    "  - Windows 10/11 64 bits.",
    "  - Google Chrome installe (credits Spotify + lecture des profils",
    "    Instagram). Sans Chrome, seules les sources sans session",
    "    (Genius, MusicBrainz, Discogs) fonctionnent.",
    "  - Aucune installation de Node.js n'est necessaire : un runtime",
    `    Node ${nodeVersion} est embarque dans le dossier runtime\\.`,
    "",
    "CLES API (OPTIONNELLES)",
    `  Fichier : %USERPROFILE%\\${DATA_DIR_NAME}\\.env`,
    "  (cree au premier lancement a partir de env.example, ouvert dans le",
    "  Bloc-notes). Colle tes cles apres le signe = puis relance l'app.",
    "    ANTHROPIC_API_KEY      validation IA des comptes Instagram (Claude).",
    "                           Sans cle : validation heuristique seule.",
    "    SPOTIFY_CLIENT_ID      Spotify Web API (metadonnees + tracklist).",
    "    SPOTIFY_CLIENT_SECRET  Sans ces deux valeurs : credits Spotify",
    "                           desactives, les autres sources fonctionnent.",
    "    DISCOGS_TOKEN          Discogs. Sans jeton : acces anonyme, plus lent.",
    "    IG_VALIDATION_MODE     budget (recommande) | heuristic | llm",
    "",
    "OU SONT MES DONNEES",
    `  %USERPROFILE%\\${DATA_DIR_NAME}\\`,
    "    scans.db         base des scans et producteurs",
    "    .env             tes cles API",
    "    ChromeProfile\\   sessions du Chrome dedie (Spotify, Instagram)",
    "  Rien n'est ecrit dans le dossier d'installation.",
    "",
    "DESINSTALLER",
    "  Parametres Windows > Applications > Genius Scout > Desinstaller",
    "  (ou le raccourci « Desinstaller Genius Scout » du menu Demarrer).",
    `  Tes donnees (%USERPROFILE%\\${DATA_DIR_NAME}) sont CONSERVEES :`,
    "  supprime ce dossier a la main si tu veux tout effacer.",
    "",
  ].join("\r\n");
}

// --------------------------------------------------------------- assemblage
function assemble(version) {
  const standalone = path.join(PROJECT, ".next", "standalone");
  const staticDir = path.join(PROJECT, ".next", "static");
  if (!fs.existsSync(path.join(standalone, "server.js"))) {
    throw new Error("`.next/standalone/server.js` absent — lancez `npm run build` (output: 'standalone').");
  }
  if (!fs.existsSync(staticDir)) throw new Error("`.next/static` absent.");

  log("nettoyage de installer/dist");
  rmrf(DIST);
  fs.mkdirSync(APP, { recursive: true });

  // 1. Sortie standalone : copie SÉLECTIVE. Le traceur a recopié le projet
  //    entier (dist/, legacy/, src/, .bat, logs…) : on ne prend que ce que
  //    server.js charge réellement.
  log("copie sélective de .next/standalone → app/");
  const skip = (name, full) => {
    if (EXCLUDED_NAME(name)) return true;
    if (path.dirname(full) === standalone && EXCLUDED_TOP_DIRS.has(name)) return true;
    return false;
  };
  for (const item of ["server.js", "package.json", ".next", "node_modules"]) {
    const src = path.join(standalone, item);
    if (!fs.existsSync(src)) throw new Error(`.next/standalone/${item} absent.`);
    if (fs.statSync(src).isDirectory()) copyDir(src, path.join(APP, item), { skip });
    else fs.copyFileSync(src, path.join(APP, item));
  }

  // 1 bis. Paquets externes matérialisés (liens symboliques → copies réelles).
  const extDir = path.join(APP, ".next", "node_modules");
  if (fs.existsSync(extDir)) {
    const ext = fs.readdirSync(extDir);
    log(`paquets externes Turbopack matérialisés : ${ext.length ? ext.join(", ") : "aucun"}`);
  }

  // 2. Statiques client + public (jamais inclus dans le standalone).
  log("copie de .next/static → app/.next/static");
  copyDir(staticDir, path.join(APP, ".next", "static"), { skip });
  const publicDir = path.join(PROJECT, "public");
  if (fs.existsSync(publicDir)) {
    log("copie de public/ → app/public");
    copyDir(publicDir, path.join(APP, "public"), { skip });
  }

  // 3. Modules manqués par le traceur + module natif.
  const completed = completeNextRuntime();
  log(`runtime Next complété : ${completed} fichiers internes ajoutés`);
  log(`better-sqlite3 : ${ensureBetterSqlite()}`);

  // 4. Bootstrap env + lanceurs + doc.
  fs.writeFileSync(path.join(APP, "start.js"), START_JS, "utf-8");
  fs.writeFileSync(path.join(PAYLOAD, "GeniusScout.bat"), LAUNCHER_BAT.replace(/\n/g, "\r\n"), "latin1");
  fs.writeFileSync(path.join(PAYLOAD, "server.bat"), SERVER_BAT.replace(/\n/g, "\r\n"), "latin1");
  fs.copyFileSync(path.join(HERE, "env.example"), path.join(PAYLOAD, "env.example"));
  const ico = path.join(PROJECT, "public", "GeniusScout.ico");
  if (!fs.existsSync(ico)) throw new Error("public/GeniusScout.ico introuvable.");
  fs.copyFileSync(ico, path.join(PAYLOAD, "GeniusScout.ico"));

  // 5. Neutralisation des chemins absolus du poste de build.
  log("réécriture des chemins absolus du poste de build");
  const { filesTouched, replacements } = rewriteAbsolutePaths(PAYLOAD, PROJECT);
  log(`  ${replacements} occurrences réécrites dans ${filesTouched} fichiers → ${NEUTRAL_ROOT}`);

  // 6. Runtime Node embarqué : copie du node.exe du poste de build.
  const nodeVersion = process.versions.node;
  const runtimeDir = path.join(PAYLOAD, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(RUNTIME_CACHE, { recursive: true });
  const cached = path.join(RUNTIME_CACHE, `node-v${nodeVersion}.exe`);
  if (!fs.existsSync(cached)) fs.copyFileSync(process.execPath, cached);
  fs.copyFileSync(cached, path.join(runtimeDir, "node.exe"));
  fs.writeFileSync(
    path.join(runtimeDir, "VERSION.txt"),
    `Node.js v${nodeVersion} (${process.arch})\r\nCopie du runtime du poste de build (${new Date().toISOString().slice(0, 10)}).\r\n`,
    "utf-8"
  );
  log(`runtime Node v${nodeVersion} embarqué`);

  fs.writeFileSync(path.join(PAYLOAD, "LISEZ-MOI.txt"), readmeText(version, `v${nodeVersion}`), "utf-8");

  const size = dirSize(PAYLOAD);
  log(`charge utile assemblée : ${mb(size)} → ${PAYLOAD}`);
  return { size, nodeVersion };
}

// ----------------------------------------------------------- anti-fuite
/**
 * Termes recherchés (insensibles à la casse) : identité de l'opérateur, chemin
 * du poste de build, et les VALEURS réelles des secrets de .env.local (lues
 * ici, jamais affichées, jamais écrites). Un terme est reconnu s'il n'est pas
 * précédé d'une lettre/chiffre — un identifiant camelCase de Playwright peut
 * contenir un prénom par coïncidence et ne désigne personne.
 */

/**
 * Identité de l'opérateur : JAMAIS en dur dans ce fichier versionné. Dérivée du
 * poste de build (nom de session Windows, dossier utilisateur) et complétée par
 * installer/leak-needles.operator.txt (une ligne par terme, non versionné :
 * pseudo, identifiants de conversation, etc.).
 */
function operatorNeedles() {
  const out = new Set();
  const user = (os.userInfo().username || "").trim();
  if (user.length >= 3) out.add(user);
  const home = process.env.USERPROFILE || os.homedir();
  if (home) out.add(home);
  const file = path.join(HERE, "leak-needles.operator.txt");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) out.add(t);
    }
  }
  return [...out];
}
const IDENTITY_NEEDLES = operatorNeedles();

function secretNeedles() {
  const out = [];
  const envLocal = path.join(PROJECT, ".env.local");
  if (!fs.existsSync(envLocal)) return out;
  for (const rawLine of fs.readFileSync(envLocal, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    // Les valeurs courtes (« budget ») ne sont pas des secrets et créeraient
    // des faux positifs partout.
    if (value.length >= 12) out.push(value);
  }
  return out;
}

function needleVariants(needle) {
  const v = new Set([needle]);
  if (needle.includes("\\")) {
    v.add(needle.replace(/\\/g, "\\\\"));
    v.add(needle.replace(/\\/g, "/"));
  }
  return [...v];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function checkLeaks(root) {
  const secrets = secretNeedles();
  const needles = [...IDENTITY_NEEDLES, ...secrets].flatMap(needleVariants);
  const asciiRes = needles.map((n) => ({
    label: secrets.includes(n) ? "secret de .env.local" : n,
    re: new RegExp("(?<![a-z0-9])" + escapeRe(n), "i"),
  }));

  const findings = [];
  let scanned = 0;
  for (const file of walk(root)) {
    scanned++;
    const rel = path.relative(root, file);
    const name = path.basename(file);
    if (/^\.env(\..*)?$/i.test(name) || /\.(db|db-wal|db-shm|sqlite3?)$/i.test(name) || /\.log$/i.test(name)) {
      findings.push({ file: rel, kind: "fichier interdit dans une distribution" });
      continue;
    }
    const buf = fs.readFileSync(file);
    const text = buf.toString("latin1");
    for (const { label, re } of asciiRes) {
      if (re.test(text)) findings.push({ file: rel, kind: label });
    }
    // Chaînes UTF-16LE (binaires Windows) : on décode aux deux alignements
    // possibles et on rejoue les mêmes motifs, insensibles à la casse.
    if (buf.length >= 2 && buf.includes(0)) {
      for (const aligned of [buf.toString("utf16le"), buf.subarray(1).toString("utf16le")]) {
        for (const { label, re } of asciiRes) {
          if (re.test(aligned)) findings.push({ file: rel, kind: label + " (UTF-16)" });
        }
      }
    }
  }
  return { findings, scanned, needleCount: needles.length, secretCount: secrets.length };
}

// ----------------------------------------------------- démarrage à blanc
/**
 * Lance le paquet tel qu'il sera installé (runtime\node.exe + app\start.js),
 * avec un PATH minimal et un profil utilisateur JETABLE (USERPROFILE →
 * dossier temporaire : base SQLite neuve, pas de .env). Prouve que le
 * runtime embarqué suffit, que better-sqlite3 se charge, et que la sortie
 * standalone est complète — avant de compresser l'installeur.
 */
async function smokeTest(port) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "genius-scout-smoke-"));
  const winDir = process.env.WINDIR || "C:\\Windows";
  const child = spawn(path.join(PAYLOAD, "runtime", "node.exe"), ["start.js"], {
    cwd: APP,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      // En MAJUSCULES : le CSPRNG d'OpenSSL (Node 24) lit « SYSTEMROOT » tel
      // quel dans le bloc d'environnement du fils et s'arrête net (assertion
      // ncrypto::CSPRNG) si la clé est écrite « SystemRoot ».
      SYSTEMROOT: winDir,
      WINDIR: winDir,
      SYSTEMDRIVE: winDir.slice(0, 2),
      TEMP: sandbox,
      TMP: sandbox,
      PATH: `${winDir}\\system32;${winDir}`,
      USERPROFILE: sandbox,
      LOCALAPPDATA: path.join(sandbox, "AppData", "Local"),
      APPDATA: path.join(sandbox, "AppData", "Roaming"),
      GENIUS_ENV_FILE: path.join(sandbox, DATA_DIR_NAME, ".env"),
      // Port CDP mort : le démarrage à blanc ne doit jamais toucher le Chrome
      // dédié de l'opérateur.
      GENIUS_CDP_PORT: "1",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    },
  });
  const out = [];
  child.stdout.on("data", (b) => out.push(b.toString()));
  child.stderr.on("data", (b) => out.push(b.toString()));

  const base = `http://127.0.0.1:${port}`;
  const get = async (route, timeoutMs) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + route, { redirect: "manual", signal: ctrl.signal });
      try { await res.body?.cancel(); } catch {}
      return res.status;
    } catch {
      return 0;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let rootStatus = 0;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && child.exitCode === null) {
      rootStatus = await get("/", 5000);
      if (rootStatus > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (rootStatus === 0) {
      throw new Error("le serveur assemblé n'a pas démarré :\n" + out.join("").slice(-2500));
    }
    // Routes GET sans effet de bord : pages, base SQLite, bilan de santé.
    const routes = ["/", "/history", "/contacts", "/api/history", "/api/scan/running", "/api/health"];
    const results = [];
    for (const route of routes) {
      const status = await get(route, 45000);
      results.push({ route, status });
    }
    const broken = results.filter((r) => r.status !== 200);
    if (broken.length) {
      const missing = (out.join("").match(/Cannot find module '[^']+'/g) || [])
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(", ");
      throw new Error(
        `routes en échec dans le paquet :\n  ${broken.map((b) => `${b.route} → ${b.status || "pas de réponse"}`).join("\n  ")}` +
          (missing ? `\nmodules manquants : ${missing}` : "") +
          "\n--- sortie du serveur ---\n" + out.join("").slice(-2500)
      );
    }
    const dbFile = path.join(sandbox, DATA_DIR_NAME, "scans.db");
    if (!fs.existsSync(dbFile)) {
      throw new Error(`la base SQLite n'a pas été créée dans le profil jetable (${dbFile}).`);
    }
    return { routes: results.map((r) => `${r.route}=${r.status}`) };
  } finally {
    try { child.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 800));
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const smokePortIdx = args.indexOf("--smoke-port");
  const preferredSmokePort = smokePortIdx >= 0 ? Number(args[smokePortIdx + 1]) : PORT;
  const version = readVersion();
  log(`${APP_NAME} ${version}`);

  if (!args.includes("--no-next-build")) {
    log("next build (output: standalone)…");
    const nextBin = path.join(PROJECT, "node_modules", "next", "dist", "bin", "next");
    if (!fs.existsSync(nextBin)) throw new Error("CLI Next introuvable — npm install ?");
    execFileSync(process.execPath, [nextBin, "build"], { cwd: PROJECT, stdio: "inherit" });
  } else {
    log("build Next réutilisé (--no-next-build)");
  }

  const { size, nodeVersion } = assemble(version);

  log("contrôle anti-fuite (identité, chemin du poste, secrets de .env.local)…");
  const { findings, scanned, needleCount, secretCount } = checkLeaks(PAYLOAD);
  log(`  ${scanned} fichiers scannés, ${needleCount} termes (dont ${secretCount} secret(s) de .env.local)`);
  if (findings.length) {
    console.error(`[build] BLOQUÉ — ${findings.length} fuite(s) dans la charge utile :`);
    for (const f of findings.slice(0, 40)) console.error(`  - ${f.file} :: ${f.kind}`);
    process.exit(1);
  }
  log("  0 occurrence — charge utile propre");

  log("démarrage à blanc (runtime\\node.exe app\\start.js, PATH minimal, profil jetable)…");
  const smokePort = await pickSmokePort(preferredSmokePort);
  const smoke = await smokeTest(smokePort);
  log(`  OK — ${smoke.routes.join(", ")}`);

  if (args.includes("--assemble-only")) {
    log(`arrêt avant Inno Setup (--assemble-only). Charge utile : ${PAYLOAD}`);
    return;
  }

  fs.mkdirSync(OUTPUT, { recursive: true });
  const iscc = findIscc();
  log(`compilation de l'installeur (${path.basename(iscc)})…`);
  execFileSync(
    iscc,
    [
      `/DMyAppVersion=${version}`,
      `/DPayloadDir=${PAYLOAD}`,
      `/DOutDir=${OUTPUT}`,
      path.join(HERE, "GeniusScout.iss"),
    ],
    { cwd: HERE, stdio: "inherit" }
  );
  const setup = path.join(OUTPUT, `GeniusScout_Setup_${version}.exe`);
  if (!fs.existsSync(setup)) throw new Error("Installeur non produit par ISCC.");
  log(`OK — ${setup} (${mb(fs.statSync(setup).size)}, charge utile ${mb(size)}, Node v${nodeVersion})`);
  log("Rappel : Inno compresse en LZMA — le contrôle anti-fuite probant est celui de la charge utile ci-dessus.");
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(`[build] ÉCHEC : ${e.message}`);
    process.exit(1);
  });
}
