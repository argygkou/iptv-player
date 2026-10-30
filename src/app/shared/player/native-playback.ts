import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { Progress } from '../../core/library/library.models';
import { Bounds } from './bounds';

interface PlaybackError {
  /** The `open()` call the failing stream belongs to. */
  generation: number;
  message: string;
}

/** What mpv shows about the stream, as the page is out of sight in fullscreen. */
export interface PlayerInfo {
  /** For the title on mpv's controller. */
  title: string;
  /** For the banner shown on entering fullscreen and on `i`; may span lines. */
  details: string;
}

/**
 * Client for the libmpv player in the Rust backend. There is one native video
 * window, so calls are queued: a `stop()` from a destroyed player can never be
 * overtaken by the `open()` that preceded it, and bounds updates only reach
 * the window while something is playing.
 */
@Injectable({ providedIn: 'root' })
export class NativePlayback {
  /** Whether libmpv loaded; `false` in mock mode, off Windows, or with a broken DLL. */
  readonly available: Promise<boolean> = invoke<boolean>('player_available').catch(() => false);

  /** Set when mpv's controls (button, double-click, F, Esc) toggle fullscreen. */
  readonly fullscreen = signal(false);
  /** The last error mpv reported for the current stream. */
  readonly error = signal<string | null>(null);

  private queue: Promise<unknown> = Promise.resolve();
  private playing = false;
  private listening = false;
  private generation = 0;
  /** Latest bounds not yet sent; updates in between are dropped, not queued. */
  private pendingBounds: Bounds | null = null;

  /** `start` is in seconds, to resume a movie or episode. */
  open(url: string, live: boolean, bounds: Bounds, start = 0): Promise<void> {
    this.listen();
    this.error.set(null);
    // Set before the call: an error can arrive before `player_open` returns.
    const generation = ++this.generation;
    return this.enqueue(async () => {
      this.playing = true;
      await invoke('player_open', { media: { url, generation, live, start }, bounds });
    });
  }

  setBounds(bounds: Bounds): Promise<void> {
    const scheduled = this.pendingBounds !== null;
    this.pendingBounds = bounds;
    if (scheduled) {
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      const latest = this.pendingBounds;
      this.pendingBounds = null;
      if (this.playing && latest) {
        await invoke('player_set_bounds', { bounds: latest });
      }
    });
  }

  setInfo({ title, details }: PlayerInfo): Promise<void> {
    return this.enqueue(() => invoke('player_set_info', { title, details }));
  }

  /** Where the current file is; `null` when nothing is playing. */
  progress(): Promise<Progress | null> {
    return this.enqueue(async () =>
      this.playing ? invoke<Progress | null>('player_progress') : null,
    );
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      this.playing = false;
      await invoke('player_stop');
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private listen(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    void listen<boolean>('player://fullscreen', ({ payload }) => this.fullscreen.set(payload));
    void listen<PlaybackError>('player://error', ({ payload }) => {
      // A stream the user already left may still fail; that is not news.
      if (payload.generation !== this.generation) {
        return;
      }
      this.error.set(payload.message);
      // Hide the video window so the message underneath is visible.
      void this.stop();
    });
  }
}
