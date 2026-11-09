import { Component, computed, input, output } from '@angular/core';

import { describeFailure, StreamState } from './stream-retry';

/**
 * What a player shows while it reconnects a failed stream, and the failure
 * with a manual retry once it has given up. The live region stays in the page
 * so screen readers announce each new attempt.
 */
@Component({
  selector: 'app-stream-status',
  template: `
    <div class="retrying" role="status">
      @if (retrying(); as retrying) {
        <span class="spinner" aria-hidden="true"></span>
        <p>Reconnecting… attempt {{ retrying.attempt }} of {{ retrying.of }}</p>
        <button type="button" (click)="stop.emit()">Stop</button>
      }
    </div>
    @if (failure(); as failure) {
      <div class="failed" role="alert">
        <p>This stream could not be played ({{ failure }}).</p>
        <button type="button" (click)="retry.emit()">Try again</button>
      </div>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .retrying:empty {
      display: none;
    }
    .retrying,
    .failed {
      display: grid;
      justify-items: center;
      gap: 0.75rem;
      max-width: 32rem;
      padding: 1rem 1.25rem;
      border-radius: var(--radius);
      background: rgb(0 0 0 / 75%);
      text-align: center;
      pointer-events: auto;

      p {
        margin: 0;
      }
    }
    .retrying {
      color: var(--text);
    }
    .failed {
      color: var(--danger);
    }
    .spinner {
      width: 1.5rem;
      height: 1.5rem;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation-duration: 3s;
      }
    }
  `,
})
export class StreamStatus {
  readonly state = input.required<StreamState>();
  /** Stop retrying and show the failure. */
  readonly stop = output();
  /** Start over with a fresh set of attempts. */
  readonly retry = output();

  protected readonly retrying = computed(() => {
    const state = this.state();
    return state.kind === 'retrying' ? state : null;
  });
  protected readonly failure = computed(() => {
    const state = this.state();
    return state.kind === 'failed' ? describeFailure(state.failure) : null;
  });
}
