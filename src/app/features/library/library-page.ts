import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LibraryStore } from '../../core/library/library-store';
import { LibraryItem, Watched, watchedFraction } from '../../core/library/library.models';
import { FAVOURITES, RECENT } from '../../shared/saved-lists';

/** Where an item opens: its detail page, or the channel on the Live TV page. */
export interface Destination {
  link: string[];
  queryParams?: Record<string, string>;
}

/** `fromHistory` resumes movies, and opens channels in the recent list rather than the favourites. */
export function destination(item: LibraryItem, fromHistory = false): Destination {
  switch (item.kind) {
    case 'live': {
      const category = fromHistory ? RECENT.id : FAVOURITES.id;
      return { link: ['/live'], queryParams: { category, channel: item.id } };
    }
    case 'movie':
      return { link: ['/movies', item.id], queryParams: fromHistory ? { play: '' } : undefined };
    case 'series':
      return { link: ['/series', item.id] };
    case 'episode':
      return { link: ['/series', item.seriesId ?? ''], queryParams: { episode: item.id } };
  }
}

interface Card {
  key: string;
  item: LibraryItem;
  title: string;
  subtitle?: string;
  to: Destination;
  progress?: number | null;
  /** Shown 16:9 rather than as a poster. */
  wide: boolean;
  /** A channel logo, shown whole rather than cropped. */
  logo: boolean;
}

interface Row {
  title: string;
  cards: Card[];
  /** Whether cards can be taken off the row (history rows). */
  removable: boolean;
}

/** The user's own lists: what to continue, favourites, and recent channels. */
@Component({
  selector: 'app-library-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './library-page.html',
  styleUrl: './library-page.scss',
})
export class LibraryPage {
  private readonly library = inject(LibraryStore);

  protected readonly rows = computed<Row[]>(() => {
    const favourites = (kind: LibraryItem['kind']) =>
      this.library.favouritesOf(kind).map((item) => card(item));
    return [
      {
        title: 'Continue watching',
        cards: this.library.continueWatching().map((w) => card(w, w)),
        removable: true,
      },
      { title: 'Favourite channels', cards: favourites('live'), removable: false },
      { title: 'Favourite movies', cards: favourites('movie'), removable: false },
      { title: 'Favourite series', cards: favourites('series'), removable: false },
      {
        title: 'Recently watched channels',
        cards: this.library.recentChannels().map((w) => card(w, w)),
        removable: true,
      },
    ].filter((row) => row.cards.length > 0);
  });

  protected forget(item: LibraryItem): void {
    void this.library.forget(item.kind, item.id);
  }
}

function card(item: LibraryItem, watched?: Watched): Card {
  return {
    key: `${item.kind}:${item.id}`,
    item,
    title: item.kind === 'episode' ? (item.seriesName ?? item.name) : item.name,
    subtitle: item.kind === 'episode' ? item.name : undefined,
    to: destination(item, watched !== undefined),
    progress: watchedFraction(watched),
    wide: item.kind === 'live' || item.kind === 'episode' || watched !== undefined,
    logo: item.kind === 'live',
  };
}
