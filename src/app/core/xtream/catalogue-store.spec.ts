import { TestBed } from '@angular/core/testing';

import { CatalogueStore, inCategory } from './catalogue-store';
import { XtreamApi } from './xtream-api';
import { CatalogueSnapshot, LiveStream } from './xtream.models';

const channel = (id: number, category_id: string, category_ids?: number[]) =>
  ({ stream_id: id, name: `Channel ${id}`, category_id, category_ids }) as LiveStream;

const snapshot = (items: LiveStream[] | null, stale = false): CatalogueSnapshot<LiveStream> => ({
  updatedAt: 1_700_000_000,
  stale,
  items,
});

/** Lets pending invoke promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('CatalogueStore', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;

  function setup(): CatalogueStore {
    api = { catalogue: vi.fn(), refreshCatalogue: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: XtreamApi, useValue: api }] });
    return TestBed.inject(CatalogueStore);
  }

  it('shows a fresh cached list without refreshing it', async () => {
    const store = setup();
    api['catalogue'].mockResolvedValue(snapshot([channel(1, '5')]));

    const list = store.liveStreams.load();
    expect(list.isLoading()).toBe(true);
    await settle();

    expect(list.isLoading()).toBe(false);
    expect(list.value().map((c) => c.stream_id)).toEqual([1]);
    expect(list.updatedAt()).toEqual(new Date(1_700_000_000_000));
    expect(api['catalogue']).toHaveBeenCalledWith('live_streams');
    expect(api['refreshCatalogue']).not.toHaveBeenCalled();
  });

  it('shows a stale list at once, then swaps in the refreshed one', async () => {
    const store = setup();
    let resolve!: (s: CatalogueSnapshot<LiveStream>) => void;
    api['catalogue'].mockResolvedValue(snapshot([channel(1, '5')], true));
    api['refreshCatalogue'].mockReturnValue(new Promise((r) => (resolve = r)));

    const list = store.liveStreams.load();
    await settle();
    expect(list.value().length).toBe(1);
    expect(list.isRefreshing()).toBe(true);

    resolve(snapshot([channel(1, '5'), channel(2, '5')]));
    await settle();
    expect(list.value().length).toBe(2);
    expect(list.isRefreshing()).toBe(false);
  });

  it('keeps the list when a refresh finds no change or fails', async () => {
    const store = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    api['catalogue'].mockResolvedValue(snapshot([channel(1, '5')]));
    const list = store.liveStreams.load();
    await settle();
    const before = list.value();

    api['refreshCatalogue'].mockResolvedValue(snapshot(null));
    await list.refresh();
    expect(list.value()).toBe(before);

    api['refreshCatalogue'].mockRejectedValue('Network error');
    await list.refresh();
    expect(list.value()).toBe(before);
    expect(list.error()).toBeUndefined();
  });

  it('shares one download between concurrent refreshes', async () => {
    const store = setup();
    api['refreshCatalogue'].mockResolvedValue(snapshot(null));

    await Promise.all([store.movies.refresh(), store.movies.refresh()]);
    expect(api['refreshCatalogue']).toHaveBeenCalledTimes(1);
  });

  it('reports a failed first load and retries it on the next use', async () => {
    const store = setup();
    api['catalogue'].mockRejectedValueOnce('Network error');

    const list = store.liveStreams.load();
    await settle();
    expect(list.error()).toBe('Network error');

    api['catalogue'].mockResolvedValue(snapshot([channel(1, '5')]));
    list.load();
    await settle();
    expect(list.error()).toBeUndefined();
    expect(list.value().length).toBe(1);
  });

  it('drops replies for the previous account and reloads lists in use', async () => {
    const store = setup();
    let resolve!: (s: CatalogueSnapshot<LiveStream>) => void;
    api['catalogue'].mockReturnValueOnce(new Promise((r) => (resolve = r)));
    api['catalogue'].mockResolvedValue(snapshot([channel(9, '1')]));

    const list = store.liveStreams.load();
    store.reset();
    resolve(snapshot([channel(1, '5')]));
    await settle();

    expect(list.value().map((c) => c.stream_id)).toEqual([9]);
    expect(api['catalogue']).toHaveBeenCalledTimes(2);
    // Lists nobody used are not loaded for the new account.
    expect(api['catalogue']).not.toHaveBeenCalledWith('vod_streams');

    store.clear();
    expect(list.value()).toEqual([]);
    expect(list.isLoading()).toBe(false);
  });
});

describe('inCategory', () => {
  const list = [channel(1, '5'), channel(2, '6', [6, 7]), channel(3, '7')];

  it('matches the main category or any listed one', () => {
    expect(inCategory(list, '7').map((c) => c.stream_id)).toEqual([2, 3]);
    expect(inCategory(list, '5').map((c) => c.stream_id)).toEqual([1]);
  });

  it('keeps everything without a category', () => {
    expect(inCategory(list, undefined)).toBe(list);
  });
});
