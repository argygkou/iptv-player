/** What the user keeps: favourites and watch history, saved per profile by the backend. */
export type LibraryKind = 'live' | 'movie' | 'series' | 'episode';

/** Enough to list and open an item without asking the provider again. */
export interface LibraryItem {
  kind: LibraryKind;
  id: string;
  name: string;
  image: string;
  /** For episodes: the series they belong to. */
  seriesId?: string;
  seriesName?: string;
}

export interface Favourite extends LibraryItem {
  /** Unix time in seconds. */
  addedAt: number;
}

export interface Watched extends LibraryItem {
  /** Unix time in seconds. */
  watchedAt: number;
  /** Seconds in; 0 for live channels. */
  position: number;
  /** Seconds; 0 when unknown. */
  duration: number;
}

/** Both lists are newest first. */
export interface Library {
  favourites: Favourite[];
  history: Watched[];
}

/** A player's position in the current file, in seconds. */
export interface Progress {
  position: number;
  /** `null` for live streams and files of unknown length. */
  duration: number | null;
}

export const EMPTY_LIBRARY: Library = { favourites: [], history: [] };

/** Less than this in is not worth resuming. */
const MIN_RESUME = 30;
/** This close to the end counts as watched. */
const END_MARGIN = 90;

export function libraryKey(kind: LibraryKind, id: string): string {
  return `${kind}:${id}`;
}

/** Whether the movie or episode was watched to the end (credits included). */
export function isFinished(watched: Watched): boolean {
  return (
    watched.duration > 0 &&
    watched.position >= Math.min(watched.duration - END_MARGIN, watched.duration * 0.95)
  );
}

/** Where to start playing again; 0 to start over. */
export function resumePosition(watched: Watched | undefined): number {
  if (!watched || watched.position < MIN_RESUME || isFinished(watched)) {
    return 0;
  }
  return watched.position;
}

/** How much was watched, 0 to 1; `null` without a known length. */
export function watchedFraction(watched: Watched | undefined): number | null {
  if (!watched || watched.duration <= 0) {
    return null;
  }
  return isFinished(watched) ? 1 : Math.min(watched.position / watched.duration, 1);
}

/** `h:mm:ss` or `m:ss`. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
