import { LiveStream, Programme } from '../../core/xtream/xtream.models';
import { layoutProgramme, programmeAction } from './guide-page';

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes));
const programme = (start: number, end: number): Programme => ({
  title: 'Show',
  description: '',
  start: at(start),
  end: at(end),
});

describe('layoutProgramme', () => {
  const windowStart = at(0);

  it('places programmes at 5px per minute', () => {
    expect(layoutProgramme(programme(30, 60), windowStart)).toEqual({ left: 150, width: 150 });
  });

  it('clips programmes that started before the window', () => {
    expect(layoutProgramme(programme(-30, 15), windowStart)).toEqual({ left: 0, width: 75 });
  });

  it('drops programmes outside the window', () => {
    expect(layoutProgramme(programme(-60, -10), windowStart)).toBeNull();
    expect(layoutProgramme(programme(400, 460), windowStart)).toBeNull();
  });
});

describe('programmeAction', () => {
  const now = at(100);
  const archived = { tv_archive: 1, tv_archive_duration: 1 } as LiveStream;
  const plain = { tv_archive: 0 } as LiveStream;

  it('plays the live channel for what is on now', () => {
    expect(programmeAction(plain, programme(90, 120), now)).toBe('live');
    expect(programmeAction(archived, programme(90, 120), now)).toBe('live');
  });

  it('plays recordings of past programmes on channels with catch-up', () => {
    expect(programmeAction(archived, programme(30, 60), now)).toBe('catchup');
    expect(programmeAction(plain, programme(30, 60), now)).toBeNull();
  });

  it('does nothing for programmes that have not started', () => {
    expect(programmeAction(archived, programme(120, 150), now)).toBeNull();
  });
});
