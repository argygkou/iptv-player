import { TestBed } from '@angular/core/testing';

import { XtreamApi } from '../xtream/xtream-api';
import { AccountInfo, Profile } from '../xtream/xtream.models';
import { SessionStore } from './session-store';

const account = { user_info: { username: 'alice', exp_date: '1700000000' } } as AccountInfo;
const profile: Profile = { id: 'p1', name: 'alice@tv', server: 'http://tv/', username: 'alice' };

describe('SessionStore', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;

  function setup(): SessionStore {
    api = {
      restoreSession: vi.fn(),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      logout: vi.fn().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({ providers: [{ provide: XtreamApi, useValue: api }] });
    return TestBed.inject(SessionStore);
  }

  it('restores the saved profile on startup', async () => {
    const store = setup();
    api['restoreSession'].mockResolvedValue({ account, profile });

    await store.restore();

    expect(store.isSignedIn()).toBe(true);
    expect(store.profile()).toEqual(profile);
    expect(store.profiles()).toEqual([profile]);
  });

  it('stays signed out and keeps the reason when restoring fails', async () => {
    const store = setup();
    api['restoreSession'].mockRejectedValue('The provider rejected these credentials');

    await store.restore();

    expect(store.isSignedIn()).toBe(false);
    expect(store.restoreError()).toBe('The provider rejected these credentials');
    expect(store.profiles()).toEqual([profile]);
  });

  it('clears the account on sign out', async () => {
    const store = setup();
    api['restoreSession'].mockResolvedValue({ account, profile });
    await store.restore();

    await store.signOut();

    expect(store.isSignedIn()).toBe(false);
    expect(api['logout']).toHaveBeenCalled();
  });
});
