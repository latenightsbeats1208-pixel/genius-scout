"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface Album {
  id: number | string;
  title: string;
  artist: string;
  cover_art_url: string;
  url: string;
  release_date?: string;
  source: "genius" | "spotify";
}

interface SpotifyAlbumApiResp {
  album?: {
    id: string;
    name: string;
    artists: string[];
    url: string;
    release_date?: string;
    cover_art_url?: string;
  };
  error?: string;
}

const SPOTIFY_URL_RE =
  /open\.spotify\.com\/(?:intl-[a-z]+\/)?album\/[a-zA-Z0-9]{22}|spotify:album:[a-zA-Z0-9]{22}|^[a-zA-Z0-9]{22}$/i;

interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
  critical: boolean;
}
interface HealthReport {
  ok: boolean;
  degraded: boolean;
  checks: HealthCheck[];
}

interface QueueRunning {
  scanId: string;
  kind: string;
  artist: string;
  album: string;
}
interface QueueItem {
  scan_id: string;
  artist: string;
  album: string;
  position: number;
}
interface QueueInfo {
  max: number;
  running: QueueRunning[];
  queued: QueueItem[];
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState<string | number | null>(null);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [queueInfo, setQueueInfo] = useState<QueueInfo | null>(null);
  const [notice, setNotice] = useState("");
  const router = useRouter();

  // Surface broken dependencies immediately — a missing Chromium silently
  // gutted Spotify + Google agents and produced near-empty scans.
  // Re-checked on focus and every minute: a one-shot fetch kept showing the
  // morning's report all day, still claiming "Instagram pas connecté" long
  // after the dedicated Chrome was back up.
  useEffect(() => {
    const load = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then(setHealth)
        .catch(() => {});
    load();
    window.addEventListener("focus", load);
    const id = setInterval(load, 60_000);
    return () => {
      window.removeEventListener("focus", load);
      clearInterval(id);
    };
  }, []);

