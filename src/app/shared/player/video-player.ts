import { ChangeDetectionStrategy, Component, inject, input, resource } from '@angular/core';

import { NativePlayback } from './native-playback';
import { NativeVideoPlayer } from './native-video-player';
import { WebVideoPlayer } from './web-video-player';

/**
 * Plays a relay URL with libmpv when it is available, so MKV, HEVC, AC3/DTS
 * and subtitles work, and falls back to the webview's decoders otherwise.
 */
@Component({
  selector: 'app-video-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NativeVideoPlayer, WebVideoPlayer],
  template: `
    @if (native.hasValue()) {
      @if (native.value()) {
        <app-native-video-player [src]="src()" />
      } @else {
        <app-web-video-player [src]="src()" [live]="live()" />
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

  private readonly playback = inject(NativePlayback);
  protected readonly native = resource({ loader: () => this.playback.available });
}
