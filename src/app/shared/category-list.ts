import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { Category } from '../core/xtream/xtream.models';

/** Filterable category sidebar; `null` selection means "All". */
@Component({
  selector: 'app-category-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <input
      class="filter"
      type="search"
      placeholder="Filter categories"
      [value]="filter()"
      (input)="filter.set($any($event.target).value)"
    />
    <ul>
      <li>
        <button
          type="button"
          [class.active]="selected() === null"
          (click)="selectedChange.emit(null)"
        >
          All
        </button>
      </li>
      @for (category of visible(); track category.category_id) {
        <li>
          <button
            type="button"
            [class.active]="selected() === category.category_id"
            (click)="selectedChange.emit(category.category_id)"
          >
            {{ category.category_name }}
          </button>
        </li>
      }
    </ul>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--border);
    }
    .filter {
      margin: 0.75rem;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0 0.5rem 1rem;
      overflow-y: auto;
    }
    button {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 0;
      border-radius: var(--radius);
      background: none;
      color: var(--text-muted);
      text-align: left;
      cursor: pointer;
    }
    button:hover {
      background: var(--surface-hover);
      color: var(--text);
    }
    button.active {
      background: var(--accent-soft);
      color: var(--text);
    }
  `,
})
export class CategoryList {
  readonly categories = input.required<Category[]>();
  readonly selected = input<string | null>(null);
  readonly selectedChange = output<string | null>();

  protected readonly filter = signal('');
  protected readonly visible = computed(() => {
    const term = this.filter().trim().toLowerCase();
    const all = this.categories();
    return term ? all.filter((c) => c.category_name.toLowerCase().includes(term)) : all;
  });
}
