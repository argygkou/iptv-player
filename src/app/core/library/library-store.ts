import { computed, inject, Injectable, signal } from '@angular/core';

import { StreamKind } from '../xtream/xtream.models';
import { LibraryApi } from './library-api';
import {
  CategoryPrefs,
  EMPTY_LIBRARY,
  Favourite,
  Library,
  LibraryItem,
  LibraryKind,
  libraryKey,
  NO_CATEGORY_PREFS,
  Progress,
  resumePosition,
  Watched,
} from './library.models';

/**
 * Favourites and watch history of the signed-in account. The session loads it
 * on sign-in and clears it on sign-out; every change is saved by the backend,
 * which answers with the whole library.
 */
@Injectable({ providedIn: 'root' })
export class LibraryStore {
  private readonly api = inject(LibraryApi);
  private readonly data = signal<Library>(EMPTY_LIBRARY);
  /** Bumped on load and clear, so replies for a previous account are dropped. */
  private session = 0;

  readonly favourites = computed(() => this.data().favourites);
  readonly history = computed(() => this.data().history);

  private readonly favouriteKeys = computed(
    () => new Set(this.favourites().map((f) => libraryKey(f.kind, f.id))),
  );
  private readonly watchedByKey = computed(
    () => new Map(this.history().map((w) => [libraryKey(w.kind, w.id), w])),
  );

  /** Movies and episodes started but not finished, most recent first. */
  readonly continueWatching = computed(() =>
    this.history().filter((w) => w.kind !== 'live' && resumePosition(w) > 0),
  );
  readonly recentChannels = computed(() => this.history().filter((w) => w.kind === 'live'));

  favouritesOf(kind: LibraryKind): Favourite[] {
    return this.favourites().filter((f) => f.kind === kind);
  }

  isFavourite(kind: LibraryKind, id: string): boolean {
    return this.favouriteKeys().has(libraryKey(kind, id));
  }

  watched(kind: LibraryKind, id: string): Watched | undefined {
    return this.watchedByKey().get(libraryKey(kind, id));
  }

  categoryPrefs(catalogue: StreamKind): CategoryPrefs {
    return this.data().categories[catalogue] ?? NO_CATEGORY_PREFS;
  }

  /** Shown at once; the backend's reply (or a reload) settles it. */
  setCategoryPrefs(catalogue: StreamKind, prefs: CategoryPrefs): Promise<void> {
    this.data.update((library) => ({
      ...library,
      categories: { ...library.categories, [catalogue]: prefs },
    }));
    return this.apply(this.session, this.api.setCategories(catalogue, prefs));
  }

  async load(): Promise<void> {
    const session = ++this.session;
    this.data.set(EMPTY_LIBRARY);
    await this.apply(session, this.api.get());
  }

  clear(): void {
    this.session++;
    this.data.set(EMPTY_LIBRARY);
  }

  toggleFavourite(item: LibraryItem): Promise<void> {
    return this.apply(
      this.session,
      this.api.setFavourite(item, !this.isFavourite(item.kind, item.id)),
    );
  }

  /** Moves the item to the top of the history, saving how far it was watched. */
  record(item: LibraryItem, progress?: Progress): Promise<void> {
    return this.apply(this.session, this.api.record(item, progress));
  }

  forget(kind: LibraryKind, id: string): Promise<void> {
    return this.apply(this.session, this.api.forget(kind, id));
  }

  /** Library failures never break browsing or playback, so they are only logged. */
  private async apply(session: number, pending: Promise<Library>): Promise<void> {
    try {
      const library = await pending;
      if (session === this.session) {
        this.data.set(library);
      }
    } catch (err) {
      console.warn('Library update failed', err);
    }
  }
}
