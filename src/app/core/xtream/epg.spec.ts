import { decodeBase64Utf8, isAiring, progress, toProgramme } from './epg';

describe('epg', () => {
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
});
