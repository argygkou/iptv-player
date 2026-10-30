import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  resource,
  signal,
  untracked,
} from '@angular/core';

import { LibraryStore } from '../../core/library/library-store';
import {
  isFinished,
  LibraryItem,
  resumePosition,
  watchedFraction,
} from '../../core/library/library.models';
import { XtreamApi } from '../../core/xtream/xtream-api';
import { Episode, SeriesInfo } from '../../core/xtream/xtream.models';
import { FavouriteButton } from '../../shared/favourite-button';
import { VideoPlayer } from '../../shared/player/video-player';

/** Normalises the `episodes` payload, which panels send as an object or an array. */
export function episodesBySeason(info: SeriesInfo): Map<string, Episode[]> {
  const entries = Array.isArray(info.episodes)
    ? info.episodes.map((list) => [String(list[0]?.season ?? ''), list] as const)
    : Object.entries(info.episodes);
  return new Map(
    entries
      .filter(([season, list]) => season !== '' && list.length > 0)
      .sort(([a], [b]) => Number(a) - Number(b)),
  );
}

/** An episode as the library stores it, named so it reads well in lists. */
export function episodeItem(seriesId: string, info: SeriesInfo, episode: Episode): LibraryItem {
  return {
    kind: 'episode',
    id: String(episode.id),
    name: `S${episode.season}E${episode.episode_num} · ${episode.title}`,
    image: episode.info?.movie_image || info.info.cover || '',
    seriesId,
    seriesName: info.info.name,
  };
}

interface Playing {
  episode: Episode;
  item: LibraryItem;
  url: string;
  start: number;
}

@Component({
  selector: 'app-series-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FavouriteButton, VideoPlayer],
  templateUrl: './series-detail-page.html',
  styleUrls: ['../movies/detail.scss', './series-detail-page.scss'],
})
export class SeriesDetailPage {
  private readonly api = inject(XtreamApi);
  private readonly library = inject(LibraryStore);
  protected readonly location = inject(Location);

  /** Route param. */
  readonly id = input.required<string>();
  /** Query param: an episode to play straight away, from the saved position. */
  readonly episode = input<string>();

  protected readonly details = resource({
    params: () => this.id(),
    loader: ({ params }) => this.api.seriesInfo(params),
  });
  protected readonly seasons = computed(() =>
    this.details.hasValue() ? episodesBySeason(this.details.value()) : new Map<string, Episode[]>(),
  );
  protected readonly seasonKeys = computed(() => [...this.seasons().keys()]);
  protected readonly season = linkedSignal(() => this.seasonKeys()[0] ?? null);
  protected readonly episodes = computed(() => this.seasons().get(this.season() ?? '') ?? []);

  protected readonly item = computed<LibraryItem | undefined>(() => {
    if (!this.details.hasValue()) {
      return undefined;
    }
    const { info } = this.details.value();
    return { kind: 'series', id: this.id(), name: info.name, image: info.cover ?? '' };
  });

  protected readonly playing = signal<Playing | null>(null);
  protected readonly playError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.episode();
      const seasons = this.seasons();
      const episode = [...seasons.values()].flat().find((e) => String(e.id) === id);
      if (episode) {
        untracked(() => {
          this.season.set(String(episode.season));
          void this.play(episode);
        });
      }
    });
  }

  /** Plays the episode from where it was left, or from the start. */
  protected async play(episode: Episode): Promise<void> {
    if (!this.details.hasValue()) {
      return;
    }
    try {
      const item = episodeItem(this.id(), this.details.value(), episode);
      const start = resumePosition(this.library.watched('episode', item.id));
      const url = await this.api.streamUrl('series', episode.id, episode.container_extension);
      this.playing.set({ episode, item, url, start });
    } catch (err) {
      this.playError.set(String(err));
    }
  }

  protected watched(episode: Episode): number | null {
    return watchedFraction(this.library.watched('episode', String(episode.id)));
  }

  protected finished(episode: Episode): boolean {
    const watched = this.library.watched('episode', String(episode.id));
    return watched !== undefined && isFinished(watched);
  }
}
