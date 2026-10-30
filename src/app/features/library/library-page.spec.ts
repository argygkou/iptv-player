import { LibraryItem } from '../../core/library/library.models';
import { destination } from './library-page';

const item = (kind: LibraryItem['kind'], extra: Partial<LibraryItem> = {}): LibraryItem => ({
  kind,
  id: '5',
  name: 'Name',
  image: '',
  ...extra,
});

describe('destination', () => {
  it('opens channels in the list they were found in', () => {
    expect(destination(item('live'))).toEqual({
      link: ['/live'],
      queryParams: { category: 'favourites', channel: '5' },
    });
    expect(destination(item('live'), true).queryParams?.['category']).toBe('recent');
  });

  it('resumes movies from the history and episodes on their series page', () => {
    expect(destination(item('movie'), true)).toEqual({
      link: ['/movies', '5'],
      queryParams: { play: '' },
    });
    expect(destination(item('movie')).queryParams).toBeUndefined();
    expect(destination(item('episode', { seriesId: '9' }))).toEqual({
      link: ['/series', '9'],
      queryParams: { episode: '5' },
    });
  });
});
