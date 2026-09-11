"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface Contact {
  key: string;
  name: string;
  instagram: string;
  ig_status: string;
  ig_confidence: number;
  bio: string;
  followers: number | null;
  albums: { artist: string; album: string; scanId: string }[];
  email: string;
  emailSource: string;
  emailedAt: string | null;
  followUpAt: string | null;
  notes: string;
}

type Filter = "all" | "confirmed" | "probable" | "withEmail" | "toContact" | "toFollowUp";

/** Days after which an un-answered outreach is worth a follow-up. */
const FOLLOW_UP_DAYS = 14;

/** How the contact route was found — matters because the outreach differs. */
const SOURCE_LABEL: Record<string, string> = {
  email: "email dans la bio",
  bio: "email dans la bio",
  mgmt_ig: "contact management (Instagram)",
  phone: "téléphone dans la bio",
  site: "site / linktree",
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / 86_400_000);
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

function csvCell(v: string): string {
  const s = (v ?? "").replace(/"/g, '""');
  return /[",;\n]/.test(s) ? `"${s}"` : s;
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("confirmed");
  const [saving, setSaving] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichMsg, setEnrichMsg] = useState("");

  const load = useCallback(() => {
    fetch("/api/contacts")
      .then((r) => r.json())
      .then((d) => setContacts(d.contacts || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  /** Optimistic local update + persist. */
  const patch = async (key: string, changes: Partial<Contact>) => {
    setContacts((prev) =>
      prev.map((c) => (c.key === key ? { ...c, ...changes } : c))
    );
    setSaving(key);
    try {
      const c = contacts.find((x) => x.key === key);
      await fetch("/api/contacts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, name: c?.name, ...changes }),
      });
    } catch {
      // keep the optimistic value; a reload will reveal the truth
    } finally {
      setSaving(null);
    }
  };

  const toggleEmailed = (c: Contact) => {
    if (c.emailedAt) {
      patch(c.key, { emailedAt: null, followUpAt: null });
    } else {
      patch(c.key, { emailedAt: new Date().toISOString() });
    }
  };

  const markFollowUp = (c: Contact) =>
    patch(c.key, { followUpAt: new Date().toISOString() });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => {
      if (filter === "confirmed" && c.ig_status !== "confirmed") return false;
      if (filter === "probable" && c.ig_status !== "probable") return false;
      if (filter === "withEmail" && !c.email) return false;
      if (filter === "toContact" && (c.emailedAt || !c.email)) return false;
      if (filter === "toFollowUp") {
        const d = daysSince(c.emailedAt);
        if (d === null || c.followUpAt || d < FOLLOW_UP_DAYS) return false;
      }
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.instagram.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.albums.some(
          (a) =>
            a.album.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q)
        )
      );
    });
  }, [contacts, query, filter]);

  const counts = useMemo(() => {
    const toFollowUp = contacts.filter((c) => {
      const d = daysSince(c.emailedAt);
      return d !== null && !c.followUpAt && d >= FOLLOW_UP_DAYS;
    }).length;
    return {
      all: contacts.length,
      confirmed: contacts.filter((c) => c.ig_status === "confirmed").length,
      probable: contacts.filter((c) => c.ig_status === "probable").length,
      withEmail: contacts.filter((c) => c.email).length,
      toContact: contacts.filter((c) => c.email && !c.emailedAt).length,
      toFollowUp,
    };
  }, [contacts]);

  /**
   * Re-read Instagram bios for contacts with no known email. Runs in bounded
   * batches (each profile is a real page load) and loops until nothing is left,
   * reporting progress as it goes.
   */
  const enrichEmails = async () => {
    setEnriching(true);
    setEnrichMsg("Ouverture de la fenêtre Chrome dédiée…");
    let totalFound = 0;
    let totalProcessed = 0;
    try {
      for (;;) {
        const r = await fetch("/api/contacts/enrich", { method: "POST" });
        const d = (await r.json()) as {
          processed: number;
          found: number;
          remaining: number;
          error?: string;
          chrome?: string;
        };

        totalFound += d.found ?? 0;
        totalProcessed += d.processed ?? 0;

        // Surface the server's actual reason instead of a generic failure —
        // "Chrome introuvable" and "connecte-toi à Instagram" need different fixes.
        if (d.error) {
          setEnrichMsg(
            `⚠️ ${d.error}${totalFound ? ` (${totalFound} email(s) trouvé(s) avant l'arrêt)` : ""}`
          );
          load();
          break;
        }

        setEnrichMsg(
          `${totalFound} email(s) trouvé(s) · ${totalProcessed} profil(s) lus · ${d.remaining} restant(s)…`
        );
        load();
        if (d.processed === 0 || d.remaining === 0) {
          setEnrichMsg(
            `Terminé — ${totalFound} email(s) ajouté(s) sur ${totalProcessed} profil(s) lus.`
          );
          break;
        }
      }
    } catch (e) {
      setEnrichMsg(`⚠️ Erreur réseau : ${(e as Error).message}`);
    } finally {
      setEnriching(false);
    }
  };

  const exportCsv = () => {
    const header = [
      "Producteur",
      "Instagram",
      "Albums",
      "Email",
      "Source email",
      "Envoye le",
      "Relance le",
      "Statut IG",
      "Confiance",
      "Notes",
    ];
    const lines = visible.map((c) =>
      [
        c.name,
        c.instagram ? `@${c.instagram}` : "",
        c.albums.map((a) => `${a.artist} - ${a.album}`).join(" | "),
        c.email,
        c.emailSource,
        formatDate(c.emailedAt),
        formatDate(c.followUpAt),
        c.ig_status,
        `${Math.round(c.ig_confidence * 100)}%`,
        c.notes,
      ]
        .map(csvCell)
        .join(";")
    );
    // BOM + ";" so Excel FR opens it with correct columns and accents.
    const blob = new Blob(["﻿" + [header.join(";"), ...lines].join("\r\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `contacts-producteurs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const FILTERS: [Filter, string][] = [
    ["confirmed", `Confirmés (${counts.confirmed})`],
    ["withEmail", `Avec email (${counts.withEmail})`],
    ["toContact", `À contacter (${counts.toContact})`],
    ["toFollowUp", `À relancer (${counts.toFollowUp})`],
    ["probable", `Probables (${counts.probable})`],
    ["all", `Tous (${counts.all})`],
  ];

  return (
    <div className="mx-auto w-full max-w-[1400px] px-3 pb-16 sm:px-4">
      <div className="sticky top-0 z-30 -mx-3 bg-background/95 px-3 pb-3 pt-4 backdrop-blur sm:-mx-4 sm:px-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">
            <span className="text-accent">Contacts</span> producteurs
          </h1>
          <div className="flex items-center gap-2">
            <button
              onClick={enrichEmails}
              disabled={enriching}
              title="Relit les bios Instagram des contacts sans email"
              className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent disabled:opacity-50"
            >
              {enriching ? "Recherche…" : "Compléter les emails"}
            </button>
            <button
              onClick={exportCsv}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground/80 hover:border-accent/50"
            >
              Exporter CSV
            </button>
          </div>
        </div>

        {enrichMsg && (
          <p className="mb-2 text-xs text-foreground/50">{enrichMsg}</p>
        )}

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Producteur, @handle, email, album…"
          className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-foreground placeholder:text-foreground/30 focus:border-accent focus:outline-none"
        />

        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium transition ${
                filter === key
                  ? "bg-accent text-black"
                  : "bg-surface-light text-foreground/60"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="py-10 text-center text-foreground/40">Chargement…</p>}

      {!loading && visible.length === 0 && (
        <p className="py-10 text-center text-foreground/40">Aucun contact ne correspond.</p>
      )}

      {!loading && visible.length > 0 && (
        // Horizontal scroll on narrow screens; the name column stays pinned so
        // you always know which row you're editing.
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="bg-surface text-left text-xs uppercase tracking-wide text-foreground/50">
                <th className="sticky left-0 z-10 bg-surface px-3 py-3 font-medium">
                  Producteur
                </th>
                <th className="px-3 py-3 font-medium">Instagram</th>
                <th className="px-3 py-3 font-medium">Albums scannés</th>
                <th className="px-3 py-3 font-medium">Email / contact</th>
                <th className="px-3 py-3 font-medium">Envoyé le</th>
                <th className="px-3 py-3 font-medium">Relance</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => {
                const since = daysSince(c.emailedAt);
                const needsFollowUp =
                  since !== null && !c.followUpAt && since >= FOLLOW_UP_DAYS;
                return (
                  <tr
                    key={c.key}
                    className="border-t border-border/50 align-top hover:bg-surface-light/40"
                  >
                    {/* Producteur */}
                    <td className="sticky left-0 z-10 bg-background px-3 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{c.name}</span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            c.ig_status === "confirmed"
                              ? "bg-success/20 text-success"
                              : "bg-warning/20 text-warning"
                          }`}
                        >
                          {Math.round(c.ig_confidence * 100)}%
                        </span>
                      </div>
                      {c.followers !== null && c.followers > 0 && (
                        <div className="mt-0.5 text-xs text-foreground/40">
                          {c.followers.toLocaleString("fr-FR")} abonnés
                        </div>
                      )}
                    </td>

                    {/* Instagram */}
                    <td className="px-3 py-3">
                      {c.instagram ? (
                        <a
                          href={`https://www.instagram.com/${c.instagram}/`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline"
                        >
                          @{c.instagram}
                        </a>
                      ) : (
                        <span className="text-foreground/30">—</span>
                      )}
                    </td>

                    {/* Albums */}
                    <td className="px-3 py-3 text-xs text-foreground/60">
                      {c.albums.map((a) => (
                        <div key={a.scanId + a.album} className="truncate">
                          {a.artist} — {a.album}
                        </div>
                      ))}
                    </td>

                    {/* Email — editable, saved on blur */}
                    <td className="px-3 py-3">
                      <input
                        type="email"
                        defaultValue={c.email}
                        placeholder="email@…"
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v !== c.email) patch(c.key, { email: v, emailSource: "manual" });
                        }}
                        className="w-52 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
                      />
                      {c.email && c.emailSource && c.emailSource !== "manual" && (
                        <div className="mt-1 text-[10px] text-foreground/40">
                          {SOURCE_LABEL[c.emailSource] ?? "détecté dans la bio"}
                        </div>
                      )}
                      {/* A manager handle is a link, not an address — make it
                          openable so it's actually usable. */}
                      {c.emailSource === "mgmt_ig" && c.email.startsWith("@") && (
                        <a
                          href={`https://www.instagram.com/${c.email.slice(1)}/`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-0.5 block text-[10px] text-accent hover:underline"
                        >
                          ouvrir le profil manager →
                        </a>
                      )}
                    </td>

                    {/* Envoyé le */}
                    <td className="px-3 py-3">
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={Boolean(c.emailedAt)}
                          onChange={() => toggleEmailed(c)}
                          className="h-4 w-4 accent-[var(--accent)]"
                        />
                        <span
                          className={
                            c.emailedAt ? "text-foreground/80" : "text-foreground/30"
                          }
                        >
                          {c.emailedAt ? formatDate(c.emailedAt) : "non envoyé"}
                        </span>
                      </label>
                      {since !== null && (
                        <div
                          className={`mt-0.5 text-[10px] ${
                            needsFollowUp ? "text-warning" : "text-foreground/40"
                          }`}
                        >
                          il y a {since} j{needsFollowUp ? " → à relancer" : ""}
                        </div>
                      )}
                    </td>

                    {/* Relance */}
                    <td className="px-3 py-3">
                      {c.followUpAt ? (
                        <span className="text-xs text-foreground/60">
                          relancé {formatDate(c.followUpAt)}
                        </span>
                      ) : c.emailedAt ? (
                        <button
                          onClick={() => markFollowUp(c)}
                          className={`rounded-lg border px-2.5 py-1.5 text-xs ${
                            needsFollowUp
                              ? "border-warning/50 bg-warning/10 text-warning"
                              : "border-border bg-surface text-foreground/60"
                          }`}
                        >
                          Marquer relancé
                        </button>
                      ) : (
                        <span className="text-xs text-foreground/25">—</span>
                      )}
                      {saving === c.key && (
                        <div className="mt-1 text-[10px] text-accent">…</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && visible.length > 0 && (
        <p className="pt-4 text-center text-xs text-foreground/30">
          {visible.length} ligne{visible.length > 1 ? "s" : ""} · {counts.withEmail} email
          {counts.withEmail > 1 ? "s" : ""} connu{counts.withEmail > 1 ? "s" : ""} sur{" "}
          {counts.all} contacts
        </p>
      )}
    </div>
  );
}
