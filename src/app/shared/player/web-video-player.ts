import {
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type Mpegts from 'mpegts.js';

import { Progress } from '../../core/library/library.models';
import { PROGRESS_INTERVAL } from './progress';
import { StreamFailure, StreamRetry, WATCH_INTERVAL } from './stream-retry';
import { StreamStatus } from './stream-status';

/**
 * Fallback player for when libmpv is unavailable (mock mode, other platforms):
 * plays a relay URL in the webview. Live channels are MPEG-TS, which
 * Chromium/WebView2 cannot play natively, so they go through mpegts.js (loaded
 * on demand). Movies and episodes use the native element; containers or codecs
 * the webview cannot decode (often MKV with AC3/DTS audio) surface as an error.
 * Failed streams are retried like in the native player.
 */
/**
 * IPTV panels deliver live TS in bursts, so the player needs a few seconds of
 * headroom. Latency is trimmed by playing slightly faster (`liveSync`) rather
 * than seeking to the live edge, which would drain the buffer and stall.
 */
const LIVE_CONFIG: Mpegts.Config = {
  enableWorker: false,
  enableStashBuffer: true,
  stashInitialSize: 1024 * 1024,
  lazyLoad: false,
  liveBufferLatencyChasing: false,
  liveSync: true,
  liveSyncMaxLatency: 12,
  liveSyncTargetLatency: 6,
  liveSyncPlaybackRate: 1.1,
  // Long sessions would otherwise grow the SourceBuffer until it overflows.
  autoCleanupSourceBuffer: true,
  autoCleanupMaxBackwardDuration: 60,
  autoCleanupMinBackwardDuration: 30,
};

@Component({
  selector: 'app-web-video-player',
  imports: [StreamStatus],
  template: `
    <video #video controls autoplay playsinline></video>
    <div class="overlay">
      <app-stream-status
        [state]="retry.state()"
        (stop)="retry.giveUp()"
        (retry)="retry.retryNow()"
      />
    </div>
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      height: 100%;
    }
    video {
      width: 100%;
      height: 100%;
    }
    .overlay {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 1rem;
      pointer-events: none;
    }
  `,
})
export class WebVideoPlayer {
  readonly src = input.required<string>();
  readonly live = input(false);
  /** Seconds to start from; read when a stream opens. */
  readonly start = input(0);
  /** Receives the position of a movie or episode while it plays and when it closes. */
  readonly onProgress = input<(progress: Progress) => void>();

  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  /** Bumped to reopen the stream: reopening the same URL is not a change of `src`. */
  private readonly attempt = signal(0);
  /** Where a movie or episode was when it last played, to reopen it there. */
  private latest: number | null = null;
  /** Set just before a retry of a movie or episode; read by the next open. */
  private resumeFrom: number | null = null;
  protected readonly retry = new StreamRetry(() => {
    this.resumeFrom = this.live() ? null : this.latest;
    this.attempt.update((n) => n + 1);
  });

  constructor() {
    let stream = '';
    inject(DestroyRef).onDestroy(() => this.retry.dispose());

    effect((onCleanup) => {
      const element = this.video().nativeElement;
      const [src, live] = [this.src(), this.live()];
      this.attempt();
      if (`${live} ${src}` !== stream) {
        stream = `${live} ${src}`;
        this.latest = null;
        this.retry.reset();
      }
      const fail = (failure: StreamFailure) => this.retry.fail(failure);

      const onError = () => fail(describeMediaError(element.error));
      const onPlaying = () => this.retry.started();
      element.addEventListener('error', onError);
      element.addEventListener('playing', onPlaying);
      onCleanup(() => {
        element.removeEventListener('error', onError);
        element.removeEventListener('playing', onPlaying);
      });

      const watch = setInterval(() => {
        if (element.readyState > 0 && !element.paused) {
          this.retry.watched(element.currentTime);
          this.latest = live ? null : element.currentTime;
        }
      }, WATCH_INTERVAL);
      onCleanup(() => clearInterval(watch));

      if (live) {
        let player: Mpegts.Player | undefined;
        let disposed = false;
        void import('mpegts.js').then(({ default: mpegts }) => {
          if (disposed) {
            return;
          }
          if (!mpegts.getFeatureList().mseLivePlayback) {
            fail({ message: 'live MPEG-TS is not supported by this webview', fatal: true });
            return;
          }
          player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src }, LIVE_CONFIG);
          const { ErrorDetails } = mpegts;
          player.on(mpegts.Events.ERROR, (type: string, detail: string, info?: { code?: number }) =>
            fail({
              message: `${type}: ${detail}`,
              status: detail === ErrorDetails.NETWORK_STATUS_CODE_INVALID ? info?.code : null,
              fatal:
                detail === ErrorDetails.MEDIA_FORMAT_UNSUPPORTED ||
                detail === ErrorDetails.MEDIA_CODEC_UNSUPPORTED,
            }),
          );
          // A live stream has no end; the panel closed it.
          player.on(mpegts.Events.LOADING_COMPLETE, () =>
            fail({ message: 'the live stream ended' }),
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
        const [initial, report] = untracked(() => [this.start(), this.onProgress()] as const);
        const start = this.resumeFrom ?? initial;
        this.resumeFrom = null;
        if (start > 0) {
          const seek = () => (element.currentTime = start);
          element.addEventListener('loadedmetadata', seek, { once: true });
          onCleanup(() => element.removeEventListener('loadedmetadata', seek));
        }
        if (report) {
          const sample = () => {
            if (element.readyState > 0) {
              const duration = element.duration;
              report({
                position: element.currentTime,
                duration: Number.isFinite(duration) ? duration : null,
              });
            }
          };
          const timer = setInterval(sample, PROGRESS_INTERVAL);
          // Registered before the reset below, so it still sees the position.
          onCleanup(() => {
            clearInterval(timer);
            sample();
          });
        }
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

/** Only network errors are worth another attempt. */
function describeMediaError(error: MediaError | null): StreamFailure {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_NETWORK:
      return { message: 'it could not be loaded from the provider' };
    case MediaError.MEDIA_ERR_DECODE:
      return {
        message: 'its format or codec is not supported by the built-in player yet',
        fatal: true,
      };
    // Chromium reports a stream it could not fetch the same way as one it
    // cannot decode, and an unsupported file fails every time.
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return {
        message: 'the built-in player could not load it or does not support its format',
        fatal: true,
      };
    default:
      return { message: 'playback failed' };
  }
}
