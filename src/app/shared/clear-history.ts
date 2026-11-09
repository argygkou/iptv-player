import {
  afterNextRender,
  Component,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
} from '@angular/core';

import { LibraryStore } from '../core/library/library-store';
import { LibraryItem } from '../core/library/library.models';

/**
 * "Clear" for a history list (Continue watching, Recently watched), asking
 * first in place. Focus starts on Cancel so a stray Enter clears nothing.
 */
@Component({
  selector: 'app-clear-history',
  template: `
    @if (confirming()) {
      <span role="group" [attr.aria-label]="'Clear ' + list()" (keydown.escape)="cancel()">
        <span class="question">
          Remove {{ items().length }} {{ items().length === 1 ? 'item' : 'items' }}?
        </span>
        <button type="button" class="danger" (click)="clear()">Clear</button>
        <button type="button" class="cancel" (click)="cancel()">Cancel</button>
      </span>
    } @else {
      <button
        type="button"
        class="start"
        [disabled]="items().length === 0"
        [attr.aria-label]="'Clear ' + list()"
        (click)="ask()"
      >
        Clear
      </button>
    }
  `,
  styles: `
    :host,
    [role='group'] {
      display: inline-flex;
      align-items: baseline;
      gap: 0.75rem;
      font-size: 0.85rem;
    }
    .question {
      color: var(--text-muted);
    }
    button {
      padding: 0;
      border: 0;
      background: none;
      color: var(--text-muted);
      font-size: inherit;

      &:hover:not(:disabled) {
        background: none;
        color: var(--text);
      }
    }
    .start {
      color: var(--accent);
    }
    .danger {
      color: var(--danger);
    }
  `,
})
export class ClearHistory {
  private readonly library = inject(LibraryStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** What is cleared, as read out: "Clear Continue watching". */
  readonly list = input.required<string>();
  readonly items = input.required<readonly LibraryItem[]>();
  /** The list was cleared; the host decides where focus goes if this goes away. */
  readonly cleared = output();

  protected readonly confirming = signal(false);

  protected ask(): void {
    this.confirming.set(true);
    this.focusAfterRender('.cancel');
  }

  protected cancel(): void {
    this.confirming.set(false);
    this.focusAfterRender('.start');
  }

  protected clear(): void {
    this.confirming.set(false);
    void this.library.forget(this.items());
    this.cleared.emit();
  }

  private focusAfterRender(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}
