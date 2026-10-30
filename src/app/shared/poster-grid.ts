import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { InView } from './in-view';

export interface PosterItem {
  id: string;
  name: string;
  image: string;
  link: unknown[];
  queryParams?: Record<string, string>;
  /** How much was watched, 0 to 1. */
  progress?: number | null;
}

const PAGE_SIZE = 120;

/** Poster grid that renders in pages as the user scrolls, for catalogues with thousands of titles. */
@Component({
  selector: 'app-poster-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, InView],
  template: `
    <div class="grid">
      @for (item of visible(); track item.id) {
        <a
          class="poster"
          [routerLink]="item.link"
          [queryParams]="item.queryParams"
          [queryParamsHandling]="item.queryParams ? '' : 'preserve'"
          [title]="item.name"
        >
          <div class="art">
            @if (item.image) {
              <img [src]="item.image" [alt]="item.name" loading="lazy" />
            } @else {
              <div class="placeholder">{{ item.name }}</div>
            }
            @if (item.progress; as progress) {
              <div class="progress" [style.width.%]="progress * 100"></div>
            }
          </div>
          <span>{{ item.name }}</span>
        </a>
      } @empty {
        <p class="empty">Nothing here.</p>
      }
    </div>
    @if (limit() < items().length) {
      <div class="sentinel" (appInView)="limit.set(limit() + pageSize)"></div>
    }
  `,
  styles: `
    :host {
      display: block;
      padding: 1rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 1rem;
    }
    .poster {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      color: var(--text);
      text-decoration: none;
      font-size: 0.85rem;
    }
    .art {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius);
      transition: transform 0.15s ease;
    }
    .progress {
      position: absolute;
      inset: auto auto 0 0;
      height: 4px;
      background: var(--accent);
    }
    img,
    .placeholder {
      width: 100%;
      aspect-ratio: 2 / 3;
      object-fit: cover;
      display: block;
      background: var(--surface);
    }
    .placeholder {
      display: grid;
      place-items: center;
      padding: 0.5rem;
      text-align: center;
      color: var(--text-muted);
    }
    .poster:hover .art {
      transform: scale(1.03);
      outline: 2px solid var(--accent);
    }
    span {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .sentinel {
      height: 1px;
    }
    .empty {
      color: var(--text-muted);
    }
  `,
})
export class PosterGrid {
  readonly items = input.required<PosterItem[]>();

  protected readonly pageSize = PAGE_SIZE;
  protected readonly limit = linkedSignal({ source: this.items, computation: () => PAGE_SIZE });
  protected readonly visible = computed(() => this.items().slice(0, this.limit()));
}
