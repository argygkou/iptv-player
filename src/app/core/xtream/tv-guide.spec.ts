import { TestBed } from '@angular/core/testing';

import { TvGuide } from './tv-guide';
import { XtreamApi } from './xtream-api';
import { LiveStream, Programme } from './xtream.models';

const HOUR = 3_600_000;
const stream = (id: number, epg: string | null) =>
  ({ stream_id: id, epg_channel_id: epg, name: `Channel ${id}` }) as LiveStream;
const show = (title: string, fromNow: number, length = 1): Programme => ({
  title,
  description: '',
  start: new Date(Date.now() + fromNow * HOUR),
  end: new Date(Date.now() + (fromNow + length) * HOUR),
});

describe('TvGuide', () => {
  let api: { guide: ReturnType<typeof vi.fn>; shortEpg: ReturnType<typeof vi.fn> };

  function setup(): TvGuide {
    api = { guide: vi.fn(), shortEpg: vi.fn().mockResolvedValue([show('Short', -0.5)]) };
    TestBed.configureTestingModule({ providers: [{ provide: XtreamApi, useValue: api }] });
    return TestBed.inject(TvGuide);
  }

  it('uses the full guide and falls back to short EPG for channels it lacks', async () => {
    const tvGuide = setup();
    const updatedAt = new Date(1_000_000);
    api.guide.mockResolvedValue({
      updatedAt,
      programmes: new Map([['news.gr', [show('Full', -0.5)]]]),
    });

    const result = await tvGuide.programmes(
      [stream(1, 'news.gr'), stream(2, null), stream(3, 'missing')],
      new Date(Date.now() - HOUR),
      new Date(Date.now() + HOUR),
    );

    expect(api.guide.mock.calls[0][0]).toEqual(['news.gr', 'missing']);
    expect(result.get('1')?.[0].title).toBe('Full');
    expect(result.get('2')?.[0].title).toBe('Short');
    expect(result.get('3')?.[0].title).toBe('Short');
    expect(api.shortEpg).toHaveBeenCalledTimes(2);
    expect(tvGuide.updatedAt()).toBe(updatedAt);
  });

  it('only falls back for windows that include now', async () => {
    const tvGuide = setup();
    api.guide.mockRejectedValue('TV guide unavailable: 404');

    const result = await tvGuide.programmes(
      [stream(1, 'news.gr')],
      new Date(Date.now() - 6 * HOUR),
      new Date(Date.now() - 3 * HOUR),
    );

    expect(result.size).toBe(0);
    expect(api.shortEpg).not.toHaveBeenCalled();
    expect(tvGuide.error()).toBe('TV guide unavailable: 404');
  });

  it('reloads lists after a refresh', async () => {
    const tvGuide = setup();
    api.guide.mockResolvedValue({ updatedAt: new Date(), programmes: new Map() });

    await tvGuide.refresh();

    expect(api.guide.mock.calls[0][3]).toBe(true);
    expect(tvGuide.version()).toBe(1);
  });
});
