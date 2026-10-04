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

import { isAiring, progress } from '../../core/xtream/epg';
import { XtreamApi } from '../../core/xtream/xtream-api';
import { LiveStream, Programme } from '../../core/xtream/xtream.models';
import { CategoryList } from '../../shared/category-list';
import { Clock } from '../../shared/clock';
import { filterByName } from '../../shared/search';
import { VideoPlayer } from '../../shared/video-player';

@Component({
  selector: 'app-live-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CategoryList, VideoPlayer, DatePipe],
  templateUrl: './live-page.html',
  styleUrls: ['../../shared/catalogue-layout.scss', './live-page.scss'],
})
export class LivePage {
  private readonly api = inject(XtreamApi);
  private readonly router = inject(Router);
  protected readonly clock = inject(Clock);

  /** Query params, bound through `withComponentInputBinding`. */
  readonly category = input<string>();
  readonly channel = input<string>();

  protected readonly search = signal('');

  protected readonly categories = resource({ loader: () => this.api.liveCategories() });
  protected readonly streams = resource({
    params: () => ({ categoryId: this.category() }),
    loader: ({ params }) => this.api.liveStreams(params.categoryId),
  });
  protected readonly visibleStreams = computed(() =>
    filterByName(this.streams.hasValue() ? this.streams.value() : [], this.search()),
  );
  protected readonly selected = computed(() => {
    const id = this.channel();
    return this.streams.hasValue()
      ? this.streams.value().find((s) => String(s.stream_id) === id)
      : undefined;
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
}
