import path from "path";
import fs from "fs";
import { db, resolveDbPath } from "@/lib/db";

/**
 * Where the data actually lives, and how much of it there is.
 *
 * The history once came back empty while a 27 MB database sat on disk: the
 * server was reading a different file than the one being inspected, and every
 * query answered "0" without a single error. This endpoint makes that class of
 * problem visible in one request instead of an afternoon of guessing.
 */
export async function GET() {
  // Le chemin REEL du module db — une copie locale de la logique avait déjà
  // fait afficher l'ancien emplacement pendant que les données vivaient ailleurs.
  const dbPath = resolveDbPath();

  const backupsDir = path.join(path.dirname(dbPath), "backups");
  let backups: { file: string; date: string; mo: number }[] = [];
  try {
    backups = fs
      .readdirSync(backupsDir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => {
        const st = fs.statSync(path.join(backupsDir, f));
        return {
          file: f,
          date: new Date(st.mtimeMs).toISOString(),
          mo: Math.round((st.size / 1048576) * 10) / 10,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    /* no backup yet */
  }

  const scans = db.getAllScans();
  return Response.json({
    fichier: dbPath,
    existe: fs.existsSync(dbPath),
    taille_mo: fs.existsSync(dbPath)
      ? Math.round((fs.statSync(dbPath).size / 1048576) * 10) / 10
      : 0,
    scans: scans.length,
    contacts: db.getAllContacts().length,
    dernier_scan: scans[0]
      ? `${scans[0].artist} — ${scans[0].album} (${scans[0].created_at})`
      : null,
    sauvegardes: backups,
  });
}
