import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { CachedList } from '../core/xtream/catalogue-store';

/** Downloads the page's lists again; the title says how old they are. */
@Component({
  selector: 'app-catalogue-refresh',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <button
      type="button"
      [disabled]="refreshing()"
      [title]="updatedAt() ? 'Updated ' + (updatedAt() | date: 'EEE d MMM, HH:mm') : ''"
      (click)="refresh()"
    >
      {{ refreshing() ? 'Updating…' : 'Update list' }}
    </button>
  `,
  styles: `
    :host {
      margin-left: auto;
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
