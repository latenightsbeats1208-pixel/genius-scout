export interface GeniusAlbumResult {
  id: number;
  title: string;
  artist: string;
  cover_art_url: string;
  url: string;
  release_date?: string;
}

export interface GeniusTrack {
  title: string;
  genius_song_id: number;
  url: string;
}

export interface ProducerCredit {
  titre: string;
  credits: string[];
  statut: string;
  sourceUrl: string | null;
  genius_artist_ids?: { name: string; genius_artist_id: number }[];
}

export interface Producer {
  name: string;
  aliases: string[];
  sources: string[];
  double_source: boolean;
  genius_artist_id: number | null;
  track_titles: string[];
  instagram: string | null;
  ig_candidates: IgCandidate[];
  ig_status: "pending" | "confirmed" | "probable" | "not_found";
  ig_confidence: number;
  ig_profile_data: IgProfileData | null;
  ig_validation: IgValidation | null;
  identity_confirmed: boolean;
  credits_fm_url: string | null;
  musicbrainz_url: string | null;
}

export interface IgCandidate {
  handle: string;
  score: number;
  source: string;
}

export interface IgProfileData {
  existe: boolean;
  handle: string;
  nom_affiche: string;
  bio: string;
  followers: string;
  posts_recents: string[];
  est_prive: boolean;
}

export interface IgValidation {
  decision: "OUI" | "NON" | "PROBABLE";
  raison: string;
  confidence: number;
}

export type EventEmitter = (
  type: string,
  agent: string,
  message: string,
  data?: Record<string, unknown>
) => void;
