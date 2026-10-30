import { Injectable } from '@angular/core';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, Update } from '@tauri-apps/plugin-updater';

export type { Update };

/** Facade over the Tauri updater and process plugins, so `UpdateStore` can be tested without them. */
@Injectable({ providedIn: 'root' })
export class UpdaterApi {
  currentVersion(): Promise<string> {
    return getVersion();
  }

  /** The newest release from `latest.json` on GitHub Releases, or `null` when this build is current. */
  check(): Promise<Update | null> {
    return check();
  }

  relaunch(): Promise<void> {
    return relaunch();
  }
}
