import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';

import { describeError, SessionStore } from '../../core/session/session-store';
import { Profile } from '../../core/xtream/xtream.models';

@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  templateUrl: './login-page.html',
  styleUrl: './login-page.scss',
})
export class LoginPage {
  protected readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  protected readonly form = inject(NonNullableFormBuilder).group({
    server: ['', Validators.required],
    username: ['', Validators.required],
    password: ['', Validators.required],
    remember: [true],
  });
  protected readonly pending = signal(false);
  protected readonly error = signal<string | null>(this.session.restoreError());
  /** Show the form straight away only when there is no saved account to pick. */
  protected readonly showForm = signal(this.session.profiles().length === 0);

  protected submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return Promise.resolve();
    }
    const { remember, ...credentials } = this.form.getRawValue();
    return this.run(() => this.session.signIn(credentials, remember));
  }

  protected continueAs(profile: Profile): Promise<void> {
    return this.run(() => this.session.signInWithProfile(profile.id));
  }

  protected async remove(profile: Profile): Promise<void> {
    await this.session.removeProfile(profile.id);
    if (this.session.profiles().length === 0) {
      this.showForm.set(true);
    }
  }

  private async run(signIn: () => Promise<void>): Promise<void> {
    if (this.pending()) {
      return;
    }
    this.pending.set(true);
    this.error.set(null);
    try {
      await signIn();
      await this.router.navigateByUrl('/live');
    } catch (err) {
      this.error.set(describeError(err));
    } finally {
      this.pending.set(false);
    }
  }
}
