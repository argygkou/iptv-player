import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  resource,
  signal,
  untracked,
} from '@angular/core';

import { LibraryStore } from '../../core/library/library-store';
import {
  formatTime,
  LibraryItem,
  resumePosition,
  watchedFraction,
} from '../../core/library/library.models';
import { XtreamApi } from '../../core/xtream/xtream-api';
import { VodInfo } from '../../core/xtream/xtream.models';
import { FavouriteButton } from '../../shared/favourite-button';
import { VideoPlayer } from '../../shared/player/video-player';

@Component({
  selector: 'app-movie-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FavouriteButton, VideoPlayer],
  template: `
    <button type="button" class="back" (click)="location.back()">← Back</button>
    @if (details.hasValue()) {
      @let movie = details.value();
      @if (playing(); as playing) {
        <app-video-player [src]="playing.url" [item]="item()" [start]="playing.start" />
      } @else {
        <div class="hero" [style.background-image]="backdrop(movie)">
          @if (movie.info.movie_image) {
            <img class="cover" [src]="movie.info.movie_image" alt="" />
          }
          <div class="meta">
            <h1>{{ movie.movie_data.name }}</h1>
            <p class="facts">
              {{ movie.info.releasedate }} · {{ movie.info.duration }} · {{ movie.info.genre }}
              @if (movie.info.rating) {
                · ★ {{ movie.info.rating }}
              }
            </p>
            <p>{{ movie.info.plot || movie.info.description }}</p>
            @if (movie.info.cast) {
              <p class="facts">Cast: {{ movie.info.cast }}</p>
            }
            @if (watched(); as fraction) {
              <progress class="watched" [value]="fraction" max="1"></progress>
            }
            <div class="actions">
              @if (resumeAt(); as at) {
                <button type="button" class="primary" (click)="play(movie, at)">
                  ▶ Resume from {{ formatTime(at) }}
                </button>
                <button type="button" (click)="play(movie, 0)">Start over</button>
              } @else {
                <button type="button" class="primary" (click)="play(movie, 0)">▶ Play</button>
              }
              @if (item(); as item) {
                <app-favourite-button [item]="item" [label]="true" />
              }
            </div>
            @if (playError(); as error) {
              <p class="error">{{ error }}</p>
            }
          </div>
        </div>
      }
    } @else if (details.error()) {
      <p class="error">{{ details.error() }}</p>
    } @else {
      <p class="status">Loading…</p>
    }
  `,
  styleUrl: './detail.scss',
})
export class MovieDetailPage {
  private readonly api = inject(XtreamApi);
  private readonly library = inject(LibraryStore);
  protected readonly location = inject(Location);
  protected readonly formatTime = formatTime;

  /** Route param. */
  readonly id = input.required<string>();
  /** Query param: start playing straight away, from the saved position. */
  readonly autoplay = input<string | undefined>(undefined, { alias: 'play' });

  protected readonly details = resource({
    params: () => this.id(),
    loader: ({ params }) => this.api.movieInfo(params),
  });
  protected readonly item = computed<LibraryItem | undefined>(() => {
    if (!this.details.hasValue()) {
      return undefined;
    }
    const { info, movie_data } = this.details.value();
    return {
      kind: 'movie',
      id: this.id(),
      name: movie_data.name,
      image: info.movie_image ?? '',
    };
  });
  private readonly progress = computed(() => this.library.watched('movie', this.id()));
  protected readonly resumeAt = computed(() => resumePosition(this.progress()));
  protected readonly watched = computed(() => watchedFraction(this.progress()));

  protected readonly playing = signal<{ url: string; start: number } | null>(null);
  protected readonly playError = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (this.autoplay() !== undefined && this.details.hasValue()) {
        const movie = this.details.value();
        untracked(() => void this.play(movie, this.resumeAt()));
      }
    });
  }

  protected async play(movie: VodInfo, start: number): Promise<void> {
    try {
      const { stream_id, container_extension } = movie.movie_data;
      const url = await this.api.streamUrl('movie', stream_id, container_extension);
      this.playing.set({ url, start });
    } catch (err) {
      this.playError.set(String(err));
    }
  }

  protected backdrop(movie: VodInfo): string | null {
    const url = movie.info.backdrop_path?.[0];
    return url ? `linear-gradient(90deg, var(--bg) 35%, transparent), url("${url}")` : null;
  }
}
