import { computed, inject, Injectable, signal } from '@angular/core';

import { XtreamApi } from '../xtream/xtream-api';
import { AccountInfo, Credentials, Profile, SignedIn } from '../xtream/xtream.models';

/**
 * The signed-in account and the saved profiles. Passwords never reach the
 * frontend: the backend keeps them in the OS credential store.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly api = inject(XtreamApi);

  readonly account = signal<AccountInfo | null>(null);
  /** The saved profile in use, or `null` for a one-off sign-in. */
  readonly profile = signal<Profile | null>(null);
  readonly profiles = signal<Profile[]>([]);
  /** Why the saved profile could not be restored on launch, if it failed. */
  readonly restoreError = signal<string | null>(null);

  readonly isSignedIn = computed(() => this.account() !== null);
  readonly expiresAt = computed(() => {
    const exp = this.account()?.user_info.exp_date;
    return exp ? new Date(Number(exp) * 1000) : null;
  });

  /** Runs once at startup; never throws so the app always boots. */
  async restore(): Promise<void> {
    try {
      const signedIn = await this.api.restoreSession();
      if (signedIn) {
        this.apply(signedIn);
      }
    } catch (err) {
      this.restoreError.set(describeError(err));
    }
    await this.refreshProfiles();
  }

  async signIn(credentials: Credentials, remember: boolean): Promise<void> {
    this.apply(await this.api.login(credentials, remember));
    await this.refreshProfiles();
  }

  async signInWithProfile(id: string): Promise<void> {
    this.apply(await this.api.signInProfile(id));
  }

  async removeProfile(id: string): Promise<void> {
    await this.api.removeProfile(id);
    await this.refreshProfiles();
  }

  async signOut(): Promise<void> {
    await this.api.logout();
    this.account.set(null);
    this.profile.set(null);
  }

  private apply({ account, profile }: SignedIn): void {
    this.account.set(account);
    this.profile.set(profile);
    this.restoreError.set(null);
  }

  private async refreshProfiles(): Promise<void> {
    try {
      this.profiles.set(await this.api.listProfiles());
    } catch {
      this.profiles.set([]);
    }
  }
}

export function describeError(err: unknown): string {
  return typeof err === 'string' ? err : 'Could not reach the provider.';
}
