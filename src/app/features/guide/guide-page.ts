import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
} from '@angular/core';
import { Router } from '@angular/router';

import { XtreamApi } from '../../core/xtream/xtream-api';
import { LiveStream, Programme } from '../../core/xtream/xtream.models';
import { Clock } from '../../shared/clock';
import { mapWithConcurrency } from '../../shared/concurrency';

const MINUTE = 60_000;
const WINDOW_MINUTES = 6 * 60;
const PX_PER_MINUTE = 5;
/** Short EPG is fetched per channel, so the grid caps how many rows it loads. */
const MAX_CHANNELS = 60;
const EPG_CONCURRENCY = 6;

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

@Component({
  selector: 'app-guide-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  templateUrl: './guide-page.html',
  styleUrl: './guide-page.scss',
})
export class GuidePage {
  private readonly api = inject(XtreamApi);
  private readonly router = inject(Router);
  private readonly clock = inject(Clock);

  readonly category = input<string>();

  protected readonly categories = resource({ loader: () => this.api.liveCategories() });
  protected readonly activeCategory = computed(
    () =>
      this.category() ??
      (this.categories.hasValue() ? this.categories.value()[0]?.category_id : undefined),
  );
  protected readonly channels = resource({
    params: () => this.activeCategory(),
    loader: async ({ params }) => (await this.api.liveStreams(params)).slice(0, MAX_CHANNELS),
  });
  protected readonly guide = resource({
    params: () => (this.channels.hasValue() ? this.channels.value() : undefined),
    loader: async ({ params, abortSignal }) => {
      const lists = await mapWithConcurrency(
        params,
        EPG_CONCURRENCY,
        (stream) => this.api.shortEpg(stream.stream_id, 12).catch(() => [] as Programme[]),
        abortSignal,
      );
      return new Map(params.map((stream, i) => [String(stream.stream_id), lists[i] ?? []]));
    },
  });

  protected readonly timelineWidth = WINDOW_MINUTES * PX_PER_MINUTE;
  /** Starts at the previous half hour, minus 30 minutes of context. */
  protected readonly windowStart = computed(() => {
    const start = new Date(this.clock.now());
    start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0);
    return new Date(start.getTime() - 30 * MINUTE);
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

  protected programmes(stream: LiveStream): { programme: Programme; block: Block }[] {
    const list = this.guide.hasValue()
      ? (this.guide.value().get(String(stream.stream_id)) ?? [])
      : [];
    return list.flatMap((programme) => {
      const block = layoutProgramme(programme, this.windowStart());
      return block ? [{ programme, block }] : [];
    });
  }

  protected selectCategory(categoryId: string): void {
    void this.router.navigate([], { queryParams: { category: categoryId } });
  }

  protected watch(stream: LiveStream): void {
    void this.router.navigate(['/live'], {
      queryParams: { category: stream.category_id, channel: String(stream.stream_id) },
    });
  }
}
