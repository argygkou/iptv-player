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
} from '@angular/core';

import { measure } from './bounds';
import { NativePlayback } from './native-playback';

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
      <p class="error" role="alert">{{ message }}</p>
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
      inset: 0;
      z-index: 1000;
    }
    .error {
      margin: 0;
      padding: 1rem;
      color: var(--danger);
      text-align: center;
    }
  `,
})
export class NativeVideoPlayer {
  readonly src = input.required<string>();

  protected readonly playback = inject(NativePlayback);
  private readonly failed = signal<string | null>(null);
  protected readonly message = computed(() => {
    const error = this.failed() ?? this.playback.error();
    return error && `This stream could not be played (${error}).`;
  });

  constructor() {
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

    effect(() => {
      const src = this.src();
      this.failed.set(null);
      this.playback.open(src, measure(element)).catch((error: unknown) => {
        this.failed.set(String(error));
        void this.playback.stop();
      });
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
      void this.playback.stop();
    });
  }
}
