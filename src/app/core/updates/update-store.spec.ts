import { TestBed } from '@angular/core/testing';

import { NativePlayback } from '../../shared/player/native-playback';
import { UpdaterApi } from './updater-api';
import { UpdateStore } from './update-store';

type Event =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

function fakeUpdate(version = '0.2.0') {
  return {
    version,
    downloadAndInstall: vi.fn(async (onEvent: (event: Event) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent({ event: 'Progress', data: { chunkLength: 60 } });
      onEvent({ event: 'Finished' });
    }),
  };
}

describe('UpdateStore', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let playback: { stop: ReturnType<typeof vi.fn> };

  function setup(): UpdateStore {
    api = {
      currentVersion: vi.fn().mockResolvedValue('0.1.0'),
      check: vi.fn().mockResolvedValue(null),
      relaunch: vi.fn().mockResolvedValue(undefined),
    };
    playback = { stop: vi.fn().mockResolvedValue(undefined) };
    TestBed.configureTestingModule({
      providers: [
        { provide: UpdaterApi, useValue: api },
        { provide: NativePlayback, useValue: playback },
      ],
    });
    return TestBed.inject(UpdateStore);
  }

  it('reports being up to date when no release is newer', async () => {
    const store = setup();

    await store.check(true);

    expect(store.state()).toBe('upToDate');
    expect(store.showBanner()).toBe(false);
  });

  it('shows the banner for a newer release until dismissed', async () => {
    const store = setup();
    api['check'].mockResolvedValue(fakeUpdate('0.2.0'));

    await store.check();
    expect(store.state()).toBe('available');
    expect(store.showBanner()).toBe(true);

    store.dismiss();
    expect(store.showBanner()).toBe(false);

    api['check'].mockResolvedValue(fakeUpdate('0.3.0'));
    await store.check();
    expect(store.showBanner()).toBe(true);
  });

  it('stays quiet when a background check fails, but reports a manual one', async () => {
    const store = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    api['check'].mockRejectedValue('offline');

    await store.check();
    expect(store.state()).toBe('idle');
    expect(store.error()).toBeNull();

    await store.check(true);
    expect(store.state()).toBe('error');
    expect(store.error()).toBe('offline');
  });

  it('stops playback, installs with progress and relaunches', async () => {
    const store = setup();
    const update = fakeUpdate();
    api['check'].mockResolvedValue(update);
    await store.check();

    await store.install();

    expect(playback.stop).toHaveBeenCalled();
    expect(update.downloadAndInstall).toHaveBeenCalled();
    expect(store.progress()).toBe(1);
    expect(api['relaunch']).toHaveBeenCalled();
  });

  it('keeps the error when the install fails', async () => {
    const store = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const update = fakeUpdate();
    update.downloadAndInstall.mockRejectedValue('signature mismatch');
    api['check'].mockResolvedValue(update);
    await store.check();

    await store.install();

    expect(store.state()).toBe('error');
    expect(store.error()).toBe('signature mismatch');
    expect(api['relaunch']).not.toHaveBeenCalled();
  });
});
