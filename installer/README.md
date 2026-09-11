# Paquet Windows de Genius Scout

Chaîne de fabrication de `GeniusScout_Setup_<version>.exe` : un installeur
autonome (Node embarqué) qui s'installe **par utilisateur**, sans droit
administrateur, dans `%LOCALAPPDATA%\Programs\GeniusScout`.

## Fabriquer une release

```powershell
# 1. incrémenter "version" dans package.json (X.Y.Z)
# 2. build complet : next build + assemblage + anti-fuite + démarrage à blanc + Inno Setup
npm run package
```

Sorties :

| Chemin | Contenu |
| --- | --- |
| `installer/dist/GeniusScout/` | charge utile (ce qui sera installé) |
| `installer/output/GeniusScout_Setup_<version>.exe` | installeur |

Variantes :

| Commande | Effet |
| --- | --- |
| `node installer/build.mjs --no-next-build` | réutilise le `.next` existant |
| `node installer/build.mjs --assemble-only` | s'arrête avant Inno Setup |
| `node installer/build.mjs --smoke-port 3933` | autre port pour le démarrage à blanc (3033 par défaut) |

Prérequis du poste de build : Node (le `node.exe` courant est embarqué tel
quel dans le paquet, sa version est notée dans `runtime/VERSION.txt`),
`npm install` fait, Inno Setup 6 (`%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe`
ou `Program Files`).

## Étapes du build (`installer/build.mjs`)

1. **`next build`** (`output: "standalone"` dans `next.config.ts`).
2. **Assemblage** dans `installer/dist/GeniusScout/` — copie *sélective* de
   `.next/standalone` (`server.js`, `package.json`, `.next/`, `node_modules/`),
   plus `.next/static` et `public/`. Sont **exclus** : `.env*`, `data/`,
   `*.db*`, journaux, `*.nft.json`, et les dossiers `dist/`, `legacy/`, `src/`
   du projet (le traceur de Next recopie tout le projet dans le standalone).
3. **Complément du runtime Next** (`next/dist/{lib,shared,server,client}`) et
   vérification du binaire natif `better-sqlite3` (recopié depuis
   `node_modules` avec `bindings` et `file-uri-to-path` s'il manquait).
4. **Réécriture des chemins absolus** du poste de build inscrits dans
   `.next/server` (trois encodages) vers `C:\GeniusScout\build`.
5. Écriture de `app/start.js`, `GeniusScout.bat`, `server.bat`,
   `LISEZ-MOI.txt`, copie de `env.example`, `GeniusScout.ico` et
   `runtime/node.exe`.
6. **Contrôle anti-fuite** (verrou) : la charge utile est grep-ée, insensible
   à la casse, pour l'identité de l'opérateur, le chemin du poste
   (`C:\Users\...` sous ses trois formes) et les **valeurs réelles** des secrets
   de `.env.local` (lues à la volée, jamais affichées ni écrites). Fichiers
   texte et binaires (ASCII + UTF-16LE). Une seule occurrence = pas
   d'installeur.
7. **Démarrage à blanc** : `runtime\node.exe app\start.js` avec un PATH minimal
   (`System32` seul) et un `USERPROFILE` jetable ; attend `HTTP 200` sur `/`,
   `/history`, `/contacts`, `/api/history`, `/api/scan/running`, `/api/health`
   et vérifie que `scans.db` a bien été créée. Le port CDP est neutralisé
   (`GENIUS_CDP_PORT=1`) : le Chrome dédié de l'opérateur n'est jamais touché.
8. **Inno Setup** (`GeniusScout.iss`, lzma2/solid) → `installer/output/`.

## Contenu du paquet

```
GeniusScout/
  GeniusScout.bat       lanceur : Chrome dédié (port 9333) + serveur + navigateur
  server.bat            fenêtre « Genius Scout - Serveur » (appelée par le lanceur)
  GeniusScout.ico       icône des raccourcis (public/GeniusScout.ico)
  LISEZ-MOI.txt         notice utilisateur (FR)
  env.example           modèle du fichier de clés API
  runtime/node.exe      Node embarqué (copie du poste de build) + VERSION.txt
  app/
    start.js            charge %USERPROFILE%\GeniusScoutData\.env puis server.js
    server.js           serveur Next standalone
    .next/, node_modules/, public/, package.json
```

## À l'exécution

| Quoi | Où |
| --- | --- |
| Installation | `%LOCALAPPDATA%\Programs\GeniusScout` |
| Base SQLite, clés API, profil Chrome dédié | `%USERPROFILE%\GeniusScoutData` (`scans.db`, `.env`, `ChromeProfile\`) |
| Serveur | `http://127.0.0.1:3033` (HOSTNAME=127.0.0.1, PORT=3033) |
| Chrome dédié | port de débogage 9333, profil `GeniusScoutData\ChromeProfile` |

Le `server.js` standalone de Next **ne lit aucun fichier `.env`** :
`app/start.js` lit `%USERPROFILE%\GeniusScoutData\.env` (ou `GENIUS_ENV_FILE`),
pose les variables absentes de l'environnement (`ANTHROPIC_API_KEY`,
`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `DISCOGS_TOKEN`,
`IG_VALIDATION_MODE`), puis charge `server.js`. Au premier lancement,
`GeniusScout.bat` crée ce fichier depuis `env.example` et l'ouvre dans le
Bloc-notes.

La désinstallation conserve `GeniusScoutData` et l'indique à l'utilisateur.

## Non embarqué, volontairement

- **Chromium de Playwright** : l'application pilote le Chrome de l'utilisateur
  via CDP (port 9333). Le repli `chromium.launch()` headless (utilisé si le
  Chrome dédié est absent) nécessiterait `npx playwright install chromium`,
  non fourni.
- **`curl`** : fourni par Windows 10/11 (`System32\curl.exe`).
- `dist/` (ancienne tentative d'avril 2026) et `legacy/` du projet : références
  seulement, jamais copiés.
