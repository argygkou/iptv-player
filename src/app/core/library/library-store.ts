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
  /** Backend calls run one at a time, so their replies arrive in order. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Category saves not answered yet; replies to earlier calls must not undo them on screen. */
  private pendingCategorySaves = 0;

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

  /**
   * Unchanged by replies that only touch favourites or history, so lists
   * filtered by it do not recompute (and reset their scroll) during playback.
   */
  private readonly categories = computed(() => this.data().categories, {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  categoryPrefs(catalogue: StreamKind): CategoryPrefs {
    return this.categories()[catalogue] ?? NO_CATEGORY_PREFS;
  }

  /** Shown at once; the backend's reply settles it, or a reload after a failure. */
  async setCategoryPrefs(catalogue: StreamKind, prefs: CategoryPrefs): Promise<void> {
    this.data.update((library) => ({
      ...library,
      categories: { ...library.categories, [catalogue]: prefs },
    }));
    this.pendingCategorySaves++;
    try {
      await this.apply(this.session, () => this.api.setCategories(catalogue, prefs), true);
    } finally {
      this.pendingCategorySaves--;
    }
  }

  async load(): Promise<void> {
    const session = ++this.session;
    this.data.set(EMPTY_LIBRARY);
    await this.apply(session, () => this.api.get());
  }

  clear(): void {
    this.session++;
    this.data.set(EMPTY_LIBRARY);
  }

  toggleFavourite(item: LibraryItem): Promise<void> {
    const favourite = !this.isFavourite(item.kind, item.id);
    return this.apply(this.session, () => this.api.setFavourite(item, favourite));
  }

  /** Moves the item to the top of the history, saving how far it was watched. */
  record(item: LibraryItem, progress?: Progress): Promise<void> {
    return this.apply(this.session, () => this.api.record(item, progress));
  }

  forget(kind: LibraryKind, id: string): Promise<void> {
    return this.apply(this.session, () => this.api.forget(kind, id));
  }

  /**
   * Library failures never break browsing or playback, so they are only
   * logged; a failed optimistic change is undone by reloading.
   */
  private async apply(
    session: number,
    call: () => Promise<Library>,
    optimistic = false,
  ): Promise<void> {
    const run = this.queue.then(call);
    this.queue = run.catch(() => undefined);
    try {
      const library = await run;
      if (session !== this.session) {
        return;
      }
      // The last pending save's own reply has it; earlier replies would show the old one.
      const keep = this.pendingCategorySaves > (optimistic ? 1 : 0);
      this.data.set(keep ? { ...library, categories: this.data().categories } : library);
    } catch (err) {
      console.warn('Library update failed', err);
      if (optimistic && session === this.session) {
        void this.apply(session, () => this.api.get());
      }
    }
  }
}
