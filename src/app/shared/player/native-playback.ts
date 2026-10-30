import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { Bounds } from './bounds';

/**
 * Client for the libmpv player in the Rust backend. There is one native video
 * window, so calls are queued: a `stop()` from a destroyed player can never be
 * overtaken by the `open()` that preceded it, and bounds updates only reach
 * the window while something is playing.
 */
@Injectable({ providedIn: 'root' })
export class NativePlayback {
  /** Whether libmpv was found; `false` in mock mode and off Windows. */
  readonly available: Promise<boolean> = invoke<boolean>('player_available').catch(() => false);

  /** Set when mpv's controls (button, double-click, F, Esc) toggle fullscreen. */
  readonly fullscreen = signal(false);
  /** The last error mpv reported for the current stream. */
  readonly error = signal<string | null>(null);

  private queue: Promise<unknown> = Promise.resolve();
  private playing = false;
  private listening = false;

  open(url: string, bounds: Bounds): Promise<void> {
    this.listen();
    this.error.set(null);
    return this.enqueue(async () => {
      this.playing = true;
      await invoke('player_open', { url, bounds });
    });
  }

  setBounds(bounds: Bounds): Promise<void> {
    return this.enqueue(async () => {
      if (this.playing) {
        await invoke('player_set_bounds', { bounds });
      }
    });
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      this.playing = false;
      await invoke('player_stop');
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
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
    void listen<string>('player://error', ({ payload }) => {
      this.error.set(payload);
      // Hide the video window so the message underneath is visible.
      void this.stop();
    });
  }
}
