import { DestroyRef, inject, Injectable, signal } from '@angular/core';

/** App-wide "now", refreshed every 30 seconds for EPG progress bars. */
@Injectable({ providedIn: 'root' })
export class Clock {
  private readonly current = signal(new Date());
  readonly now = this.current.asReadonly();

  constructor() {
    const timer = setInterval(() => this.current.set(new Date()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
}
