import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  Injectable,
  input,
  output,
  signal,
} from '@angular/core';

import { LibraryStore } from '../core/library/library-store';
import { CategoryPrefs } from '../core/library/library.models';
import { Category, StreamKind } from '../core/xtream/xtream.models';
import {
  categoryGroupKey,
  CategoryGroup,
  groupCategories,
  GroupedCategory,
  isCategoryHidden,
} from './category-groups';

/** An entry above the provider's categories, such as the favourites. */
export interface ExtraCategory {
  id: string;
  label: string;
}

/** Which groups are open, kept while the app runs so pages can be switched. */
@Injectable({ providedIn: 'root' })
export class CategoryListState {
  readonly expanded = signal<ReadonlySet<string>>(new Set());

  toggle(key: string, open?: boolean): void {
    this.expanded.update((current) => {
      const next = new Set(current);
      if (open ?? !next.has(key)) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }
}

/** A group as the sidebar shows it, without the categories the user hid. */
interface ShownGroup extends CategoryGroup {
  hidden: boolean;
}

/**
 * Category sidebar; `null` selection means "All". Provider categories are
 * grouped by prefix (usually a country) in collapsible sections, and the
 * user can pin categories to the top or hide categories and whole groups.
 * Pins and hides are saved per profile in the library.
 */
@Component({
  selector: 'app-category-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  template: `
    <div class="header">
      <input
        class="filter"
        type="search"
        placeholder="Filter categories"
        [value]="filter()"
        (input)="filter.set($any($event.target).value)"
      />
      <ng-content />
    </div>
    <ul>
      <li class="row" [class.active]="selected() === null">
        <button type="button" class="pick" (click)="selectedChange.emit(null)">All</button>
      </li>
      @for (extra of extras(); track extra.id) {
        <li class="row" [class.active]="selected() === extra.id">
          <button type="button" class="pick" (click)="selectedChange.emit(extra.id)">
            {{ extra.label }}
          </button>
        </li>
      }
      @if (extras().length || pinned().length) {
        <li class="divider" role="separator"></li>
      }

      @if (term()) {
        @for (entry of matches(); track entry.category.category_id) {
          <ng-container *ngTemplateOutlet="row; context: { $implicit: entry, nested: false }" />
        } @empty {
          <li class="note">No categories match.</li>
        }
      } @else {
        @for (entry of pinned(); track entry.category.category_id) {
          <ng-container *ngTemplateOutlet="row; context: { $implicit: entry, nested: false }" />
        }
        @if (pinned().length) {
          <li class="divider" role="separator"></li>
        }
        @for (group of groups(); track group.key) {
          @if (flat()) {
            @for (entry of group.categories; track entry.category.category_id) {
              <ng-container *ngTemplateOutlet="row; context: { $implicit: entry, nested: false }" />
            }
          } @else {
            <li class="row group" [class.hidden]="group.hidden">
              <button
                type="button"
                class="pick"
                [attr.aria-expanded]="isOpen(group)"
                (click)="toggleGroup(group)"
              >
                <svg
                  class="chevron"
                  [class.open]="isOpen(group)"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M9 5l7 7-7 7" />
                </svg>
                <span class="label">{{ group.name }}</span>
                <span class="count">{{ group.categories.length }}</span>
              </button>
              @if (group.key !== null) {
                <span class="actions">
                  <button
                    type="button"
                    class="action"
                    [title]="group.hidden ? 'Show ' + group.name : 'Hide all of ' + group.name"
                    (click)="toggleGroupHidden(group)"
                  >
                    <ng-container *ngTemplateOutlet="eye; context: { $implicit: group.hidden }" />
                  </button>
                </span>
              }
            </li>
            @if (isOpen(group)) {
              @for (entry of group.categories; track entry.category.category_id) {
                <ng-container
                  *ngTemplateOutlet="row; context: { $implicit: entry, nested: true }"
                />
              }
            }
          }
        }
      }
    </ul>

    @if (hiddenCount()) {
      <button type="button" class="show-hidden" (click)="showHidden.set(!showHidden())">
        {{ showHidden() ? 'Done' : 'Show hidden (' + hiddenCount() + ')' }}
      </button>
    }

    <ng-template #row let-entry let-nested="nested">
      <li
        class="row"
        [class.active]="selected() === entry.category.category_id"
        [class.nested]="nested"
        [class.hidden]="isHidden(entry.category)"
        [class.pinned]="isPinned(entry.category)"
      >
        <button
          type="button"
          class="pick"
          [title]="entry.category.category_name"
          (click)="selectedChange.emit(entry.category.category_id)"
        >
          <span class="label">{{ entry.label }}</span>
        </button>
        <span class="actions">
          <button
            type="button"
            class="action pin"
            [attr.aria-pressed]="isPinned(entry.category)"
            [title]="isPinned(entry.category) ? 'Unpin' : 'Pin to the top'"
            (click)="togglePinned(entry.category)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 3h6l-1 6 4 4v2h-5v6l-1 1-1-1v-6H6v-2l4-4z" />
            </svg>
          </button>
          <button
            type="button"
            class="action"
            [title]="isHidden(entry.category) ? 'Show' : 'Hide'"
            (click)="toggleHidden(entry.category)"
          >
            <ng-container
              *ngTemplateOutlet="eye; context: { $implicit: isHidden(entry.category) }"
            />
          </button>
        </span>
      </li>
    </ng-template>

    <ng-template #eye let-hidden>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
        @if (!hidden) {
          <path d="M4 4l16 16" />
        }
      </svg>
    </ng-template>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--border);
    }
    .header {
      position: relative;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem;
    }
    .filter {
      flex: 1;
      min-width: 0;
    }
    ul {
      flex: 1;
      list-style: none;
      margin: 0;
      padding: 0 0.5rem 1rem;
      overflow-y: auto;
    }
    button {
      border: 0;
      background: none;
      color: var(--text-muted);
      cursor: pointer;
    }
    .pick {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 0.4rem;
      min-width: 0;
      padding: 0.5rem 0.75rem;
      color: inherit;
      text-align: left;
    }
    .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* The whole row highlights, its actions included. */
    .row {
      display: flex;
      align-items: center;
      border-radius: var(--radius);
      color: var(--text-muted);
    }
    /* Hover only colours what is under the pointer; only the selected row has a background. */
    .row button,
    .row button:hover:not(:disabled) {
      background: none;
    }
    .pick:hover {
      color: var(--accent);
    }
    .row.active {
      background: var(--accent-soft);
      color: var(--text);
    }
    .row.nested .pick {
      padding-left: 2.3rem;
    }
    .row.hidden .label {
      opacity: 0.45;
      text-decoration: line-through;
    }
    .group {
      color: var(--text);
    }
    .group .label {
      font-size: 0.8rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .chevron {
      flex: none;
      width: 1.15rem;
      height: 1.15rem;
      transition: transform 0.12s;
    }
    .chevron.open {
      transform: rotate(90deg);
    }
    .count {
      color: var(--text-muted);
      font-size: 0.8rem;
      font-weight: 400;
    }
    .actions {
      display: none;
      gap: 0.1rem;
      padding-right: 0.25rem;
    }
    .row:hover .actions,
    .row:has(:focus-visible) .actions {
      display: flex;
    }
    .row:hover:has(.actions) .count {
      display: none;
    }
    .action {
      display: grid;
      place-items: center;
      width: 1.6rem;
      height: 1.6rem;
      padding: 0;
      border-radius: var(--radius);
    }
    .action:hover {
      color: var(--accent);
    }
    .action.pin[aria-pressed='true'] {
      color: var(--accent);
    }
    svg {
      display: block;
      width: 1rem;
      height: 1rem;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .divider {
      margin: 0.4rem 0.75rem;
      border-top: 1px solid var(--border);
    }
    .note {
      padding: 0.5rem 0.75rem;
      color: var(--text-muted);
    }
    .show-hidden {
      padding: 0.6rem 1.25rem;
      border-top: 1px solid var(--border);
      font-size: 0.85rem;
      text-align: left;
    }
    .show-hidden:hover {
      color: var(--text);
    }
  `,
})
export class CategoryList {
  readonly kind = input.required<StreamKind>();
  readonly categories = input.required<readonly Category[]>();
  readonly extras = input<ExtraCategory[]>([]);
  readonly selected = input<string | null>(null);
  readonly selectedChange = output<string | null>();

  private readonly library = inject(LibraryStore);
  private readonly state = inject(CategoryListState);

  protected readonly filter = signal('');
  protected readonly showHidden = signal(false);
  protected readonly term = computed(() => this.filter().trim().toLowerCase());

  private readonly prefs = computed(() => this.library.categoryPrefs(this.kind()));
  private readonly grouped = computed(() => groupCategories(this.categories()));
  private readonly hiddenIds = computed(() => {
    const prefs = this.prefs();
    return new Set(
      this.categories()
        .filter((c) => isCategoryHidden(c, prefs))
        .map((c) => c.category_id),
    );
  });
  private readonly pinnedIds = computed(() => new Set(this.prefs().pinned));

  /** One plain list when the provider's names share no prefix. */
  protected readonly flat = computed(() => this.grouped().length === 1);
  protected readonly hiddenCount = computed(() => this.hiddenIds().size);

  protected readonly groups = computed<ShownGroup[]>(() => {
    const prefs = this.prefs();
    const showHidden = this.showHidden();
    return this.grouped().flatMap((group) => {
      const hidden = group.key !== null && prefs.hiddenGroups.includes(group.key);
      const categories = showHidden
        ? group.categories
        : group.categories.filter((entry) => !this.hiddenIds().has(entry.category.category_id));
      return categories.length && (showHidden || !hidden) ? [{ ...group, categories, hidden }] : [];
    });
  });

  /** Pinned categories in pin order, under their full names. */
  protected readonly pinned = computed<GroupedCategory[]>(() => {
    const byId = new Map(this.categories().map((c) => [c.category_id, c]));
    return this.prefs().pinned.flatMap((id) => {
      const category = byId.get(id);
      return category && !this.hiddenIds().has(id)
        ? [{ category, label: category.category_name }]
        : [];
    });
  });

  protected readonly matches = computed<GroupedCategory[]>(() => {
    const term = this.term();
    return this.categories()
      .filter(
        (c) =>
          c.category_name.toLowerCase().includes(term) &&
          (this.showHidden() || !this.hiddenIds().has(c.category_id)),
      )
      .map((category) => ({ category, label: category.category_name }));
  });

  constructor() {
    // Open the group of the selected category, such as one restored from the URL.
    effect(() => {
      const selected = this.selected();
      const group = this.grouped().find((g) =>
        g.categories.some((entry) => entry.category.category_id === selected),
      );
      if (group) {
        this.state.toggle(this.stateKey(group), true);
      }
    });
    // Nothing left to manage once the last hidden category is shown again.
    effect(() => {
      if (!this.hiddenCount()) {
        this.showHidden.set(false);
      }
    });
  }

  protected isOpen(group: CategoryGroup): boolean {
    return this.state.expanded().has(this.stateKey(group));
  }

  protected toggleGroup(group: CategoryGroup): void {
    this.state.toggle(this.stateKey(group));
  }

  protected isHidden(category: Category): boolean {
    return this.hiddenIds().has(category.category_id);
  }

  protected isPinned(category: Category): boolean {
    return this.pinnedIds().has(category.category_id);
  }

  protected togglePinned(category: Category): void {
    const { pinned } = this.prefs();
    const id = category.category_id;
    this.save({
      pinned: pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id],
    });
  }

  /** Showing a category of a hidden group shows the group, minus its other categories. */
  protected toggleHidden(category: Category): void {
    const prefs = this.prefs();
    const id = category.category_id;
    if (!this.isHidden(category)) {
      this.save({ hidden: [...prefs.hidden, id] });
      return;
    }
    const hidden = prefs.hidden.filter((h) => h !== id);
    // By the category's own key: its group may since have shrunk into "Other".
    const key = categoryGroupKey(category);
    if (key !== null && prefs.hiddenGroups.includes(key)) {
      const others = this.categories()
        .filter((c) => c.category_id !== id && categoryGroupKey(c) === key)
        .map((c) => c.category_id)
        .filter((other) => !hidden.includes(other));
      this.save({
        hidden: [...hidden, ...others],
        hiddenGroups: prefs.hiddenGroups.filter((k) => k !== key),
      });
    } else {
      this.save({ hidden });
    }
  }

  /** Showing a group shows all of its categories. */
  protected toggleGroupHidden(group: ShownGroup): void {
    const prefs = this.prefs();
    const key = group.key!;
    if (group.hidden) {
      const ids = new Set(group.categories.map((entry) => entry.category.category_id));
      this.save({
        hidden: prefs.hidden.filter((id) => !ids.has(id)),
        hiddenGroups: prefs.hiddenGroups.filter((k) => k !== key),
      });
    } else {
      this.save({ hiddenGroups: [...prefs.hiddenGroups, key] });
    }
  }

  private save(change: Partial<CategoryPrefs>): void {
    void this.library.setCategoryPrefs(this.kind(), { ...this.prefs(), ...change });
  }

  private stateKey(group: CategoryGroup): string {
    return `${this.kind()}:${group.key ?? ''}`;
  }
}
