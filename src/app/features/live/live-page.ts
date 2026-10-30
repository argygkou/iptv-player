import { DatePipe } from '@angular/common';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';

import { LibraryStore } from '../../core/library/library-store';
import { LibraryItem, libraryKey } from '../../core/library/library.models';
import { SessionStore } from '../../core/session/session-store';
import {
  archiveDays,
  canCatchUp,
  catchupMinutes,
  isAiring,
  panelTime,
  progress,
} from '../../core/xtream/epg';
import { TvGuide } from '../../core/xtream/tv-guide';
import { XtreamApi } from '../../core/xtream/xtream-api';
import { LiveStream, Programme } from '../../core/xtream/xtream.models';
import { CategoryList } from '../../shared/category-list';
import { FavouriteButton } from '../../shared/favourite-button';
import { Clock } from '../../shared/clock';
import { FAVOURITES, isSavedList, RECENT } from '../../shared/saved-lists';
import { filterByName } from '../../shared/search';
import { VideoPlayer } from '../../shared/player/video-player';

const HOUR = 60 * 60 * 1000;
/** How far back the programme list goes on a channel with catch-up. */
const CATCHUP_LIST_HOURS = 24;
const UPCOMING_HOURS = 12;

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
  private readonly session = inject(SessionStore);
  private readonly tvGuide = inject(TvGuide);
  protected readonly clock = inject(Clock);
  protected readonly library = inject(LibraryStore);

  /** Query params, bound through `withComponentInputBinding`. */
  readonly category = input<string>();
  readonly channel = input<string>();
  /** Catch-up: start and end of the recorded programme, in Unix seconds. */
  readonly catchup = input<string>();
  readonly until = input<string>();

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

  /** The recorded programme being watched instead of the live channel. */
  protected readonly recording = computed<Programme | undefined>(() => {
    const [start, end] = [Number(this.catchup()), Number(this.until())];
    if (!start || !end || end <= start) {
      return undefined;
    }
    const programme = this.epg.hasValue()
      ? this.epg.value().find((p) => p.start.getTime() === start * 1000)
      : undefined;
    return (
      programme ?? {
        title: 'Catch-up',
        description: '',
        start: new Date(start * 1000),
        end: new Date(end * 1000),
      }
    );
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
    params: () => {
      const channel = this.channel();
      const [start, end] = [Number(this.catchup()), Number(this.until())];
      if (!channel) {
        return undefined;
      }
      return {
        channel,
        catchup: start && end > start ? { start, end } : undefined,
        timeZone: this.session.account()?.server_info.timezone,
      };
    },
    loader: ({ params: { channel, catchup, timeZone } }) => {
      if (!catchup) {
        return this.api.streamUrl('live', channel, 'ts');
      }
      const programme = {
        title: '',
        description: '',
        start: new Date(catchup.start * 1000),
        end: new Date(catchup.end * 1000),
      };
      return this.api.catchupUrl(
        channel,
        panelTime(programme.start, timeZone),
        catchupMinutes(programme),
      );
    },
  });

  /**
   * The channel's programmes: from now (or from a day back with catch-up) to
   * 12 hours ahead. "Now" is read when the channel changes, not on every tick.
   */
  protected readonly epg = resource({
    params: () => {
      const stream = this.selected();
      return stream && { stream, version: this.tvGuide.version() };
    },
    loader: async ({ params: { stream }, abortSignal }) => {
      const now = Date.now();
      const back = archiveDays(stream) > 0 ? CATCHUP_LIST_HOURS : 0;
      const guide = await this.tvGuide.programmes(
        [stream],
        new Date(now - back * HOUR),
        new Date(now + UPCOMING_HOURS * HOUR),
        abortSignal,
      );
      return guide.get(String(stream.stream_id)) ?? [];
    },
  });
  /** Without catch-up, past programmes are of no use. */
  protected readonly programmes = computed(() => {
    const list = this.epg.hasValue() ? this.epg.value() : [];
    const stream = this.selected();
    const now = this.clock.now();
    return stream && archiveDays(stream) > 0 ? list : list.filter((p) => p.end > now);
  });

  private readonly epgList = viewChild<ElementRef<HTMLElement>>('epgList');

  protected readonly isAiring = (p: Programme) => isAiring(p, this.clock.now());
  protected readonly progress = (p: Programme) => progress(p, this.clock.now());
  protected readonly canCatchUp = (p: Programme) => {
    const stream = this.selected();
    return !!stream && canCatchUp(stream, p, this.clock.now());
  };
  protected readonly isPlaying = (p: Programme) =>
    this.recording()?.start.getTime() === p.start.getTime();

  constructor() {
    // Bring what is on (or the recording being watched) into view, past the archive above it.
    afterRenderEffect(() => {
      this.programmes();
      this.recording();
      const list = this.epgList()?.nativeElement;
      const current =
        list?.querySelector<HTMLElement>('.playing') ?? list?.querySelector<HTMLElement>('.airing');
      if (list && current) {
        list.scrollTop += current.getBoundingClientRect().top - list.getBoundingClientRect().top;
      }
    });
  }

  protected selectCategory(categoryId: string | null): void {
    void this.router.navigate([], {
      queryParams: { category: categoryId },
      queryParamsHandling: 'merge',
    });
  }

  protected selectChannel(stream: LiveStream): void {
    void this.router.navigate([], {
      queryParams: { channel: String(stream.stream_id), catchup: null, until: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Plays the programme's recording; the one on now starts over. */
  protected watchRecording(programme: Programme): void {
    void this.router.navigate([], {
      queryParams: {
        catchup: Math.floor(programme.start.getTime() / 1000),
        until: Math.floor(programme.end.getTime() / 1000),
      },
      queryParamsHandling: 'merge',
    });
  }

  protected backToLive(): void {
    void this.router.navigate([], {
      queryParams: { catchup: null, until: null },
      queryParamsHandling: 'merge',
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
