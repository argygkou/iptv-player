import { Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input, resource, signal } from '@angular/core';

import { XtreamApi } from '../../core/xtream/xtream-api';
import { VodInfo } from '../../core/xtream/xtream.models';
import { VideoPlayer } from '../../shared/video-player';

@Component({
  selector: 'app-movie-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VideoPlayer],
  template: `
    <button type="button" class="back" (click)="location.back()">← Back</button>
    @if (details.hasValue()) {
      @let movie = details.value();
      @if (playbackUrl(); as url) {
        <app-video-player [src]="url" />
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
            <button type="button" class="primary" (click)="play(movie)">▶ Play</button>
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
  protected readonly location = inject(Location);

  /** Route param. */
  readonly id = input.required<string>();

  protected readonly details = resource({
    params: () => this.id(),
    loader: ({ params }) => this.api.movieInfo(params),
  });
  protected readonly playbackUrl = signal<string | null>(null);
  protected readonly playError = signal<string | null>(null);

  protected async play(movie: VodInfo): Promise<void> {
    try {
      const { stream_id, container_extension } = movie.movie_data;
      this.playbackUrl.set(await this.api.streamUrl('movie', stream_id, container_extension));
    } catch (err) {
      this.playError.set(String(err));
    }
  }

  protected backdrop(movie: VodInfo): string | null {
    const url = movie.info.backdrop_path?.[0];
    return url ? `linear-gradient(90deg, var(--bg) 35%, transparent), url("${url}")` : null;
  }
}
