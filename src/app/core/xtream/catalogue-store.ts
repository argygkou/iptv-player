import { computed, inject, Injectable, signal } from '@angular/core';

import { XtreamApi } from './xtream-api';
import { CatalogueListName, Category, LiveStream, SeriesItem, VodStream } from './xtream.models';

const EMPTY: readonly never[] = [];

/**
 * One provider list, shown from the backend's cache at once and refreshed in
 * the background when the backend says it is stale, or on request.
 */
export class CachedList<T> {
  private readonly data = signal<T[] | undefined>(undefined);
  private readonly started = signal(false);
  private readonly failure = signal<string | undefined>(undefined);
  private readonly busy = signal(false);
  private readonly downloaded = signal<Date | undefined>(undefined);
  /** Bumped on reset, so replies for a previous account are dropped. */
  private generation = 0;
  private loading?: Promise<void>;
  private refreshing?: Promise<void>;

  /** Empty until the first load finishes. */
  readonly value = computed<readonly T[]>(() => this.data() ?? EMPTY);
  readonly isLoading = computed(
    () => this.started() && this.data() === undefined && this.failure() === undefined,
  );
  /** Only set when there is nothing cached to show; a failed refresh keeps the old list. */
  readonly error = this.failure.asReadonly();
  readonly isRefreshing = this.busy.asReadonly();
  readonly updatedAt = this.downloaded.asReadonly();

  constructor(
    private readonly name: CatalogueListName,
    private readonly api: XtreamApi,
  ) {}

  /** Starts the first load, or retries a failed one; otherwise does nothing. */
  load(): this {
    if (!this.loading && (!this.started() || this.failure() !== undefined)) {
      this.started.set(true);
      this.loading = this.fetch().finally(() => (this.loading = undefined));
    }
    return this;
  }

  /** Downloads the list again; concurrent calls share one download. */
  refresh(): Promise<void> {
    this.refreshing ??= this.download().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  /** Forgets the list. With `reload`, loads it again if it was in use. */
  reset(reload: boolean): void {
    this.generation++;
    this.loading = this.refreshing = undefined;
    this.data.set(undefined);
    this.failure.set(undefined);
    this.busy.set(false);
    this.downloaded.set(undefined);
    const used = this.started();
    this.started.set(false);
    if (reload && used) {
      this.load();
    }
  }

  private async fetch(): Promise<void> {
    const generation = this.generation;
    this.failure.set(undefined);
    try {
      const snapshot = await this.api.catalogue<T>(this.name);
      if (generation !== this.generation) {
        return;
      }
      this.data.set(snapshot.items ?? []);
      this.downloaded.set(new Date(snapshot.updatedAt * 1000));
      if (snapshot.stale) {
        void this.refresh();
      }
    } catch (err) {
      if (generation === this.generation) {
        this.failure.set(describe(err));
      }
    }
  }

  private async download(): Promise<void> {
    const generation = this.generation;
    this.busy.set(true);
    try {
      const snapshot = await this.api.refreshCatalogue<T>(this.name);
      if (generation !== this.generation) {
        return;
      }
      if (snapshot.items) {
        this.data.set(snapshot.items);
      }
      this.downloaded.set(new Date(snapshot.updatedAt * 1000));
      this.failure.set(undefined);
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (this.data() === undefined) {
        this.failure.set(describe(err));
      } else {
        console.warn(`Could not refresh ${this.name}, keeping the cached list`, err);
      }
    } finally {
      if (generation === this.generation) {
        this.busy.set(false);
      }
    }
  }
}

/**
 * The provider's categories, channels, movies and series of the signed-in
 * account. Lists load on first use; the session resets them when the account
 * changes.
 */
@Injectable({ providedIn: 'root' })
export class CatalogueStore {
  private readonly api = inject(XtreamApi);

  readonly liveCategories = this.list<Category>('live_categories');
  readonly liveStreams = this.list<LiveStream>('live_streams');
  readonly movieCategories = this.list<Category>('vod_categories');
  readonly movies = this.list<VodStream>('vod_streams');
  readonly seriesCategories = this.list<Category>('series_categories');
  readonly series = this.list<SeriesItem>('series');

  private get all(): CachedList<unknown>[] {
    return [
      this.liveCategories,
      this.liveStreams,
      this.movieCategories,
      this.movies,
      this.seriesCategories,
      this.series,
    ];
  }

  /** For a new account: lists in use load again from its cache. */
  reset(): void {
    this.all.forEach((list) => list.reset(true));
  }

  clear(): void {
    this.all.forEach((list) => list.reset(false));
  }

  private list<T>(name: CatalogueListName): CachedList<T> {
    return new CachedList<T>(name, this.api);
  }
}

/** The items of `list` in the category, or all of them without one. */
export function inCategory<T extends { category_id: string | null; category_ids?: number[] }>(
  list: readonly T[],
  categoryId: string | undefined,
): readonly T[] {
  if (categoryId === undefined) {
    return list;
  }
  return list.filter(
    (item) =>
      String(item.category_id) === categoryId ||
      (item.category_ids?.some((id) => String(id) === categoryId) ?? false),
  );
}

function describe(err: unknown): string {
  return typeof err === 'string' ? err : 'Could not reach the provider.';
}
