import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  resource,
  signal,
} from '@angular/core';

import { XtreamApi } from '../../core/xtream/xtream-api';
import { Episode, SeriesInfo } from '../../core/xtream/xtream.models';
import { VideoPlayer } from '../../shared/video-player';

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

@Component({
  selector: 'app-series-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VideoPlayer],
  templateUrl: './series-detail-page.html',
  styleUrls: ['../movies/detail.scss', './series-detail-page.scss'],
})
export class SeriesDetailPage {
  private readonly api = inject(XtreamApi);
  protected readonly location = inject(Location);

  /** Route param. */
  readonly id = input.required<string>();

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

  protected readonly playing = signal<{ episode: Episode; url: string } | null>(null);
  protected readonly playError = signal<string | null>(null);

  protected async play(episode: Episode): Promise<void> {
    try {
      const url = await this.api.streamUrl('series', episode.id, episode.container_extension);
      this.playing.set({ episode, url });
    } catch (err) {
      this.playError.set(String(err));
    }
  }
}
