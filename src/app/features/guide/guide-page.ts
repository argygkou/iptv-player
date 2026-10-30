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

import { canCatchUp, isAiring } from '../../core/xtream/epg';
import { CatalogueStore, inCategory } from '../../core/xtream/catalogue-store';
import { TvGuide } from '../../core/xtream/tv-guide';
import { LiveStream, Programme } from '../../core/xtream/xtream.models';
import { Clock } from '../../shared/clock';

const MINUTE = 60_000;
const WINDOW_MINUTES = 6 * 60;
const PX_PER_MINUTE = 5;
/** Earlier / Later move the window by half its width. */
const STEP_HOURS = 3;
/** XMLTV exports rarely reach further than a week either way. */
const MAX_SHIFT_HOURS = 7 * 24;

export interface Block {
  left: number;
  width: number;
}

/** Positions a programme inside the visible window; `null` if it falls outside. */
export function layoutProgramme(programme: Programme, windowStart: Date): Block | null {
  const startMin = (programme.start.getTime() - windowStart.getTime()) / MINUTE;
  const endMin = (programme.end.getTime() - windowStart.getTime()) / MINUTE;
  const from = Math.max(0, startMin);
  const to = Math.min(WINDOW_MINUTES, endMin);
  return to > from ? { left: from * PX_PER_MINUTE, width: (to - from) * PX_PER_MINUTE } : null;
}

/** What clicking a programme does: watch the channel live, its recording, or nothing yet. */
export type ProgrammeAction = 'live' | 'catchup' | null;

export function programmeAction(
  stream: LiveStream,
  programme: Programme,
  now: Date,
): ProgrammeAction {
  if (canCatchUp(stream, programme, now)) {
    return isAiring(programme, now) ? 'live' : 'catchup';
  }
  return isAiring(programme, now) ? 'live' : null;
}

@Component({
  selector: 'app-guide-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  templateUrl: './guide-page.html',
  styleUrl: './guide-page.scss',
})
export class GuidePage {
  private readonly router = inject(Router);
  private readonly clock = inject(Clock);
  protected readonly tvGuide = inject(TvGuide);

  readonly category = input<string>();

  /** Hours the window is moved from now. */
  protected readonly shift = signal(0);
  protected readonly refreshing = signal(false);

  private readonly catalogue = inject(CatalogueStore);
  protected readonly categories = this.catalogue.liveCategories.load();
  private readonly allChannels = this.catalogue.liveStreams.load();
  protected readonly activeCategory = computed<string | undefined>(
    () => this.category() ?? this.categories.value()[0]?.category_id,
  );
  protected readonly channels = computed(() =>
    this.activeCategory() === undefined
      ? []
      : inCategory(this.allChannels.value(), this.activeCategory()),
  );
  protected readonly loadingChannels = this.allChannels.isLoading;
  protected readonly channelsError = this.allChannels.error;

  protected readonly timelineWidth = WINDOW_MINUTES * PX_PER_MINUTE;
  /** Starts at the previous half hour, minus 30 minutes of context, then shifted. */
  protected readonly windowStart = computed(
    () => {
      const start = new Date(this.clock.now());
      start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0);
      return new Date(start.getTime() - 30 * MINUTE + this.shift() * 60 * MINUTE);
    },
    // Only a new half hour moves the window; each clock tick must not reload the guide.
    { equal: (a, b) => a.getTime() === b.getTime() },
  );
  protected readonly windowEnd = computed(
    () => new Date(this.windowStart().getTime() + WINDOW_MINUTES * MINUTE),
  );

  protected readonly guide = resource({
    params: () =>
      this.channels().length
        ? {
            channels: this.channels(),
            from: this.windowStart(),
            to: this.windowEnd(),
            version: this.tvGuide.version(),
          }
        : undefined,
    loader: ({ params, abortSignal }) =>
      this.tvGuide.programmes(params.channels, params.from, params.to, abortSignal),
  });

  protected readonly ticks = computed(() =>
    Array.from({ length: WINDOW_MINUTES / 30 }, (_, i) => ({
      time: new Date(this.windowStart().getTime() + i * 30 * MINUTE),
      left: i * 30 * PX_PER_MINUTE,
    })),
  );
  protected readonly now = computed(() => this.clock.now().getTime());
  protected readonly nowOffset = computed(
    () => ((this.clock.now().getTime() - this.windowStart().getTime()) / MINUTE) * PX_PER_MINUTE,
  );
  protected readonly showsNow = computed(
    () => this.nowOffset() >= 0 && this.nowOffset() <= this.timelineWidth,
  );
  protected readonly canGoEarlier = computed(() => this.shift() > -MAX_SHIFT_HOURS);
  protected readonly canGoLater = computed(() => this.shift() < MAX_SHIFT_HOURS);

  protected programmes(
    stream: LiveStream,
  ): { programme: Programme; block: Block; action: ProgrammeAction }[] {
    const list = this.guide.hasValue()
      ? (this.guide.value().get(String(stream.stream_id)) ?? [])
      : [];
    const now = this.clock.now();
    return list.flatMap((programme) => {
      const block = layoutProgramme(programme, this.windowStart());
      return block ? [{ programme, block, action: programmeAction(stream, programme, now) }] : [];
    });
  }

  protected move(hours: number): void {
    this.shift.update((shift) =>
      Math.max(-MAX_SHIFT_HOURS, Math.min(MAX_SHIFT_HOURS, shift + hours)),
    );
  }

  protected readonly step = STEP_HOURS;

  protected async refresh(): Promise<void> {
    this.refreshing.set(true);
    try {
      await this.tvGuide.refresh();
    } finally {
      this.refreshing.set(false);
    }
  }

  protected selectCategory(categoryId: string): void {
    void this.router.navigate([], { queryParams: { category: categoryId } });
  }

  protected watch(stream: LiveStream): void {
    void this.router.navigate(['/live'], {
      queryParams: { category: stream.category_id, channel: String(stream.stream_id) },
    });
  }

  protected open(stream: LiveStream, programme: Programme, action: ProgrammeAction): void {
    if (action === 'live') {
      this.watch(stream);
    } else if (action === 'catchup') {
      void this.router.navigate(['/live'], {
        queryParams: {
          category: stream.category_id,
          channel: String(stream.stream_id),
          catchup: Math.floor(programme.start.getTime() / 1000),
          until: Math.floor(programme.end.getTime() / 1000),
        },
      });
    }
  }
}
