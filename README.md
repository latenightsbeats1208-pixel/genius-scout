# Genius Scout

**Les producteurs d'un album, titre par titre, et leur Instagram — vérifié.**
Collez un lien d'album Spotify (ou cherchez-le sur Genius) : Genius Scout croise Genius, Spotify,
MusicBrainz et Discogs pour lister les producteurs de chaque titre, puis retrouve leur compte
Instagram avec une preuve de correspondance. Pensé pour les beatmakers qui veulent placer leurs prods
auprès des bonnes personnes.

*Genius Scout lists the producers of an album track by track (Genius + Spotify + MusicBrainz + Discogs),
then finds and verifies their Instagram accounts. Local Next.js app, SQLite storage, French UI.*

Site et version Pro (installeur Windows) : https://latenightsbeats1208-pixel.github.io/genius-scout/

## Fonctionnement

1. **Album** — lien Spotify (`open.spotify.com/album/…`) ou recherche Genius. La tracklist est
   reconstituée et chaque titre rapproché entre les sources.
2. **Crédits** — 4 agents en parallèle (`src/agents/*-credits.ts`) : Genius, Spotify (crédits du
   lecteur web, via un Chrome dédié connecté), MusicBrainz, Discogs. `credit-merger.ts` fusionne les
   alias ; un producteur cité par deux sources est marqué `double_source`.
3. **Instagram** — candidats trouvés via Genius (`ig-agent-genius.ts`) et Google
   (`ig-agent-google.ts`), puis **arbitrage** (`ig-agent-arbiter.ts`) : le handle ou le nom affiché
   doit correspondre au producteur (porte obligatoire), corroboré par des indices musicaux ou une
   mention de l'artiste. Trois modes (`IG_VALIDATION_MODE`) : `heuristic` (gratuit), `budget`
   (Claude Haiku seulement si moins de 60 % des producteurs sont trouvés), `llm` (Claude sur chaque
   cas ambigu). **Le modèle ne peut que rétrograder un candidat, jamais le promouvoir.**
4. **Contacts** — page `/contacts` : emails et contacts management extraits des bios Instagram,
   statut contacté, relance suggérée à 14 jours, export CSV.

Diagnostic avant chaque scan (`src/lib/preflight.ts`) : Chrome dédié, Spotify, Instagram, Claude.
File d'attente (`/api/scan/queue`), progression en direct, historique (`/history`).

## Installation (version gratuite)

Prérequis : **Node.js ≥ 20.9**, **Google Chrome**, un compte Spotify et un compte Discogs.

```bash
git clone https://github.com/latenightsbeats1208-pixel/genius-scout.git
cd genius-scout
npm install
cp .env.local.example .env.local   # puis renseigner les clés (voir ci-dessous)
```

| Variable | Obligatoire | Où l'obtenir |
|---|---|---|
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | recommandé | https://developer.spotify.com/dashboard → Create app (gratuit) |
| `DISCOGS_TOKEN` | recommandé | https://www.discogs.com/settings/developers → Generate token (gratuit) |
| `ANTHROPIC_API_KEY` | optionnel | https://console.anthropic.com/ (validation IA des cas ambigus, quelques centimes par scan) |
| `IG_VALIDATION_MODE` | non | `budget` (défaut), `heuristic`, `llm` |

### Lancer

- **Windows** : `Genius-Scout.bat` — ouvre le Chrome dédié (port de débogage 9333, profil sous
  `%USERPROFILE%\GeniusScoutData\ChromeProfile`), démarre le serveur sur le port 3033 et ouvre l'app.
  Au premier lancement, connectez-vous à Spotify et Instagram dans ce Chrome : la session est conservée.
- **Mac / Linux** : `npm run dev` puis http://localhost:3033. Lancez Chrome avec
  `--remote-debugging-port=9333 --user-data-dir=<dossier dédié>` pour les crédits Spotify et la lecture Instagram.
- **Depuis le téléphone** (même Wi-Fi) : `GeniusScout-Mobile.bat` ouvre le port dans le pare-feu et
  affiche l'adresse à saisir.

## Données

Base SQLite et profil Chrome dans `%USERPROFILE%\GeniusScoutData` (hors OneDrive, hors des dossiers
nettoyés automatiquement — l'emplacement `AppData\Local` a été purgé deux fois par un nettoyeur).
Rien ne quitte votre machine, hormis les requêtes vers Genius, Spotify, MusicBrainz, Discogs,
Instagram (via votre Chrome) et, si activé, l'API Anthropic.

## Instagram : limites à connaître

Instagram limite fortement les lectures automatisées. L'app espace les requêtes, met en cache chaque
profil 6 heures, et se met en pause 30 minutes dès un HTTP 429. Restez sous quelques dizaines de
profils par jour : ces lectures passent par **votre** compte.

## Paquet Windows

`npm run package` produit `installer/output/GeniusScout_Setup_<version>.exe` (Node embarqué, aucune
dépendance sur la machine cible). Voir [`installer/README.md`](installer/README.md).

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · better-sqlite3 · Playwright (Chrome via CDP) · @anthropic-ai/sdk

## Licence

MIT — voir [`LICENSE`](LICENSE). Le nom « Genius » désigne le site genius.com, sans affiliation.
