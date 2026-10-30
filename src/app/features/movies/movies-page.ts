import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';

import { LibraryStore } from '../../core/library/library-store';
import { LibraryItem, watchedFraction } from '../../core/library/library.models';
import { CatalogueStore, inCategory } from '../../core/xtream/catalogue-store';
import { CatalogueRefresh } from '../../shared/catalogue-refresh';
import { hiddenCategoryIds, withoutHidden } from '../../shared/category-groups';
import { CategoryList } from '../../shared/category-list';
import { PosterGrid, PosterItem } from '../../shared/poster-grid';
import { CONTINUE, FAVOURITES, isSavedList } from '../../shared/saved-lists';
import { filterByName } from '../../shared/search';

@Component({
  selector: 'app-movies-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CatalogueRefresh, CategoryList, PosterGrid],
  template: `
    <app-category-list
      kind="movie"
      [extras]="extras"
      [categories]="categories.value()"
      [selected]="category() ?? null"
      (selectedChange)="selectCategory($event)"
    >
      <app-catalogue-refresh [lists]="lists" />
    </app-category-list>
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
  private readonly catalogue = inject(CatalogueStore);
  private readonly router = inject(Router);
  private readonly library = inject(LibraryStore);

  readonly category = input<string>();
  protected readonly search = signal('');
  protected readonly extras = [FAVOURITES, CONTINUE];

  protected readonly categories = this.catalogue.movieCategories.load();
  protected readonly movies = this.catalogue.movies.load();
  protected readonly lists = [this.categories, this.movies];
  /** "All" leaves out the categories the user hid. */
  private readonly listed = computed(() => {
    const category = this.category();
    if (isSavedList(category)) {
      return [];
    }
    const items = this.movies.value();
    if (category !== undefined) {
      return inCategory(items, category);
    }
    const prefs = this.library.categoryPrefs('movie');
    return withoutHidden(items, hiddenCategoryIds(this.categories.value(), prefs));
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
      filterByName(this.listed(), this.search()).map((m) =>
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
