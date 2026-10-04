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
  selector: 'app-movies-page',
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
          placeholder="Search movies"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
        />
        <span class="count">{{ items().length }} titles</span>
      </div>
      <div class="scroll">
        @if (movies.isLoading()) {
          <p class="status">Loading movies…</p>
        } @else if (movies.error()) {
          <p class="status error">{{ movies.error() }}</p>
        } @else {
          <app-poster-grid [items]="items()" />
        }
      </div>
    </section>
  `,
  styleUrl: '../../shared/catalogue-layout.scss',
})
export class MoviesPage {
  private readonly api = inject(XtreamApi);
  private readonly router = inject(Router);

  readonly category = input<string>();
  protected readonly search = signal('');

  protected readonly categories = resource({ loader: () => this.api.movieCategories() });
  protected readonly movies = resource({
    params: () => ({ categoryId: this.category() }),
    loader: ({ params }) => this.api.movies(params.categoryId),
  });
  protected readonly items = computed<PosterItem[]>(() =>
    filterByName(this.movies.hasValue() ? this.movies.value() : [], this.search()).map((m) => ({
      id: String(m.stream_id),
      name: m.name,
      image: m.stream_icon,
      link: ['/movies', String(m.stream_id)],
    })),
  );

  protected selectCategory(categoryId: string | null): void {
    void this.router.navigate([], { queryParams: { category: categoryId } });
  }
}
