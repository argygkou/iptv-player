import { Programme } from '../../core/xtream/xtream.models';
import { layoutProgramme } from './guide-page';

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
