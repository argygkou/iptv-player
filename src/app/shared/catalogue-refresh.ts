import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { CachedList } from '../core/xtream/catalogue-store';

/**
 * Icon button that downloads the page's lists again, for the category list's
 * header. While any list refreshes, in the background or on request, the icon
 * spins and a bar runs along the bottom of the header.
 */
@Component({
  selector: 'app-catalogue-refresh',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <button
      type="button"
      class="refresh"
      [class.spinning]="refreshing()"
      [disabled]="refreshing()"
      [attr.aria-label]="refreshing() ? 'Updating lists' : 'Update lists'"
      [title]="
        refreshing()
          ? 'Updating lists…'
          : 'Update lists' +
            (updatedAt() ? ' (updated ' + (updatedAt() | date: 'EEE d MMM, HH:mm') + ')' : '')
      "
      (click)="refresh()"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 12a8 8 0 1 1-2.34-5.66" />
        <path d="M20 4v5h-5" />
      </svg>
    </button>
    @if (refreshing()) {
      <span class="bar" role="progressbar" aria-label="Updating lists"></span>
    }
  `,
  styles: `
    .refresh {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: none;
      color: var(--text-muted);
      cursor: pointer;

      &:hover:not(:disabled) {
        color: var(--text);
        background: var(--surface-hover);
      }

      &:disabled {
        cursor: default;
        color: var(--accent);
      }
    }
    svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .spinning svg {
      animation: spin 0.9s linear infinite;
    }
    /* Positioned against the category list's header. */
    .bar {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 2px;
      overflow: hidden;

      &::after {
        content: '';
        position: absolute;
        inset: 0 auto 0 0;
        width: 30%;
        background: var(--accent);
        animation: slide 1.2s ease-in-out infinite;
      }
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @keyframes slide {
      from {
        transform: translateX(-100%);
      }
      to {
        transform: translateX(340%);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .spinning svg,
      .bar::after {
        animation-duration: 3s;
      }
    }
  `,
})
export class CatalogueRefresh {
  readonly lists = input.required<readonly CachedList<unknown>[]>();

  protected readonly refreshing = computed(() => this.lists().some((l) => l.isRefreshing()));
  /** The oldest list, since that is what the button would bring up to date. */
  protected readonly updatedAt = computed(() => {
    const times = this.lists()
      .map((l) => l.updatedAt()?.getTime())
      .filter((t) => t !== undefined);
    return times.length ? new Date(Math.min(...times)) : undefined;
  });

  protected refresh(): void {
    for (const list of this.lists()) {
      void list.refresh();
    }
  }
}
