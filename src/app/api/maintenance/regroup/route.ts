import { db } from "@/lib/db";
import { normalizeCreditKey } from "@/agents/credit-merger";

/**
 * One-shot cleanup: regroup duplicate producers inside every existing scan.
 *
 * Historical scans were merged with a weaker key (accents, punctuation and
 * "prod by" prefixes each produced a separate row), so the same producer could
 * appear several times per album. This pass merges those rows: union of
 * tracks, sources and aliases; the row with the best Instagram verdict keeps
 * its verification; the Genius spelling wins as display name. Idempotent —
 * a second run finds nothing left to merge.
 */

const STATUS_RANK: Record<string, number> = {
  confirmed: 3,
  probable: 2,
  not_found: 1,
  pending: 0,
};

function parseList(v: unknown): string[] {
  try {
    const parsed = JSON.parse((v as string) || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function POST() {
  // Rollback point before a structural rewrite of every scan.
  try {
    db.backupNow(0);
  } catch {
    /* snapshots are protection, not a prerequisite */
  }

  const details: { scan: string; avant: number; apres: number }[] = [];
  let fusions = 0;

  for (const s of db.getAllScans()) {
    const rows = db.getProducers(s.id as string);
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const key = normalizeCreditKey((r.name as string) || "");
      if (!key) continue;
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }

    let merged = 0;
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const best = [...g].sort(
        (a, b) =>
          (STATUS_RANK[b.ig_status as string] ?? 0) -
            (STATUS_RANK[a.ig_status as string] ?? 0) ||
          ((b.ig_confidence as number) || 0) - ((a.ig_confidence as number) || 0) ||
          (a.id as number) - (b.id as number)
      )[0];

      const geniusMember = g.find((r) => parseList(r.sources).includes("GENIUS"));
      const displayName = (geniusMember?.name as string) || (best.name as string);

      const aliases = new Set<string>();
      const sources = new Set<string>();
      const titles = new Set<string>();
      for (const r of g) {
        for (const a of parseList(r.aliases)) aliases.add(a);
        for (const x of parseList(r.sources)) sources.add(x);
        for (const t of parseList(r.track_titles)) titles.add(t);
        const n = r.name as string;
        if (n && n !== displayName) aliases.add(n);
      }
      aliases.delete(displayName);

      db.updateProducerGroup(
        best.id as number,
        displayName,
        [...aliases],
        [...sources],
        [...titles]
      );
      for (const r of g) {
        if (r.id !== best.id) db.deleteProducerById(r.id as number);
      }
      merged += g.length - 1;
    }

    if (merged > 0) {
      fusions += merged;
      details.push({
        scan: (s.artist as string) + " \u2014 " + (s.album as string),
        avant: rows.length,
        apres: rows.length - merged,
      });
    }
  }

  return Response.json({
    scans_modifies: details.length,
    doublons_fusionnes: fusions,
    details,
  });
}
