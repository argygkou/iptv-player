import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  resource,
  untracked,
} from '@angular/core';

import { LibraryStore } from '../../core/library/library-store';
import { LibraryItem, Progress } from '../../core/library/library.models';
import { NativePlayback } from './native-playback';
import { NativeVideoPlayer } from './native-video-player';
import { WebVideoPlayer } from './web-video-player';

/**
 * Plays a relay URL with libmpv when it is available, so MKV, HEVC, AC3/DTS
 * and subtitles work, and falls back to the webview's decoders otherwise.
 * With an `item`, playback goes into the watch history, and for movies and
 * episodes so does the position, which `start` can resume from.
 */
@Component({
  selector: 'app-video-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NativeVideoPlayer, WebVideoPlayer],
  template: `
    @if (native.hasValue()) {
      @if (native.value()) {
        <app-native-video-player
          [src]="src()"
          [live]="live()"
          [start]="start()"
          [onProgress]="report()"
        />
      } @else {
        <app-web-video-player
          [src]="src()"
          [live]="live()"
          [start]="start()"
          [onProgress]="report()"
        />
      }
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      background: #000;
      aspect-ratio: 16 / 9;
    }
  `,
})
export class VideoPlayer {
  readonly src = input.required<string>();
  readonly live = input(false);
  /** What is playing, for the watch history. */
  readonly item = input<LibraryItem>();
  /** Seconds to start from. */
  readonly start = input(0);

  private readonly playback = inject(NativePlayback);
  private readonly library = inject(LibraryStore);
  protected readonly native = resource({ loader: () => this.playback.available });

  /**
   * Bound to one item, so a late report never lands on the next one. A file
   * that has not really started yet reports 0, which must not overwrite the
   * saved position.
   */
  protected readonly report = computed(() => {
    const item = this.item();
    return (
      item &&
      ((progress: Progress) => {
        if (progress.position >= 1) {
          void this.library.record(item, progress);
        }
      })
    );
  });

  constructor() {
    effect(() => {
      this.src();
      const item = this.item();
      if (item) {
        untracked(() => void this.library.record(item));
      }
    });
  }
}
