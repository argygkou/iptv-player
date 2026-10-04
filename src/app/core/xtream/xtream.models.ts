/**
 * Shapes returned by Xtream Codes `player_api.php`.
 *
 * Panels are inconsistent about numbers vs. numeric strings, so ids are typed
 * loosely and normalised with `String(...)` where they are compared.
 */
export type XtreamId = string | number;

export type StreamKind = 'live' | 'movie' | 'series';

export interface Credentials {
  server: string;
  username: string;
  password: string;
}

export interface AccountInfo {
  user_info: {
    username: string;
    status: string;
    exp_date: string | null;
    is_trial: string;
    active_cons: string | number;
    max_connections: string | number;
    allowed_output_formats: string[];
  };
  server_info: {
    url: string;
    port: string;
    timezone: string;
    time_now: string;
  };
}

export interface Category {
  category_id: string;
  category_name: string;
  parent_id: XtreamId;
}

export interface LiveStream {
  num: number;
  name: string;
  stream_id: XtreamId;
  stream_icon: string;
  epg_channel_id: string | null;
  category_id: string;
  tv_archive: number;
}

export interface VodStream {
  num: number;
  name: string;
  stream_id: XtreamId;
  stream_icon: string;
  rating: string | number;
  category_id: string;
  container_extension: string;
  added: string;
}

export interface SeriesItem {
  num: number;
  name: string;
  series_id: XtreamId;
  cover: string;
  plot: string;
  cast: string;
  director: string;
  genre: string;
  releaseDate: string;
  rating: string | number;
  backdrop_path: string[];
  category_id: string;
}

export interface VodInfo {
  info: {
    movie_image?: string;
    backdrop_path?: string[];
    plot?: string;
    description?: string;
    cast?: string;
    director?: string;
    genre?: string;
    releasedate?: string;
    duration?: string;
    rating?: string | number;
    youtube_trailer?: string;
  };
  movie_data: {
    stream_id: XtreamId;
    name: string;
    container_extension: string;
    category_id: string;
  };
}

export interface Season {
  season_number: number;
  name: string;
  episode_count: XtreamId;
  cover?: string;
  overview?: string;
}

export interface Episode {
  id: XtreamId;
  episode_num: XtreamId;
  title: string;
  container_extension: string;
  season: XtreamId;
  info?: {
    duration?: string;
    plot?: string;
    movie_image?: string;
    rating?: string | number;
  };
}

export interface SeriesInfo {
  info: SeriesItem;
  seasons: Season[];
  /** Keyed by season number. Some panels send an array instead of an object. */
  episodes: Record<string, Episode[]> | Episode[][];
}

/** EPG entry as sent by the panel; `title` and `description` are base64. */
export interface EpgListing {
  id: string;
  epg_id: string;
  title: string;
  description: string;
  start_timestamp: string;
  stop_timestamp: string;
  channel_id: string;
}

export interface ShortEpgResponse {
  epg_listings: EpgListing[];
}

/** A decoded EPG entry. */
export interface Programme {
  title: string;
  description: string;
  start: Date;
  end: Date;
}
