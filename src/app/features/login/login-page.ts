import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';

import { SessionStore } from '../../core/session/session-store';

@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  templateUrl: './login-page.html',
  styleUrl: './login-page.scss',
})
export class LoginPage {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly remembered = this.session.rememberedLogin();

  protected readonly form = inject(NonNullableFormBuilder).group({
    server: [this.remembered?.server ?? '', Validators.required],
    username: [this.remembered?.username ?? '', Validators.required],
    password: ['', Validators.required],
    remember: [this.remembered !== null],
  });
  protected readonly pending = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.form.invalid || this.pending()) {
      this.form.markAllAsTouched();
      return;
    }
    const { remember, ...credentials } = this.form.getRawValue();
    this.pending.set(true);
    this.error.set(null);
    try {
      await this.session.signIn(credentials, remember);
      await this.router.navigateByUrl('/live');
    } catch (err) {
      this.error.set(typeof err === 'string' ? err : 'Could not reach the provider.');
    } finally {
      this.pending.set(false);
    }
  }
}