  // Live queue strip: which scans run now, which wait their turn.
  useEffect(() => {
    const load = () =>
      fetch("/api/scan/queue")
        .then((r) => r.json())
        .then(setQueueInfo)
        .catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const refreshQueue = () =>
    fetch("/api/scan/queue")
      .then((r) => r.json())
      .then(setQueueInfo)
      .catch(() => {});

  const removeFromQueue = async (scanId: string) => {
    await fetch("/api/scan/queue", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanId }),
    }).catch(() => {});
    refreshQueue();
  };

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setAlbums([]);
    setError("");

    const isSpotifyUrl = SPOTIFY_URL_RE.test(query.trim());

    try {
      if (isSpotifyUrl) {
        // Resolve Spotify album directly
        const resp = await fetch(
          `/api/spotify/album?id=${encodeURIComponent(query.trim())}`
        );
        const data: SpotifyAlbumApiResp = await resp.json();
        if (data.album) {
          setAlbums([
            {
              id: data.album.id,
              title: data.album.name,
              artist: data.album.artists.join(", "),
              cover_art_url: data.album.cover_art_url || "",
              url: data.album.url,
              release_date: data.album.release_date,
              source: "spotify",
            },
          ]);
        } else {
          setError(data.error || "Album Spotify non trouve");
        }
      } else {
        // Genius search
        const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await resp.json();
        const results: Album[] = (data.albums || []).map(
          (a: {
            id: number;
            title: string;
            artist: string;
            cover_art_url: string;
            url: string;
            release_date?: string;
          }) => ({ ...a, source: "genius" as const })
        );
        setAlbums(results);
        if (results.length === 0) {
          setError(
            "Aucun album trouve sur Genius. Astuce : colle l'URL Spotify de l'album."
          );
        }
      }
    } catch (e) {
      setError((e as Error).message || "Erreur de recherche");
    }
    setLoading(false);
  };

  const startScan = async (album: Album) => {
    setStarting(album.id);
    try {
      const body =
        album.source === "spotify"
          ? {
              spotifyAlbumId: album.id,
              albumTitle: album.title,
              artistName: album.artist,
              albumArtUrl: album.cover_art_url,
            }
          : {
              geniusAlbumId: album.id,
              albumTitle: album.title,
              artistName: album.artist,
              albumArtUrl: album.cover_art_url,
            };

      const resp = await fetch("/api/scan/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.scanId) {
        // Server-side launch: runs now if one of the slots is free, otherwise
        // joins the queue (2 max — every scan shares one Instagram session).
        const runResp = await fetch("/api/scan/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scanId: data.scanId, kind: "full" }),
        })
          .then((r) => r.json())
          .catch(() => null);
        if (runResp?.queued) {
          // Stay here: the scan page would just sit idle until its turn.
          setNotice(
            `« ${album.title} » est en file d'attente (position ${runResp.position}) — il démarrera automatiquement.`
          );
          setStarting(null);
          refreshQueue();
        } else {
          router.push(`/scan/${data.scanId}`);
        }
      } else {
        setError(data.error || "Echec du demarrage du scan");
        setStarting(null);
      }
    } catch (e) {
      setError((e as Error).message);
      setStarting(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <div className="text-center mb-10">
        <h1 className="text-4xl font-bold mb-2">
          <span className="text-accent">Genius</span> Scout
        </h1>
        <p className="text-foreground/50 text-sm">
          Trouve les producteurs et leurs Instagram en quelques clics
        </p>
      </div>

      {health && !health.ok && (
        <div
          className={`mb-6 px-4 py-3 rounded-lg border text-sm ${
            health.degraded
              ? "border-error/50 bg-error/10"
              : "border-warning/40 bg-warning/10"
          }`}
        >
          <div
            className={`font-semibold mb-1 ${
              health.degraded ? "text-error" : "text-warning"
            }`}
          >
            {health.degraded
              ? "⛔ Une source critique est HORS SERVICE — les scans seront incomplets"
              : "⚠️ Fonctionnement dégradé"}
          </div>
          <ul className="space-y-0.5 text-foreground/70">
            {health.checks
              .filter((c) => !c.ok)
              .map((c) => (
                <li key={c.name}>
                  <span className="font-medium">{c.name}</span> — {c.detail}
                </li>
              ))}
          </ul>
        </div>
      )}

      {queueInfo &&
        (queueInfo.running.length > 0 || queueInfo.queued.length > 0) && (
          <div className="mb-6 px-4 py-3 rounded-lg border border-border bg-surface text-sm space-y-1.5">
            <div className="font-semibold text-foreground/80">
              Scans en cours ({queueInfo.running.length}/{queueInfo.max})
            </div>
            {queueInfo.running.map((r) => (
              <a
                key={r.scanId}
                href={`/scan/${r.scanId}`}
                className="flex items-center gap-2 text-accent hover:underline"
              >
                <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
                <span className="truncate">
                  {r.artist} — {r.album}
                </span>
              </a>
            ))}
            {queueInfo.queued.length > 0 && (
              <>
                <div className="font-semibold text-foreground/60 pt-1">
                  File d&apos;attente ({queueInfo.queued.length})
                </div>
                {queueInfo.queued.map((q) => (
                  <div
                    key={q.scan_id}
                    className="flex items-center gap-2 text-foreground/70"
                  >
                    <span className="text-foreground/40 w-6">#{q.position}</span>
                    <span className="flex-1 truncate">
                      {q.artist} — {q.album}
                    </span>
                    <button
                      onClick={() => removeFromQueue(q.scan_id)}
                      className="text-foreground/40 hover:text-error transition"
                      title="Retirer de la file"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

      {notice && (
        <div className="mb-6 px-4 py-3 rounded-lg border border-accent/40 bg-accent/10 text-accent text-sm">
          {notice}
        </div>
      )}

      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Artiste + album OU URL Spotify (ex: https://open.spotify.com/album/...)"
          className="flex-1 px-4 py-3 bg-surface border border-border rounded-lg text-foreground placeholder:text-foreground/30 focus:outline-none focus:border-accent transition"
        />
        <button
          onClick={search}
          disabled={loading}
          className="px-6 py-3 bg-accent text-black font-semibold rounded-lg hover:bg-accent/90 disabled:opacity-50 transition"
        >
          {loading ? "..." : "Rechercher"}
        </button>
      </div>

      <p className="text-xs text-foreground/40 mb-6">
        Tu peux coller directement une URL Spotify d&apos;album pour scanner sans
        passer par Genius.
      </p>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-lg border border-warning/40 bg-warning/10 text-warning text-sm">
          {error}
        </div>
      )}

      {albums.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-foreground/50">
            {albums.length} album(s) trouve(s)
          </p>
          {albums.map((album) => (
            <div
              key={`${album.source}-${album.id}`}
              className="flex items-center gap-4 p-4 bg-surface border border-border rounded-lg hover:border-accent/50 transition group"
            >
              {album.cover_art_url && (
                <img
                  src={album.cover_art_url}
                  alt={album.title}
                  className="w-16 h-16 rounded object-cover"
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate flex items-center gap-2">
                  {album.title}
                  <span
                    className={`text-[10px] uppercase font-medium px-1.5 py-0.5 rounded ${
                      album.source === "spotify"
                        ? "bg-green-900/40 text-green-400"
                        : "bg-accent/20 text-accent"
                    }`}
                  >
                    {album.source}
                  </span>
                </div>
                <div className="text-sm text-foreground/50">{album.artist}</div>
                {album.release_date && (
                  <div className="text-xs text-foreground/30">
                    {album.release_date}
                  </div>
                )}
              </div>
              <button
                onClick={() => startScan(album)}
                disabled={starting === album.id}
                className="px-4 py-2 bg-accent/10 text-accent border border-accent/30 rounded-lg hover:bg-accent/20 disabled:opacity-50 transition whitespace-nowrap"
              >
                {starting === album.id ? "Chargement..." : "Scanner"}
              </button>
            </div>
          ))}
        </div>
      )}

      {loading && (
        <div className="text-center text-foreground/40 py-8">
          Recherche en cours...
        </div>
      )}
    </div>
  );
}
