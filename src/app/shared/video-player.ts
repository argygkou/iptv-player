import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type Mpegts from 'mpegts.js';

/**
 * Plays a relay URL. Live channels are MPEG-TS, which Chromium/WebView2 cannot
 * play natively, so they go through mpegts.js (loaded on demand). Movies and
 * episodes use the native element; containers or codecs the webview cannot
 * decode (often MKV with AC3/DTS audio) surface as an error message.
 */
@Component({
  selector: 'app-video-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <video #video controls autoplay playsinline></video>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      background: #000;
      aspect-ratio: 16 / 9;
    }
    video {
      width: 100%;
      height: 100%;
    }
    .error {
      position: absolute;
      inset: auto 0 0;
      margin: 0;
      padding: 0.75rem 1rem;
      background: rgb(0 0 0 / 75%);
      color: var(--danger);
    }
  `,
})
export class VideoPlayer {
  readonly src = input.required<string>();
  readonly live = input(false);

  protected readonly error = signal<string | null>(null);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');

  constructor() {
    effect((onCleanup) => {
      const element = this.video().nativeElement;
      const src = this.src();
      this.error.set(null);

      const onError = () => this.error.set(describeMediaError(element.error));
      element.addEventListener('error', onError);
      onCleanup(() => element.removeEventListener('error', onError));

      if (this.live()) {
        let player: Mpegts.Player | undefined;
        let disposed = false;
        void import('mpegts.js').then(({ default: mpegts }) => {
          if (disposed) {
            return;
          }
          if (!mpegts.getFeatureList().mseLivePlayback) {
            this.error.set('Live MPEG-TS playback is not supported by this webview.');
            return;
          }
          player = mpegts.createPlayer(
            { type: 'mpegts', isLive: true, url: src },
            { enableWorker: false, liveBufferLatencyChasing: true, lazyLoad: false },
          );
          player.on(mpegts.Events.ERROR, (type: string, detail: string) =>
            this.error.set(`Playback error: ${type} (${detail})`),
          );
          player.attachMediaElement(element);
          player.load();
          void Promise.resolve(player.play()).catch(() => undefined);
        });
        onCleanup(() => {
          disposed = true;
          player?.destroy();
        });
      } else {
        element.src = src;
        void element.play().catch(() => undefined);
        onCleanup(() => {
          element.pause();
          element.removeAttribute('src');
          element.load();
        });
      }
    });
  }
}

function describeMediaError(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_NETWORK:
      return 'The stream could not be loaded from the provider.';
    case MediaError.MEDIA_ERR_DECODE:
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'This format or codec is not supported by the built-in player yet.';
    default:
      return 'Playback failed.';
  }
}
