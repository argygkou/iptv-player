import {
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

import { Progress } from '../../core/library/library.models';

import { measure } from './bounds';
import { NativePlayback, PlayerInfo } from './native-playback';
import { PROGRESS_INTERVAL } from './progress';
import { StreamRetry, WATCH_INTERVAL } from './stream-retry';
import { StreamStatus } from './stream-status';

/**
 * Reserves the player's box in the page and keeps the native mpv window over
 * it. Position is polled once per frame rather than observed, because the box
 * also moves when its scroll container scrolls, which no observer reports.
 * mpv's own on-screen controller provides seeking, track and subtitle
 * selection, and fullscreen. A stream that fails is reopened automatically a
 * few times, a movie or episode where it stopped, before the user is asked.
 */
@Component({
  selector: 'app-native-video-player',
  imports: [StreamStatus],
  host: { '[class.fullscreen]': 'playback.fullscreen()' },
  template: `
    <app-stream-status [state]="retry.state()" (stop)="retry.giveUp()" (retry)="retry.retryNow()" />
  `,
  styles: `
    :host {
      display: grid;
      place-items: center;
      height: 100%;
      background: #000;
    }
    :host(.fullscreen) {
      position: fixed;
      inset: 0 var(--player-aside, 0) 0 0;
      z-index: 1000;
    }
  `,
})
export class NativeVideoPlayer {
  readonly src = input.required<string>();
  readonly live = input(false);
  /** Seconds to start from; read when a stream opens. */
  readonly start = input(0);
  /** Receives the position of a movie or episode while it plays and when it closes. */
  readonly onProgress = input<(progress: Progress) => void>();
  /** Without it, mpv goes back to the file's own title. */
  readonly info = input<PlayerInfo>();

  protected readonly playback = inject(NativePlayback);
  /** Bumped to reopen the stream: reopening the same URL is not a change of `src`. */
  private readonly attempt = signal(0);
  /** Where a movie or episode was when it last played, to reopen it there. */
  private latest: Progress | null = null;
  /** Set just before a retry of a movie or episode; read by the next open. */
  private resumeFrom: number | null = null;
  protected readonly retry = new StreamRetry(() => {
    this.resumeFrom = this.live() ? null : (this.latest?.position ?? null);
    this.attempt.update((n) => n + 1);
  });

  constructor() {
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

    // Reads the position one last time and stops sampling it.
    let finish: (() => void) | undefined;
    let stream = '';

    effect((onCleanup) => {
      const [src, live] = [this.src(), this.live()];
      this.attempt();
      if (`${live} ${src}` !== stream) {
        stream = `${live} ${src}`;
        this.latest = null;
        this.retry.reset();
      }
      const [initial, report] = untracked(() => [this.start(), this.onProgress()] as const);
      const start = this.resumeFrom ?? initial;
      this.resumeFrom = null;
      this.playback.open(src, live, measure(element), start).catch((error: unknown) => {
        this.retry.fail({ message: String(error), fatal: true });
        void this.playback.stop();
      });

      // Queued like every other call, so it reads this file before the next opens.
      let current = true;
      const sample = () =>
        this.playback
          .progress()
          .then((progress) => {
            if (current && progress) {
              this.latest = progress;
              this.retry.watched(progress.position);
            }
            return progress;
          })
          .catch(() => null);
      const watch = setInterval(sample, WATCH_INTERVAL);
      // Only new positions: after a failure or while paused, there is nothing to save.
      let saved: Progress | null = null;
      const save =
        live || !report
          ? undefined
          : setInterval(() => {
              if (this.latest && this.latest !== saved) {
                saved = this.latest;
                report(saved);
              }
            }, PROGRESS_INTERVAL);
      finish = () => {
        finish = undefined;
        current = false;
        clearInterval(watch);
        if (report && save !== undefined) {
          clearInterval(save);
          void sample().then((progress) => progress && report(progress));
        }
      };
      onCleanup(() => finish?.());
    });

    effect(() => {
      const error = this.playback.error();
      if (error) {
        untracked(() => this.retry.fail(error));
      }
    });

    // After the effect above, whose first `open()` is what creates mpv.
    effect(() => {
      const info = this.info() ?? { title: '', details: '' };
      this.playback.setInfo(info).catch(() => undefined);
    });

    let last = '';
    const track = () => {
      const bounds = measure(element);
      const key = JSON.stringify(bounds);
      if (key !== last) {
        last = key;
        this.playback.setBounds(bounds).catch(() => undefined);
      }
      frame = requestAnimationFrame(track);
    };
    let frame = requestAnimationFrame(track);

    inject(DestroyRef).onDestroy(() => {
      cancelAnimationFrame(frame);
      this.retry.dispose();
      // Before `stop()`, which unloads the file.
      finish?.();
      void this.playback.stop();
    });
  }
}
