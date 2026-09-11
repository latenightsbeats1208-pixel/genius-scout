import { db } from "@/lib/db";
import { getAlbumTracks, searchGeniusSong } from "@/agents/genius-search";
import { spotifyApi } from "@/lib/spotify-api";

interface UnifiedTrack {
  title: string;
  geniusSongId: number;
  geniusUrl: string;
  spotifyTrackId: string | null;
  spotifyUrl: string | null;
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fuzzyTitleMatch(a: string, b: string): boolean {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 6 && nb.includes(na.slice(0, 8))) return true;
  if (nb.length >= 6 && na.includes(nb.slice(0, 8))) return true;
  return false;
}

export async function POST(request: Request) {
  const body = await request.json();
  const { geniusAlbumId, spotifyAlbumId, albumTitle, artistName, albumArtUrl } = body;

  if (!geniusAlbumId && !spotifyAlbumId) {
    return Response.json(
      { error: "Missing geniusAlbumId or spotifyAlbumId" },
      { status: 400 }
    );
  }

  try {
    const now = new Date();
    const scanId = `${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}_${Math.random().toString(16).slice(2, 6)}`;

    let finalArtist = artistName || "";
    let finalAlbum = albumTitle || "";
    let finalArt = albumArtUrl || "";
    let geniusTracks: { title: string; genius_song_id: number; url: string }[] = [];
    let resolvedGeniusAlbumId: number = geniusAlbumId || 0;

    // ── Path A: User provided a Genius album ID ────────────────────────
    if (geniusAlbumId) {
      const gAlbum = await getAlbumTracks(geniusAlbumId);
      geniusTracks = gAlbum.tracks;
      finalArtist = finalArtist || gAlbum.artist;
      finalAlbum = finalAlbum || gAlbum.album;
      finalArt = finalArt || gAlbum.albumArtUrl;
    }

    // ── Path B: User provided a Spotify album ID directly ──────────────
    // (no Genius album lookup; we'll search Genius song by song below)
    let spotifyMatchId: string | null = spotifyAlbumId || null;
    if (spotifyAlbumId && spotifyApi.isConfigured()) {
      try {
        const spAlbum = await spotifyApi.getAlbumById(spotifyAlbumId);
        if (spAlbum) {
          finalArtist = finalArtist || spAlbum.artists.join(", ");
          finalAlbum = finalAlbum || spAlbum.name;
          finalArt = finalArt || spAlbum.cover_art_url || "";
        }
      } catch {
        // ignore, keep what the caller passed
      }
    }

    // 2. Try to enrich with Spotify (source of truth for tracklist completeness)
    let unified: UnifiedTrack[] = [];
    let spotifyEnriched = false;

    if (spotifyApi.isConfigured()) {
      try {
        // Use the provided Spotify album ID if available, otherwise search by name
        if (!spotifyMatchId) {
          const spAlbum = await spotifyApi.searchAlbum(finalArtist, finalAlbum);
          if (spAlbum) spotifyMatchId = spAlbum.id;
        }

        if (spotifyMatchId) {
          const spTracks = await spotifyApi.getAlbumTracks(spotifyMatchId);

          // For each Spotify track, find matching Genius track or look it up individually
          for (const st of spTracks) {
            const matching = geniusTracks.find((gt) =>
              fuzzyTitleMatch(gt.title, st.title)
            );

            if (matching) {
              unified.push({
                title: matching.title || st.title,
                geniusSongId: matching.genius_song_id,
                geniusUrl: matching.url,
                spotifyTrackId: st.id,
                spotifyUrl: st.url,
              });
            } else {
              // Genius didn't index this track on the album page → search individually
              const found = await searchGeniusSong(finalArtist, st.title);
              unified.push({
                title: st.title,
                geniusSongId: found?.id || 0,
                geniusUrl: found?.url || "",
                spotifyTrackId: st.id,
                spotifyUrl: st.url,
              });
            }
          }
          spotifyEnriched = true;
        }
      } catch {
        // Spotify enrichment failed, fall back to Genius tracklist
      }
    }

    // 3. Fallback if Spotify failed: Genius-only tracklist
    if (!spotifyEnriched) {
      unified = geniusTracks.map((t) => ({
        title: t.title,
        geniusSongId: t.genius_song_id,
        geniusUrl: t.url,
        spotifyTrackId: null,
        spotifyUrl: null,
      }));
    }

    if (unified.length === 0) {
      return Response.json(
        { error: "Aucun titre trouve pour cet album (ni Genius ni Spotify)" },
        { status: 404 }
      );
    }

    // 4. Persist scan + tracks
    db.createScan(scanId, finalArtist, finalAlbum, finalArt, resolvedGeniusAlbumId);
    db.updateScanCounts(scanId, unified.length, 0);

    for (const t of unified) {
      db.insertTrack(
        scanId,
        t.title,
        t.geniusSongId,
        t.geniusUrl,
        t.spotifyTrackId,
        t.spotifyUrl
      );
    }

    const geniusFound = unified.filter((t) => t.geniusSongId > 0).length;
    db.insertEvent(
      scanId,
      "scan_created",
      "system",
      `Scan cree: ${finalArtist} - ${finalAlbum} (${unified.length} titres ${spotifyEnriched ? `via Spotify, ${geniusFound} indexes sur Genius` : "via Genius uniquement"})`
    );

    return Response.json({
      scanId,
      artist: finalArtist,
      album: finalAlbum,
      albumArtUrl: finalArt,
      tracks: unified.map((t) => ({
        title: t.title,
        genius_song_id: t.geniusSongId,
        url: t.geniusUrl,
        spotify_track_id: t.spotifyTrackId,
        spotify_url: t.spotifyUrl,
      })),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
