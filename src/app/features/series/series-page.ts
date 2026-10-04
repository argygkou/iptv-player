import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import { XtreamApi } from '../../core/xtream/xtream-api';
import { CategoryList } from '../../shared/category-list';
import { PosterGrid, PosterItem } from '../../shared/poster-grid';
import { filterByName } from '../../shared/search';

@Component({
  selector: 'app-series-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CategoryList, PosterGrid],
  template: `
    <app-category-list
      [categories]="categories.hasValue() ? categories.value() : []"
      [selected]="category() ?? null"
      (selectedChange)="selectCategory($event)"
    />
    <section class="content">
      <div class="toolbar">
        <input
          type="search"
          placeholder="Search series"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
        />
        <span class="count">{{ items().length }} shows</span>
      </div>
      <div class="scroll">
        @if (series.isLoading()) {
          <p class="status">Loading series…</p>
        } @else if (series.error()) {
          <p class="status error">{{ series.error() }}</p>
        } @else {
          <app-poster-grid [items]="items()" />
        }
      </div>
    </section>
  `,
  styleUrl: '../../shared/catalogue-layout.scss',
})
export class SeriesPage {
  private readonly api = inject(XtreamApi);
  private readonly router = inject(Router);

  readonly category = input<string>();
  protected readonly search = signal('');

  protected readonly categories = resource({ loader: () => this.api.seriesCategories() });
  protected readonly series = resource({
    params: () => ({ categoryId: this.category() }),
    loader: ({ params }) => this.api.series(params.categoryId),
  });
  protected readonly items = computed<PosterItem[]>(() =>
    filterByName(this.series.hasValue() ? this.series.value() : [], this.search()).map((s) => ({
      id: String(s.series_id),
      name: s.name,
      image: s.cover,
      link: ['/series', String(s.series_id)],
    })),
  );

  protected selectCategory(categoryId: string | null): void {
    void this.router.navigate([], { queryParams: { category: categoryId } });
  }
}
