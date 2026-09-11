"use client";

import { useEffect, useState, useRef, use, useCallback } from "react";
import Link from "next/link";

interface ScanEvent {
  id: number;
  type: string;
  agent: string;
  message: string;
  timestamp: string;
}

interface ProducerRow {
  id: number;
  name: string;
  sources: string[];
  track_titles: string[];
  instagram: string | null;
  ig_status: string;
  ig_confidence: number;
  ig_profile_data: { bio?: string; followers?: string; nom_affiche?: string } | null;
  aliases: string[];
}

interface ScanMeta {
  id: string;
  artist: string;
  album: string;
  album_art_url: string;
  status: string;
  track_count: number;
  producer_count: number;
}

interface ScanData {
  scan: ScanMeta;
  producers: ProducerRow[];
  events: ScanEvent[];
}

type UiState = "loading" | "pending" | "running" | "complete" | "failed";

export default function ScanPage({ params }: { params: Promise<{ scanId: string }> }) {
  const { scanId } = use(params);
  const [meta, setMeta] = useState<ScanMeta | null>(null);
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [producers, setProducers] = useState<ProducerRow[]>([]);
  const [ui, setUi] = useState<UiState>("loading");
  const [queueNotice, setQueueNotice] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const seenEventIds = useRef<Set<number>>(new Set());

  const loadResults = useCallback(async () => {
    const resp = await fetch(`/api/scan/${scanId}`);
    const data: ScanData = await resp.json();
    setMeta(data.scan);
    // Confirmed first, then probable, then the rest — the list is read
    // top-down to build outreach, so certainty must lead.
    const rank = (p: ProducerRow) =>
      p.ig_status === "confirmed" ? 2 : p.ig_status === "probable" ? 1 : 0;
    const sorted = [...(data.producers || [])].sort(
      (a, b) =>
        rank(b) - rank(a) ||
        (b.ig_confidence || 0) - (a.ig_confidence || 0) ||
        a.name.localeCompare(b.name)
    );
    setProducers(sorted);
    return data;
  }, [scanId]);

  // Initial load — determine status
  useEffect(() => {
    (async () => {
      const data = await loadResults();
      const status = data.scan?.status;
      if (status === "complete") setUi("complete");
      else if (status === "failed") setUi("failed");
      else if (status === "credits" || status === "instagram") setUi("running");
      else setUi("pending");
    })();
  }, [loadResults]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events]);

  // SSE — replays all events, then live updates; closes on scan_done
  useEffect(() => {
    const es = new EventSource(`/api/scan/${scanId}/progress`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "heartbeat") return;
        if (data.type === "scan_done") {
          es.close();
          loadResults().then(() =>
            setUi(data.status === "failed" ? "failed" : "complete")
          );
          return;
        }
        if (typeof data.id === "number") {
          if (seenEventIds.current.has(data.id)) return;
          seenEventIds.current.add(data.id);
        }
        setEvents((prev) => [...prev, data as ScanEvent]);
        // While receiving events, we know the scan is running
        setUi((cur) => (cur === "pending" || cur === "loading" ? "running" : cur));
      } catch {
        // ignore parse errors
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [scanId, loadResults]);

  const startRun = async (
    kind: "full" | "credits" | "instagram",
    fresh = false
  ) => {
    setEvents([]);
    seenEventIds.current.clear();
    setUi("running");
    setQueueNotice("");
    const runResp = await fetch("/api/scan/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanId, kind, fresh }),
    })
      .then((r) => r.json())
      .catch(() => null);
    if (runResp?.queued) {
      // 2 scans max at a time (shared Instagram session): this one waits.
      setQueueNotice(
        `En file d'attente (position ${runResp.position}) — démarrage automatique dès qu'un créneau se libère. Tu peux fermer cette page.`
      );
    }
    // Re-open the SSE stream for the new run
    const es = new EventSource(`/api/scan/${scanId}/progress`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "heartbeat") return;
        if (data.type === "scan_done") {
          es.close();
          loadResults().then(() =>
            setUi(data.status === "failed" ? "failed" : "complete")
          );
          return;
        }
        if (typeof data.id === "number") {
          if (seenEventIds.current.has(data.id)) return;
          seenEventIds.current.add(data.id);
        }
        setEvents((prev) => [...prev, data as ScanEvent]);
      } catch {
        // ignore
      }
    };
    es.onerror = () => es.close();
  };

  const confirmed = producers.filter((p) => p.ig_status === "confirmed").length;
  const probable = producers.filter((p) => p.ig_status === "probable").length;
  const rate =
    producers.length > 0
      ? (((confirmed + probable) / producers.length) * 100).toFixed(0)
      : "0";

  const showResults = producers.length > 0 && (ui === "complete" || ui === "running");

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Top bar: always lets the user go back to launch more scans */}
      <div className="flex items-center justify-between mb-6">
        <Link
          href="/"
          className="text-sm text-accent hover:underline flex items-center gap-1"
        >
          ← Accueil (lancer d&apos;autres scans)
        </Link>
        <span
          className={`px-3 py-1 rounded-full text-xs font-medium ${
            ui === "complete"
              ? "bg-success/20 text-success"
              : ui === "failed"
                ? "bg-error/20 text-error"
                : ui === "running"
                  ? "bg-accent/20 text-accent animate-pulse"
                  : "bg-surface-light text-foreground/50"
          }`}
        >
          {ui === "complete"
            ? "Terminé"
            : ui === "failed"
              ? "Échec"
              : ui === "running"
                ? "Scan en cours…"
                : ui === "pending"
                  ? "Prêt"
                  : "Chargement…"}
        </span>
      </div>

      {queueNotice && (
        <div className="mb-6 px-4 py-3 rounded-lg border border-accent/40 bg-accent/10 text-accent text-sm">
          ⏳ {queueNotice}
        </div>
      )}

      {/* Album header */}
      {meta && (
        <div className="flex items-center gap-4 mb-6">
          {meta.album_art_url && (
            <img
              src={meta.album_art_url}
              alt={meta.album}
              className="w-20 h-20 rounded-lg object-cover"
            />
          )}
          <div>
            <h2 className="text-xl font-bold">{meta.album}</h2>
            <p className="text-foreground/50">{meta.artist}</p>
            <p className="text-xs text-foreground/30">
              {meta.track_count} titres
              {producers.length > 0 ? ` · ${producers.length} producteurs` : ""}
            </p>
          </div>
        </div>
      )}

      {/* Controls (only when nothing has run yet) */}
      {ui === "pending" && (
        <div className="flex flex-wrap gap-3 mb-6">
          <button
            onClick={() => startRun("full")}
            className="px-6 py-3 bg-accent text-black font-semibold rounded-lg hover:bg-accent/90 transition"
          >
            Lancer le scan complet
          </button>
          <button
            onClick={() => startRun("credits")}
            className="px-4 py-2 bg-surface border border-border rounded-lg text-sm hover:border-accent/50 transition"
          >
            Crédits seuls
          </button>
          <button
            onClick={() => startRun("instagram")}
            className="px-4 py-2 bg-surface border border-border rounded-lg text-sm hover:border-accent/50 transition"
          >
            Instagram seul
          </button>
        </div>
      )}

      {(ui === "failed" || ui === "complete") && (
        <div className="flex flex-wrap gap-3 mb-6">
          {/* An interrupted scan can be resumed: already-verified producers are
              kept, so this costs minutes instead of an hour. */}
          {ui === "failed" && (
            <button
              onClick={() => startRun("instagram", false)}
              className="px-5 py-2.5 bg-accent text-black font-semibold rounded-lg hover:bg-accent/90 transition"
              title="Reprend là où le scan s'est arrêté, sans refaire les producteurs déjà traités"
            >
              ▶ Reprendre le scan
            </button>
          )}
          <button
            onClick={() => startRun("full", true)}
            className={`px-5 py-2.5 rounded-lg font-semibold transition ${
              ui === "failed"
                ? "bg-surface border border-border text-sm hover:border-accent/50"
                : "bg-accent text-black hover:bg-accent/90"
            }`}
            title="Réinterroge toutes les sources en ignorant le cache (plus long)"
          >
            🔄 Rescanner (données fraîches)
          </button>
          <button
            onClick={() => startRun("instagram", true)}
            className="px-4 py-2 bg-surface border border-border rounded-lg text-sm hover:border-accent/50 transition"
          >
            Relancer Instagram seul
          </button>
        </div>
      )}

      {ui === "running" && (
        <div className="mb-6 px-4 py-3 rounded-lg border border-accent/30 bg-accent/5 text-sm text-foreground/70">
          Le scan tourne sur le serveur. Tu peux revenir à l&apos;accueil pour en
          lancer d&apos;autres en parallèle — il continuera et tu retrouveras les
          résultats ici (ou via « Scans précédents »).
        </div>
      )}

      {/* Live log */}
      {events.length > 0 && (
        <div className="mb-8">
          <h3 className="text-sm font-medium text-foreground/50 mb-2">
            Progression en direct
          </h3>
          <div
            ref={logRef}
            className="bg-surface border border-border rounded-lg p-4 h-64 overflow-y-auto font-mono text-xs space-y-1"
          >
            {events.map((e, i) => (
              <div key={e.id ?? i} className="flex gap-2">
                <span className="text-foreground/30 shrink-0">
                  {new Date(e.timestamp).toLocaleTimeString("fr-FR")}
                </span>
                <span
                  className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    e.type === "error"
                      ? "bg-error/20 text-error"
                      : e.type?.includes("complete")
                        ? "bg-success/20 text-success"
                        : e.type?.includes("found")
                          ? "bg-accent/20 text-accent"
                          : "bg-surface-light text-foreground/50"
                  }`}
                >
                  {e.agent}
                </span>
                <span className="text-foreground/80">{e.message}</span>
              </div>
            ))}
            {ui === "running" && (
              <div className="text-accent animate-pulse">En cours…</div>
            )}
          </div>
        </div>
      )}

      {/* Results table */}
      {showResults && (
        <div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-foreground/50">
                  <th className="py-2 pr-4">Producteur</th>
                  <th className="py-2 pr-4">Titres</th>
                  <th className="py-2 pr-4">Sources</th>
                  <th className="py-2 pr-4">Instagram</th>
                  <th className="py-2 pr-4">Statut</th>
                  <th className="py-2">Confiance</th>
                </tr>
              </thead>
              <tbody>
                {producers.map((p) => (
                  <tr key={p.id} className="border-b border-border/50 hover:bg-surface-light/50">
                    <td className="py-3 pr-4 font-medium">{p.name}</td>
                    <td className="py-3 pr-4 text-foreground/60 text-xs">
                      {p.track_titles?.join(", ")}
                    </td>
                    <td className="py-3 pr-4">
                      {p.sources?.map((s: string) => (
                        <span
                          key={s}
                          className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-surface-light mr-1"
                        >
                          {s}
                        </span>
                      ))}
                    </td>
                    <td className="py-3 pr-4">
                      {p.instagram ? (
                        <a
                          href={`https://instagram.com/${p.instagram}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline"
                        >
                          @{p.instagram}
                        </a>
                      ) : (
                        <span className="text-foreground/30">-</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          p.ig_status === "confirmed"
                            ? "bg-success/20 text-success"
                            : p.ig_status === "probable"
                              ? "bg-warning/20 text-warning"
                              : "bg-error/20 text-error"
                        }`}
                      >
                        {p.ig_status === "confirmed"
                          ? "Confirmé"
                          : p.ig_status === "probable"
                            ? "Probable"
                            : "Non trouvé"}
                      </span>
                    </td>
                    <td className="py-3 text-foreground/60">
                      {p.ig_confidence > 0
                        ? `${(p.ig_confidence * 100).toFixed(0)}%`
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 flex gap-4">
            <div className="px-4 py-2 bg-success/10 rounded-lg text-sm">
              <span className="text-success font-bold">{confirmed}</span>{" "}
              <span className="text-foreground/50">confirmés</span>
            </div>
            <div className="px-4 py-2 bg-warning/10 rounded-lg text-sm">
              <span className="text-warning font-bold">{probable}</span>{" "}
              <span className="text-foreground/50">probables</span>
            </div>
            <div className="px-4 py-2 bg-surface-light rounded-lg text-sm">
              <span className="font-bold">{rate}%</span>{" "}
              <span className="text-foreground/50">taux de détection</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
