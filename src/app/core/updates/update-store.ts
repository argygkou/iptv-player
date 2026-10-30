import { computed, inject, Injectable, signal } from '@angular/core';

import { NativePlayback } from '../../shared/player/native-playback';
import { Update, UpdaterApi } from './updater-api';

export type UpdateState = 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'error';

/** First check after startup, so it never competes with the catalogue load. */
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Checks GitHub Releases for a newer version and installs it on request.
 * Background checks fail silently, since being offline is normal; a check the
 * user asked for reports its error.
 */
@Injectable({ providedIn: 'root' })
export class UpdateStore {
  private readonly api = inject(UpdaterApi);
  private readonly playback = inject(NativePlayback);

  readonly currentVersion = signal<string | null>(null);
  readonly state = signal<UpdateState>('idle');
  readonly update = signal<Update | null>(null);
  /** Download progress from 0 to 1, or `null` while the size is unknown. */
  readonly progress = signal<number | null>(null);
  readonly error = signal<string | null>(null);

  /** The version the user chose "Later" for; a newer one shows the banner again. */
  private readonly dismissedVersion = signal<string | null>(null);
  readonly showBanner = computed(() => {
    const update = this.update();
    return !!update && update.version !== this.dismissedVersion();
  });

  private started = false;

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.api.currentVersion().then(
      (version) => this.currentVersion.set(version),
      () => undefined,
    );
    setTimeout(() => void this.check(), FIRST_CHECK_MS);
    setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  async check(manual = false): Promise<void> {
    if (this.state() === 'checking' || this.state() === 'downloading') {
      return;
    }
    if (manual) {
      this.dismissedVersion.set(null);
    }
    this.state.set('checking');
    this.error.set(null);
    try {
      const update = await this.api.check();
      this.update.set(update);
      this.state.set(update ? 'available' : 'upToDate');
    } catch (error) {
      console.warn('Update check failed', error);
      this.error.set(manual ? String(error) : null);
      this.state.set(manual ? 'error' : this.update() ? 'available' : 'idle');
    }
  }

  dismiss(): void {
    this.dismissedVersion.set(this.update()?.version ?? null);
  }

  /** Downloads and installs the update, then restarts into the new version. */
  async install(): Promise<void> {
    const update = this.update();
    if (!update || this.state() === 'downloading') {
      return;
    }
    this.state.set('downloading');
    this.progress.set(null);
    this.error.set(null);
    let total = 0;
    let received = 0;
    try {
      // The installer replaces the executable and libmpv, so release them first.
      await this.playback.stop().catch(() => undefined);
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          this.progress.set(total ? Math.min(received / total, 1) : null);
        }
      });
      await this.api.relaunch();
    } catch (error) {
      console.warn('Update install failed', error);
      this.error.set(String(error));
      this.state.set('error');
    }
  }
}
