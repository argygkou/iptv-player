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

import { LibraryStore } from '../../core/library/library-store';
import { LibraryItem, watchedFraction } from '../../core/library/library.models';
import { XtreamApi } from '../../core/xtream/xtream-api';
import { CategoryList } from '../../shared/category-list';
import { PosterGrid, PosterItem } from '../../shared/poster-grid';
import { CONTINUE, FAVOURITES, isSavedList } from '../../shared/saved-lists';
import { filterByName } from '../../shared/search';

@Component({
  selector: 'app-movies-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CategoryList, PosterGrid],
  template: `
    <app-category-list
      [extras]="extras"
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
        @if (saved(); as saved) {
          <app-poster-grid [items]="saved" />
        } @else if (movies.isLoading()) {
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
  private readonly library = inject(LibraryStore);

  readonly category = input<string>();
  protected readonly search = signal('');
  protected readonly extras = [FAVOURITES, CONTINUE];

  protected readonly categories = resource({ loader: () => this.api.movieCategories() });
  /** Not needed for the saved lists, which the library already holds. */
  protected readonly movies = resource({
    params: () => (isSavedList(this.category()) ? undefined : { categoryId: this.category() }),
    loader: ({ params }) => this.api.movies(params.categoryId),
  });
  /** The favourites or continue-watching list, when one is selected. */
  protected readonly saved = computed(() => {
    const category = this.category();
    const items: LibraryItem[] | null =
      category === FAVOURITES.id
        ? this.library.favouritesOf('movie')
        : category === CONTINUE.id
          ? this.library.continueWatching().filter((w) => w.kind === 'movie')
          : null;
    return (
      items &&
      filterByName(items, this.search()).map((item) => this.poster(item.id, item.name, item.image))
    );
  });
  protected readonly items = computed<PosterItem[]>(
    () =>
      this.saved() ??
      filterByName(this.movies.hasValue() ? this.movies.value() : [], this.search()).map((m) =>
        this.poster(String(m.stream_id), m.name, m.stream_icon),
      ),
  );

  protected selectCategory(categoryId: string | null): void {
    void this.router.navigate([], { queryParams: { category: categoryId } });
  }

  private poster(id: string, name: string, image: string): PosterItem {
    return {
      id,
      name,
      image,
      link: ['/movies', id],
      progress: watchedFraction(this.library.watched('movie', id)),
    };
  }
}
