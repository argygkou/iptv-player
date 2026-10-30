import {
  ChangeDetectionStrategy,
  Component,
  computed,
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

/**
 * Reserves the player's box in the page and keeps the native mpv window over
 * it. Position is polled once per frame rather than observed, because the box
 * also moves when its scroll container scrolls, which no observer reports.
 * mpv's own on-screen controller provides seeking, track and subtitle
 * selection, and fullscreen.
 */
@Component({
  selector: 'app-native-video-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.fullscreen]': 'playback.fullscreen()' },
  template: `
    @if (message(); as message) {
      <div class="error" role="alert">
        <p>{{ message }}</p>
        <button type="button" (click)="retry()">Try again</button>
      </div>
    }
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
    .error {
      display: grid;
      justify-items: center;
      gap: 0.75rem;
      padding: 1rem;
      color: var(--danger);
      text-align: center;

      p {
        margin: 0;
      }
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
  private readonly failed = signal<string | null>(null);
  /** Bumped by "Try again": reopening the same URL is not a change of `src`. */
  private readonly attempt = signal(0);
  protected readonly message = computed(() => {
    const error = this.failed() ?? this.playback.error();
    return error && `This stream could not be played (${error}).`;
  });

  constructor() {
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

    // Reads the position one last time; set while a movie or episode plays.
    let finish: (() => void) | undefined;

    effect((onCleanup) => {
      const [src, live] = [this.src(), this.live()];
      this.attempt();
      const [start, report] = untracked(() => [this.start(), this.onProgress()] as const);
      this.failed.set(null);
      this.playback.open(src, live, measure(element), start).catch((error: unknown) => {
        this.failed.set(String(error));
        void this.playback.stop();
      });
      if (live || !report) {
        return;
      }
      // Queued like every other call, so it reads this file before the next opens.
      const sample = () =>
        void this.playback
          .progress()
          .then((progress) => progress && report(progress))
          .catch(() => undefined);
      const timer = setInterval(sample, PROGRESS_INTERVAL);
      finish = () => {
        clearInterval(timer);
        finish = undefined;
        sample();
      };
      onCleanup(() => finish?.());
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
      // Before `stop()`, which unloads the file.
      finish?.();
      void this.playback.stop();
    });
  }

  protected retry(): void {
    this.attempt.update((n) => n + 1);
  }
}
