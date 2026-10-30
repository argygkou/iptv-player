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
import { watchedFraction } from '../../core/library/library.models';
import { XtreamApi } from '../../core/xtream/xtream-api';
import { CategoryList } from '../../shared/category-list';
import { PosterGrid, PosterItem } from '../../shared/poster-grid';
import { CONTINUE, FAVOURITES, isSavedList } from '../../shared/saved-lists';
import { filterByName } from '../../shared/search';

@Component({
  selector: 'app-series-page',
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
          placeholder="Search series"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
        />
        <span class="count">{{ items().length }} shows</span>
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
  private readonly api = inject(XtreamApi);
  private readonly router = inject(Router);
  private readonly library = inject(LibraryStore);

  readonly category = input<string>();
  protected readonly search = signal('');
  protected readonly extras = [FAVOURITES, CONTINUE];

  protected readonly categories = resource({ loader: () => this.api.seriesCategories() });
  /** Not needed for the saved lists, which the library already holds. */
  protected readonly series = resource({
    params: () => (isSavedList(this.category()) ? undefined : { categoryId: this.category() }),
    loader: ({ params }) => this.api.series(params.categoryId),
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
