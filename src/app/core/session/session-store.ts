import { computed, inject, Injectable, signal } from '@angular/core';

import { XtreamApi } from '../xtream/xtream-api';
import { AccountInfo, Credentials } from '../xtream/xtream.models';

const REMEMBERED_KEY = 'iptv.remembered-login';

export type RememberedLogin = Pick<Credentials, 'server' | 'username'>;

/**
 * Holds the signed-in account. The password is never persisted on the frontend;
 * it lives only in the Rust process for the current run.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly api = inject(XtreamApi);

  readonly account = signal<AccountInfo | null>(null);
  readonly isSignedIn = computed(() => this.account() !== null);
  readonly expiresAt = computed(() => {
    const exp = this.account()?.user_info.exp_date;
    return exp ? new Date(Number(exp) * 1000) : null;
  });

  async signIn(credentials: Credentials, remember: boolean): Promise<void> {
    const account = await this.api.login(credentials);
    this.account.set(account);
    if (remember) {
      const { server, username } = credentials;
      localStorage.setItem(REMEMBERED_KEY, JSON.stringify({ server, username }));
    } else {
      localStorage.removeItem(REMEMBERED_KEY);
    }
  }

  async signOut(): Promise<void> {
    await this.api.logout();
    this.account.set(null);
  }

  rememberedLogin(): RememberedLogin | null {
    try {
      const raw = localStorage.getItem(REMEMBERED_KEY);
      return raw ? (JSON.parse(raw) as RememberedLogin) : null;
    } catch {
      return null;
    }
  }
}
