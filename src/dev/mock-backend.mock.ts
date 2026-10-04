/**
 * Fake Tauri backend for `npm run start:mock`: lets the UI run in a plain
 * browser with made-up channels, EPG, movies and series. Never bundled in
 * production builds.
 */
const SAMPLE_VIDEO = 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
const now = Math.floor(Date.now() / 1000);

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const art = (label: string, hue: number, ratio: [number, number] = [2, 3]) => {
  const [w, h] = [ratio[0] * 100, ratio[1] * 100];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 60% 45%)"/><stop offset="1" stop-color="hsl(${hue + 40} 60% 18%)"/>` +
    `</linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>` +
    `<text x="50%" y="50%" fill="white" font-family="sans-serif" font-size="${w / 9}" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const category = (id: string, name: string) => ({
  category_id: id,
  category_name: name,
  parent_id: 0,
});

const liveCategories = [
  category('1', 'Greece | News'),
  category('2', 'Greece | Entertainment'),
  category('3', 'UK | Sports'),
  category('4', 'Documentaries'),
];
const liveStreams = liveCategories.flatMap((c, ci) =>
  Array.from({ length: 12 }, (_, i) => ({
    num: ci * 12 + i,
    name: `${c.category_name.split('|').pop()!.trim()} ${i + 1} HD`,
    stream_id: 100 + ci * 12 + i,
    stream_icon: art(`CH${ci * 12 + i + 1}`, (ci * 70 + i * 9) % 360, [4, 3]),
    epg_channel_id: `ch${ci * 12 + i}`,
    category_id: c.category_id,
    tv_archive: 0,
  })),
);

const shows = [
  'Morning Briefing',
  'World Report',
  'Match Day Live',
  'Nature Uncovered',
  'Late Show',
  'Cooking Duel',
  'Film Night',
  'Tech Today',
];
const epg = (streamId: number, limit: number) => {
  const offset = (streamId % 6) * 600;
  return {
    epg_listings: Array.from({ length: limit }, (_, k) => {
      const start = now - 3600 + offset + k * 2700;
      const title = shows[(streamId + k) % shows.length];
      return {
        id: `${streamId}-${k}`,
        epg_id: '1',
        channel_id: `ch${streamId}`,
        title: b64(title),
        description: b64(`An episode of ${title}. Mock guide data.`),
        start_timestamp: String(start),
        stop_timestamp: String(start + 2700),
      };
    }),
  };
};

const movieCategories = [
  category('10', 'Action'),
  category('11', 'Comedy'),
  category('12', 'Drama'),
];
const movies = movieCategories.flatMap((c, ci) =>
  Array.from({ length: 40 }, (_, i) => ({
    num: i,
    name: `${c.category_name} Movie ${i + 1}`,
    stream_id: 1000 + ci * 100 + i,
    stream_icon: art(`${c.category_name} ${i + 1}`, (ci * 110 + i * 7) % 360),
    rating: (5 + (i % 5)).toFixed(1),
    category_id: c.category_id,
    container_extension: 'mp4',
    added: String(now),
  })),
);

const seriesCategories = [category('20', 'Crime'), category('21', 'Sci-Fi')];
const series = seriesCategories.flatMap((c, ci) =>
  Array.from({ length: 16 }, (_, i) => ({
    num: i,
    name: `${c.category_name} Series ${i + 1}`,
    series_id: 5000 + ci * 100 + i,
    cover: art(`${c.category_name} ${i + 1}`, (ci * 150 + i * 11) % 360),
    plot: 'A mock series used to preview the UI without a provider.',
    cast: 'Jane Doe, John Roe',
    director: 'A. Director',
    genre: c.category_name,
    releaseDate: '2024',
    rating: '8.1',
    backdrop_path: [],
    category_id: c.category_id,
  })),
);

const PROFILES_KEY = 'iptv.mock.profiles';
interface MockProfiles {
  activeProfileId: string | null;
  profiles: { id: string; name: string; server: string; username: string }[];
}
const loadProfiles = (): MockProfiles =>
  JSON.parse(localStorage.getItem(PROFILES_KEY) ?? 'null') ?? {
    activeProfileId: null,
    profiles: [],
  };
const saveProfiles = (data: MockProfiles) =>
  localStorage.setItem(PROFILES_KEY, JSON.stringify(data));

const account = (username: string) => ({
  user_info: {
    username,
    status: 'Active',
    exp_date: String(now + 86400 * 120),
    is_trial: '0',
    active_cons: '0',
    max_connections: '2',
    allowed_output_formats: ['ts', 'm3u8'],
  },
  server_info: { url: 'mock', port: '80', timezone: 'UTC', time_now: '' },
});

const signInSaved = (id: string) => {
  const data = loadProfiles();
  const profile = data.profiles.find((p) => p.id === id);
  if (!profile) {
    throw 'Unknown profile';
  }
  saveProfiles({ ...data, activeProfileId: id });
  return { account: account(profile.username), profile };
};

type Args = Record<string, any>;
const handlers: Record<string, (args: Args) => unknown> = {
  login: ({ server, username, remember }) => {
    const data = loadProfiles();
    if (!remember) {
      saveProfiles({ ...data, activeProfileId: null });
      return { account: account(username), profile: null };
    }
    let profile = data.profiles.find((p) => p.server === server && p.username === username);
    if (!profile) {
      profile = {
        id: Math.random().toString(16).slice(2),
        name: `${username}@${server}`,
        server,
        username,
      };
      data.profiles.push(profile);
    }
    saveProfiles({ ...data, activeProfileId: profile.id });
    return { account: account(username), profile };
  },
  restore_session: () => {
    const { activeProfileId } = loadProfiles();
    return activeProfileId ? signInSaved(activeProfileId) : null;
  },
  sign_in_profile: ({ id }) => signInSaved(id),
  list_profiles: () => loadProfiles().profiles,
  remove_profile: ({ id }) => {
    const data = loadProfiles();
    saveProfiles({
      activeProfileId: data.activeProfileId === id ? null : data.activeProfileId,
      profiles: data.profiles.filter((p) => p.id !== id),
    });
    return null;
  },
  logout: () => {
    saveProfiles({ ...loadProfiles(), activeProfileId: null });
    return null;
  },
  stream_url: () => SAMPLE_VIDEO,
  xtream: ({ action, query = {} }) => {
    const byCategory = <T extends { category_id: string }>(list: T[]) =>
      query.categoryId ? list.filter((item) => item.category_id === query.categoryId) : list;
    switch (action) {
      case 'get_live_categories':
        return liveCategories;
      case 'get_vod_categories':
        return movieCategories;
      case 'get_series_categories':
        return seriesCategories;
      case 'get_live_streams':
        return byCategory(liveStreams);
      case 'get_vod_streams':
        return byCategory(movies);
      case 'get_series':
        return byCategory(series);
      case 'get_short_epg':
        return epg(Number(query.streamId), query.limit ?? 4);
      case 'get_vod_info': {
        const movie = movies.find((m) => String(m.stream_id) === query.vodId)!;
        return {
          info: {
            movie_image: movie.stream_icon,
            plot: 'A mock movie used to preview the UI. Playback uses a public sample video.',
            cast: 'Jane Doe, John Roe',
            genre: 'Mock',
            releasedate: '2024-05-01',
            duration: '01:42:00',
            rating: movie.rating,
          },
          movie_data: { ...movie },
        };
      }
      case 'get_series_info': {
        const show = series.find((s) => String(s.series_id) === query.seriesId)!;
        const episodes = Object.fromEntries(
          [1, 2, 3].map((season) => [
            String(season),
            Array.from({ length: 8 }, (_, i) => ({
              id: Number(show.series_id) * 100 + season * 10 + i,
              episode_num: i + 1,
              title: `Episode ${i + 1}`,
              container_extension: 'mp4',
              season,
              info: {
                duration: '00:48:00',
                movie_image: art(`S${season}E${i + 1}`, (season * 60 + i * 15) % 360, [16, 9]),
              },
            })),
          ]),
        );
        return { info: show, seasons: [], episodes };
      }
      default:
        throw `Mock backend: unknown action ${action}`;
    }
  },
};

(window as any).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (cmd: string, args: Args = {}) => {
    const handler = handlers[cmd];
    if (!handler) {
      throw `Mock backend: unknown command ${cmd}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    return handler(args);
  },
};
console.info('[mock] Fake Tauri backend installed; sign in with any values.');
