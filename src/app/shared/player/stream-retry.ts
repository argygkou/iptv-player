import { signal } from '@angular/core';

/** Automatic attempts before the player asks the user to try again. */
export const MAX_RETRIES = 5;
/** How often the player checks that a stream's position is moving, in milliseconds. */
export const WATCH_INTERVAL = 5_000;
/** Uninterrupted playback that earns back every automatic attempt, in milliseconds. */
export const STABLE_PLAYBACK = 30_000;

export interface StreamFailure {
  message: string;
  /** The panel's HTTP status, when it refused or failed to serve the stream. */
  status?: number | null;
  /** A failure another attempt cannot fix, such as the player refusing the URL. */
  fatal?: boolean;
}

export type StreamState =
  | { readonly kind: 'playing' }
  | {
      readonly kind: 'retrying';
      /** 1-based. */
      readonly attempt: number;
      readonly of: number;
      readonly failure: StreamFailure;
    }
  | { readonly kind: 'failed'; readonly failure: StreamFailure };

/**
 * A bad account (401) or a stream the panel does not have (404, 410) fails the
 * same way every time. 403 is retried: many panels answer it when the
 * account's connection limit is reached, which clears once the previous
 * connection closes, for example right after switching channels.
 */
const FATAL_STATUSES = new Set([401, 404, 410]);
/** mpv's message for a file it cannot demux; the next attempt gets the same bytes. */
const FATAL_MESSAGES = new Set(['unrecognized file format']);

export function isRetryable({ message, status, fatal }: StreamFailure): boolean {
  return !fatal && !(status && FATAL_STATUSES.has(status)) && !FATAL_MESSAGES.has(message);
}

/**
 * Exponential backoff, 1 s doubling to 16 s on the fifth attempt, with ±25%
 * jitter so a retry does not land exactly when the panel is still releasing
 * the previous connection.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const base = 1000 * 2 ** (attempt - 1);
  return Math.round(base * (0.75 + random() * 0.5));
}

/** The failure, in words, for "This stream could not be played (…)". */
export function describeFailure({ message, status }: StreamFailure): string {
  switch (status) {
    case null:
    case undefined:
      return message;
    case 401:
    case 403:
      return `the provider refused access, HTTP ${status}`;
    case 404:
    case 410:
      return `the provider does not have this stream, HTTP ${status}`;
    default:
      return `${message}, HTTP ${status}`;
  }
}

/**
 * Retry policy for one player: reopens a failed stream up to [MAX_RETRIES]
 * times with backoff, then leaves it to the user. A stream whose position has
 * kept moving for [STABLE_PLAYBACK] gets all its attempts back, so a channel
 * that drops once an hour never runs out of them.
 */
export class StreamRetry {
  readonly state = signal<StreamState>({ kind: 'playing' });

  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Last sampled position, while samples keep coming without a failure. */
  private position: number | null = null;
  private steady = 0;

  /** `reopen` opens the same stream again. */
  constructor(
    private readonly reopen: () => void,
    private readonly random: () => number = Math.random,
  ) {}

  /** A different stream: forget the failures of the previous one. */
  reset(): void {
    this.cancel();
    this.attempts = 0;
    this.position = null;
    this.steady = 0;
    this.state.set({ kind: 'playing' });
  }

  /** Playback (re)started, as reported by a player that knows. */
  started(): void {
    if (this.timer === undefined && this.state().kind === 'retrying') {
      this.state.set({ kind: 'playing' });
    }
  }

  /** The stream's position, sampled every [WATCH_INTERVAL]. */
  watched(position: number): void {
    const moved = this.position !== null && position > this.position;
    this.position = position;
    if (!moved) {
      // Paused or stalled: neither proves the stream is healthy.
      this.steady = 0;
      return;
    }
    this.started();
    this.steady += WATCH_INTERVAL;
    if (this.steady >= STABLE_PLAYBACK) {
      this.attempts = 0;
    }
  }

  /** The stream failed: schedules the next attempt or gives up. */
  fail(failure: StreamFailure): void {
    // A second report of the failure already being handled.
    if (this.timer !== undefined || this.state().kind === 'failed') {
      return;
    }
    this.position = null;
    this.steady = 0;
    if (!isRetryable(failure) || this.attempts >= MAX_RETRIES) {
      this.state.set({ kind: 'failed', failure });
      return;
    }
    const attempt = ++this.attempts;
    this.state.set({ kind: 'retrying', attempt, of: MAX_RETRIES, failure });
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.reopen();
      },
      retryDelay(attempt, this.random),
    );
  }

  /** Stops retrying and shows the failure, with the manual retry. */
  giveUp(): void {
    const state = this.state();
    if (state.kind === 'retrying') {
      this.cancel();
      this.state.set({ kind: 'failed', failure: state.failure });
    }
  }

  /** The manual retry: a fresh set of attempts. */
  retryNow(): void {
    this.reset();
    this.reopen();
  }

  dispose(): void {
    this.cancel();
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
