"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface ScanSummary {
  id: string;
  artist: string;
  album: string;
  album_art_url: string;
  status: string;
  created_at: string;
  track_count: number;
  producer_count: number;
  ig_stats: {
    total: number;
    confirmed: number;
    probable: number;
    not_found: number;
    rate: string;
  };
}

export default function HistoryPage() {
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then((data) => setScans(data.scans || []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12 text-center text-foreground/40">
        Chargement...
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Scans precedents</h1>

      {scans.length === 0 ? (
        <div className="text-center py-12 text-foreground/40">
          Aucun scan encore. <Link href="/" className="text-accent hover:underline">Lancer un scan</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {scans.map((scan) => (
            <Link
              key={scan.id}
              href={`/scan/${scan.id}`}
              className="flex items-center gap-4 p-4 bg-surface border border-border rounded-lg hover:border-accent/50 transition group"
            >
              {scan.album_art_url && (
                <img
                  src={scan.album_art_url}
                  alt={scan.album}
                  className="w-14 h-14 rounded object-cover"
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{scan.album}</div>
                <div className="text-sm text-foreground/50">{scan.artist}</div>
                <div className="text-xs text-foreground/30">
                  {new Date(scan.created_at).toLocaleDateString("fr-FR")} &middot;{" "}
                  {scan.track_count} titres &middot; {scan.producer_count} producteurs
                </div>
              </div>
              <div className="text-right shrink-0">
                <div
                  className={`text-lg font-bold ${
                    Number(scan.ig_stats.rate) >= 80
                      ? "text-success"
                      : Number(scan.ig_stats.rate) >= 50
                      ? "text-warning"
                      : "text-error"
                  }`}
                >
                  {scan.ig_stats.rate}%
                </div>
                <div className="text-xs text-foreground/40">
                  {scan.ig_stats.confirmed} OK / {scan.ig_stats.probable} probable
                </div>
              </div>
              <div
                className={`px-2 py-1 rounded text-xs ${
                  scan.status === "complete"
                    ? "bg-success/20 text-success"
                    : scan.status === "failed"
                    ? "bg-error/20 text-error"
                    : "bg-accent/20 text-accent"
                }`}
              >
                {scan.status}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
