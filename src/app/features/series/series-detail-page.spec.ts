import { Episode, SeriesInfo } from '../../core/xtream/xtream.models';
import { episodesBySeason } from './series-detail-page';

const episode = (season: number, num: number): Episode => ({
  id: `${season}${num}`,
  episode_num: num,
  season,
  title: `Episode ${num}`,
  container_extension: 'mp4',
});

describe('episodesBySeason', () => {
  it('sorts seasons numerically when keyed by object', () => {
    const info = {
      episodes: { '10': [episode(10, 1)], '2': [episode(2, 1)] },
    } as unknown as SeriesInfo;
    expect([...episodesBySeason(info).keys()]).toEqual(['2', '10']);
  });

  it('accepts the array form some panels send', () => {
    const info = { episodes: [[episode(1, 1), episode(1, 2)], []] } as unknown as SeriesInfo;
    const seasons = episodesBySeason(info);
    expect([...seasons.keys()]).toEqual(['1']);
    expect(seasons.get('1')).toHaveLength(2);
  });
});
