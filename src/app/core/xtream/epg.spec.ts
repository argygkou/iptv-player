import {
  archiveDays,
  canCatchUp,
  catchupMinutes,
  decodeBase64Utf8,
  isAiring,
  nowAndNext,
  panelTime,
  progress,
  toProgramme,
} from './epg';
import { LiveStream, Programme } from './xtream.models';

describe('epg', () => {
  it('finds what is on and what follows, whatever the order', () => {
    const at = (hour: number) => new Date(2026, 0, 1, hour);
    const programme = (title: string, start: number, end: number): Programme => ({
      title,
      description: '',
      start: at(start),
      end: at(end),
    });
    const [past, on, soon, later] = [
      programme('Past', 18, 19),
      programme('On', 19, 21),
      programme('Soon', 21, 22),
      programme('Later', 22, 23),
    ];
    expect(nowAndNext([later, on, past, soon], at(20))).toEqual({ current: on, next: soon });
    expect(nowAndNext([later, soon], at(20))).toEqual({ current: undefined, next: soon });
    expect(nowAndNext([past], at(20))).toEqual({ current: undefined, next: undefined });
  });

  it('decodes base64 UTF-8 titles', () => {
    // "Ειδήσεις" (Greek for "News")
    expect(decodeBase64Utf8('zpXOuc60zq7Pg861zrnPgg==')).toBe('Ειδήσεις');
  });

  it('returns the raw value when it is not base64', () => {
    expect(decodeBase64Utf8('Plain title!')).toBe('Plain title!');
    expect(decodeBase64Utf8(null)).toBe('');
  });

  it('maps listings to programmes with progress', () => {
    const programme = toProgramme({
      id: '1',
      epg_id: '1',
      channel_id: 'news.gr',
      title: btoa('News'),
      description: '',
      start_timestamp: '1000',
      stop_timestamp: '2000',
    });
    const midway = new Date(1500 * 1000);

    expect(programme.title).toBe('News');
    expect(isAiring(programme, midway)).toBe(true);
    expect(progress(programme, midway)).toBe(0.5);
    expect(progress(programme, new Date(3000 * 1000))).toBe(1);
  });

  describe('catch-up', () => {
    const HOUR = 3_600_000;
    const now = new Date(Date.UTC(2026, 9, 30, 20, 0));
    const stream = (tv_archive: number | string, tv_archive_duration?: number | string) =>
      ({ tv_archive, tv_archive_duration }) as LiveStream;
    const at = (hoursAgo: number, length = 1): Programme => ({
      title: 'Show',
      description: '',
      start: new Date(now.getTime() - hoursAgo * HOUR),
      end: new Date(now.getTime() - (hoursAgo - length) * HOUR),
    });

    it('reads the archive length, with a default when it is missing', () => {
      expect(archiveDays(stream(0, 7))).toBe(0);
      expect(archiveDays(stream('1', '5'))).toBe(5);
      expect(archiveDays(stream(1))).toBe(3);
    });

    it('allows programmes that started within the archive', () => {
      const archived = stream(1, 2);
      expect(canCatchUp(archived, at(3), now)).toBe(true);
      expect(canCatchUp(archived, at(0.5), now)).toBe(true);
      expect(canCatchUp(archived, at(49), now)).toBe(false);
      expect(canCatchUp(archived, at(-1), now)).toBe(false);
      expect(canCatchUp(stream(0), at(3), now)).toBe(false);
    });

    it('asks for whole minutes, at most a day', () => {
      expect(catchupMinutes(at(2, 1.01))).toBe(61);
      expect(catchupMinutes(at(30, 30))).toBe(24 * 60);
    });

    it("formats start times in the panel's time zone", () => {
      expect(panelTime(now, 'UTC')).toBe('2026-10-30:20-00');
      expect(panelTime(now, 'Europe/Athens')).toBe('2026-10-30:22-00');
      expect(panelTime(now, 'America/New_York')).toBe('2026-10-30:16-00');
      expect(panelTime(now, 'Not/AZone')).toBe('2026-10-30:20-00');
      expect(panelTime(now, undefined)).toBe('2026-10-30:20-00');
    });
  });
});
