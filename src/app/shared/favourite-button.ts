import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { LibraryStore } from '../core/library/library-store';
import { LibraryItem } from '../core/library/library.models';

/** Star that adds the item to, or removes it from, the favourites. */
@Component({
  selector: 'app-favourite-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      [class.on]="active()"
      [attr.aria-pressed]="active()"
      [title]="active() ? 'Remove from favourites' : 'Add to favourites'"
      (click)="library.toggleFavourite(item())"
    >
      <span aria-hidden="true">{{ active() ? '★' : '☆' }}</span>
      @if (label()) {
        {{ active() ? 'Favourite' : 'Add to favourites' }}
      }
    </button>
  `,
  styles: `
    button {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }
    span {
      font-size: 1.1em;
      line-height: 1;
    }
    .on span {
      color: var(--accent);
    }
  `,
})
export class FavouriteButton {
  readonly item = input.required<LibraryItem>();
  /** Show the text next to the star. */
  readonly label = input(false);

  protected readonly library = inject(LibraryStore);
  protected readonly active = computed(() =>
    this.library.isFavourite(this.item().kind, this.item().id),
  );
}
