import { TestBed } from '@angular/core/testing';

import { LibraryApi } from './library-api';
import { LibraryStore } from './library-store';
import { Library, LibraryItem, resumePosition, Watched, watchedFraction } from './library.models';

const movie: LibraryItem = { kind: 'movie', id: '7', name: 'Heat', image: '' };
const channel: LibraryItem = { kind: 'live', id: '7', name: 'News', image: '' };

const watched = (item: LibraryItem, position: number, duration: number): Watched => ({
  ...item,
  watchedAt: 1,
  position,
  duration,
});

describe('LibraryStore', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;

  function setup(library: Library): LibraryStore {
    api = {
      get: vi.fn().mockResolvedValue(library),
      setFavourite: vi.fn().mockResolvedValue(library),
      record: vi.fn().mockResolvedValue(library),
    };
    TestBed.configureTestingModule({ providers: [{ provide: LibraryApi, useValue: api }] });
    return TestBed.inject(LibraryStore);
  }

  it('tells favourites apart by kind', async () => {
    const store = setup({ favourites: [{ ...channel, addedAt: 1 }], history: [], categories: {} });
    await store.load();

    expect(store.isFavourite('live', '7')).toBe(true);
    expect(store.isFavourite('movie', '7')).toBe(false);

    await store.toggleFavourite(channel);
    expect(api['setFavourite']).toHaveBeenCalledWith(channel, false);
  });

  it('lists unfinished movies and episodes to continue', async () => {
    const store = setup({
      favourites: [],
      history: [
        watched(channel, 0, 0),
        watched(movie, 1200, 6000),
        watched({ ...movie, id: '8' }, 5950, 6000),
        watched({ ...movie, id: '9' }, 10, 6000),
      ],
      categories: {},
    });
    await store.load();

    expect(store.continueWatching().map((w) => w.id)).toEqual(['7']);
    expect(store.recentChannels().map((w) => w.kind)).toEqual(['live']);
  });

  it('drops replies meant for the previous account', async () => {
    let resolve!: (library: Library) => void;
    const store = setup({ favourites: [], history: [], categories: {} });
    api['record'].mockReturnValue(new Promise<Library>((r) => (resolve = r)));
    await store.load();

    const pending = store.record(movie);
    store.clear();
    resolve({ favourites: [{ ...movie, addedAt: 1 }], history: [], categories: {} });
    await pending;

    expect(store.favourites()).toEqual([]);
  });

  it('keeps a category save on screen while earlier replies arrive', async () => {
    const empty: Library = { favourites: [], history: [], categories: {} };
    const store = setup(empty);
    await store.load();
    const prefs = { pinned: ['3'], hidden: [], hiddenGroups: [] };
    let resolveRecord!: (library: Library) => void;
    api['record'].mockReturnValue(new Promise<Library>((r) => (resolveRecord = r)));
    api['setCategories'] = vi.fn().mockResolvedValue({ ...empty, categories: { live: prefs } });

    const recording = store.record(channel);
    const saving = store.setCategoryPrefs('live', prefs);
    // The history reply was made before the save, so it has no categories.
    resolveRecord({ ...empty, history: [watched(channel, 0, 0)] });
    await recording;
    expect(store.categoryPrefs('live')).toEqual(prefs);

    await saving;
    expect(api['setCategories']).toHaveBeenCalledAfter(api['record']);
    expect(store.categoryPrefs('live')).toEqual(prefs);
    expect(store.recentChannels().length).toBe(0);
  });

  it('gives the same category prefs while only the history changes', async () => {
    const prefs = { pinned: [], hidden: ['1'], hiddenGroups: [] };
    const store = setup({ favourites: [], history: [], categories: { live: prefs } });
    await store.load();
    const before = store.categoryPrefs('live');
    api['record'].mockResolvedValue({
      favourites: [],
      history: [watched(channel, 0, 0)],
      categories: { live: { ...prefs } },
    });
    await store.record(channel);

    expect(store.recentChannels().length).toBe(1);
    expect(store.categoryPrefs('live')).toBe(before);
  });

  it('keeps working when the backend fails', async () => {
    const store = setup({ favourites: [], history: [], categories: {} });
    api['get'].mockRejectedValue('Not signed in');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(store.load()).resolves.toBeUndefined();
    expect(store.history()).toEqual([]);
  });
});

describe('resume positions', () => {
  it('skips the first seconds and the credits', () => {
    expect(resumePosition(watched(movie, 10, 6000))).toBe(0);
    expect(resumePosition(watched(movie, 600, 6000))).toBe(600);
    expect(resumePosition(watched(movie, 5930, 6000))).toBe(0);
    // Unknown length: resume wherever it was.
    expect(resumePosition(watched(movie, 600, 0))).toBe(600);
  });

  it('counts finished items as fully watched', () => {
    expect(watchedFraction(watched(movie, 3000, 6000))).toBe(0.5);
    expect(watchedFraction(watched(movie, 5950, 6000))).toBe(1);
    expect(watchedFraction(watched(movie, 100, 0))).toBeNull();
  });
});
