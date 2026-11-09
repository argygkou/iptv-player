import { Component, computed, ElementRef, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LibraryStore } from '../../core/library/library-store';
import { LibraryItem, Watched, watchedFraction } from '../../core/library/library.models';
import { ClearHistory } from '../../shared/clear-history';
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
  /**
   * For history rows: what the row lists, which can be taken off one by one
   * or all at once. `null` for favourites.
   */
  history: readonly Watched[] | null;
}

/** The user's own lists: what to continue, favourites, and recent channels. */
@Component({
  selector: 'app-library-page',
  imports: [ClearHistory, RouterLink],
  templateUrl: './library-page.html',
  styleUrl: './library-page.scss',
})
export class LibraryPage {
  private readonly library = inject(LibraryStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly rows = computed<Row[]>(() => {
    const favourites = (title: string, kind: LibraryItem['kind']): Row => ({
      title,
      cards: this.library.favouritesOf(kind).map((item) => card(item)),
      history: null,
    });
    const history = (title: string, watched: Watched[]): Row => ({
      title,
      cards: watched.map((w) => card(w, w)),
      history: watched,
    });
    return [
      history('Continue watching', this.library.continueWatching()),
      favourites('Favourite channels', 'live'),
      favourites('Favourite movies', 'movie'),
      favourites('Favourite series', 'series'),
      history('Recently watched channels', this.library.recentChannels()),
    ].filter((row) => row.cards.length > 0);
  });

  protected forget(item: LibraryItem): void {
    void this.library.forget([item]);
  }

  /** A cleared row goes away, so focus moves to the page heading. */
  protected focusHeading(): void {
    this.host.nativeElement.querySelector('h1')?.focus();
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
