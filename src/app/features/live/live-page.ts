import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import { LibraryStore } from '../../core/library/library-store';
import { LibraryItem, libraryKey } from '../../core/library/library.models';
import { isAiring, progress } from '../../core/xtream/epg';
import { XtreamApi } from '../../core/xtream/xtream-api';
import { LiveStream, Programme } from '../../core/xtream/xtream.models';
import { CategoryList } from '../../shared/category-list';
import { FavouriteButton } from '../../shared/favourite-button';
import { Clock } from '../../shared/clock';
import { FAVOURITES, isSavedList, RECENT } from '../../shared/saved-lists';
import { filterByName } from '../../shared/search';
import { VideoPlayer } from '../../shared/player/video-player';

@Component({
  selector: 'app-live-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CategoryList, FavouriteButton, VideoPlayer, DatePipe],
  templateUrl: './live-page.html',
  styleUrls: ['../../shared/catalogue-layout.scss', './live-page.scss'],
})
export class LivePage {
  private readonly api = inject(XtreamApi);
  private readonly router = inject(Router);
  protected readonly clock = inject(Clock);
  protected readonly library = inject(LibraryStore);

  /** Query params, bound through `withComponentInputBinding`. */
  readonly category = input<string>();
  readonly channel = input<string>();

  protected readonly search = signal('');
  protected readonly extras = [FAVOURITES, RECENT];
  protected readonly favouritesId = FAVOURITES.id;

  protected readonly categories = resource({ loader: () => this.api.liveCategories() });
  /** The favourites and recent lists pick from all channels. */
  protected readonly streams = resource({
    params: () => ({ categoryId: isSavedList(this.category()) ? undefined : this.category() }),
    loader: ({ params }) => this.api.liveStreams(params.categoryId),
  });
  private readonly listed = computed(() => {
    const streams = this.streams.hasValue() ? this.streams.value() : [];
    const category = this.category();
    if (category === FAVOURITES.id) {
      return pick(streams, this.library.favouritesOf('live'));
    }
    if (category === RECENT.id) {
      return pick(streams, this.library.recentChannels());
    }
    return streams;
  });
  protected readonly visibleStreams = computed(() => filterByName(this.listed(), this.search()));
  protected readonly selected = computed(() => {
    const id = this.channel();
    return this.streams.hasValue()
      ? this.streams.value().find((s) => String(s.stream_id) === id)
      : undefined;
  });

  /** The selected channel as the library stores it. */
  protected readonly item = computed<LibraryItem | undefined>(() => {
    const stream = this.selected();
    return (
      stream && {
        kind: 'live',
        id: String(stream.stream_id),
        name: stream.name,
        image: stream.stream_icon ?? '',
      }
    );
  });

  protected readonly playback = resource({
    params: () => this.channel(),
    loader: ({ params }) => this.api.streamUrl('live', params, 'ts'),
  });
  protected readonly epg = resource({
    params: () => this.channel(),
    loader: ({ params }) => this.api.shortEpg(params, 6),
  });

  protected readonly isAiring = (p: Programme) => isAiring(p, this.clock.now());
  protected readonly progress = (p: Programme) => progress(p, this.clock.now());

  protected selectCategory(categoryId: string | null): void {
    void this.router.navigate([], {
      queryParams: { category: categoryId },
      queryParamsHandling: 'merge',
    });
  }

  protected selectChannel(stream: LiveStream): void {
    void this.router.navigate([], {
      queryParams: { channel: String(stream.stream_id) },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected channelId(stream: LiveStream): string {
    return String(stream.stream_id);
  }

  protected isFavourite(stream: LiveStream): boolean {
    return this.library.isFavourite('live', String(stream.stream_id));
  }
}

/** The channels in `items`, in the order of `items`. */
function pick(streams: LiveStream[], items: LibraryItem[]): LiveStream[] {
  const byId = new Map(streams.map((s) => [libraryKey('live', String(s.stream_id)), s]));
  return items.flatMap((item) => byId.get(libraryKey('live', item.id)) ?? []);
}
