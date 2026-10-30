import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';

import { LibraryStore } from '../../core/library/library-store';
import { watchedFraction } from '../../core/library/library.models';
import { CatalogueStore, inCategory } from '../../core/xtream/catalogue-store';
import { CatalogueRefresh } from '../../shared/catalogue-refresh';
import { hiddenCategoryIds, withoutHidden } from '../../shared/category-groups';
import { CategoryList } from '../../shared/category-list';
import { PosterGrid, PosterItem } from '../../shared/poster-grid';
import { CONTINUE, FAVOURITES, isSavedList } from '../../shared/saved-lists';
import { filterByName } from '../../shared/search';

@Component({
  selector: 'app-series-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CatalogueRefresh, CategoryList, PosterGrid],
  template: `
    <app-category-list
      kind="series"
      [extras]="extras"
      [categories]="categories.value()"
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
        <app-catalogue-refresh [lists]="lists" />
      </div>
      <div class="scroll">
        @if (saved(); as saved) {
          <app-poster-grid [items]="saved" />
        } @else if (series.isLoading()) {
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
  private readonly catalogue = inject(CatalogueStore);
  private readonly router = inject(Router);
  private readonly library = inject(LibraryStore);

  readonly category = input<string>();
  protected readonly search = signal('');
  protected readonly extras = [FAVOURITES, CONTINUE];

  protected readonly categories = this.catalogue.seriesCategories.load();
  protected readonly series = this.catalogue.series.load();
  protected readonly lists = [this.categories, this.series];
  /** "All" leaves out the categories the user hid. */
  private readonly listed = computed(() => {
    const category = this.category();
    if (isSavedList(category)) {
      return [];
    }
    const items = this.series.value();
    if (category !== undefined) {
      return inCategory(items, category);
    }
    const prefs = this.library.categoryPrefs('series');
    return withoutHidden(items, hiddenCategoryIds(this.categories.value(), prefs));
  });
  /** Favourite shows, or episodes to continue, when one of those lists is selected. */
  protected readonly saved = computed<PosterItem[] | null>(() => {
    switch (this.category()) {
      case FAVOURITES.id:
        return filterByName(this.library.favouritesOf('series'), this.search()).map((s) => ({
          id: s.id,
          name: s.name,
          image: s.image,
          link: ['/series', s.id],
        }));
      case CONTINUE.id:
        return filterByName(
          this.library.continueWatching().filter((w) => w.kind === 'episode' && w.seriesId),
          this.search(),
        ).map((episode) => ({
          id: episode.id,
          name: `${episode.seriesName ?? ''} · ${episode.name}`,
          image: episode.image,
          link: ['/series', episode.seriesId],
          queryParams: { episode: episode.id },
          progress: watchedFraction(episode),
        }));
      default:
        return null;
    }
  });
  protected readonly items = computed<PosterItem[]>(
    () =>
      this.saved() ??
      filterByName(this.listed(), this.search()).map((s) => ({
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
