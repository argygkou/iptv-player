import { CategoryPrefs } from '../core/library/library.models';
import { Category } from '../core/xtream/xtream.models';

/**
 * Provider category names usually start with a country or brand prefix:
 * "UK | Sports", "|DE| Kinder", "[FR] Cinéma", "GR: News", "US - Movies".
 * These patterns find it; a dash only counts after a short code, so a title
 * like "Action - Adventure" stays whole.
 */
const PREFIX_PATTERNS = [
  /^\s*[|[(]\s*([^|\])]{1,24}?)\s*[|\])]\s*[-:|]?\s*(.*)$/,
  /^\s*([^|:]{1,24}?)\s*[|:]\s*(.+)$/,
  /^\s*([A-Za-z]{2,4})\s+[-–—»►➾•]\s+(.+)$/,
];

/** A category under its group, labelled without the group's prefix. */
export interface GroupedCategory {
  category: Category;
  label: string;
}

export interface CategoryGroup {
  /** Upper-cased prefix; `null` for the categories without a shared prefix. */
  key: string | null;
  /** The prefix as the provider first wrote it. */
  name: string;
  categories: GroupedCategory[];
}

interface Split {
  key: string;
  name: string;
  rest: string;
}

function split(name: string): Split | null {
  for (const pattern of PREFIX_PATTERNS) {
    const match = pattern.exec(name);
    const prefix = match?.[1].trim();
    if (match && prefix) {
      return { key: groupKey(prefix), name: prefix, rest: match[2].trim() };
    }
  }
  return null;
}

/** How a group is stored, so "uk" and "UK " are the same group. */
export function groupKey(prefix: string): string {
  return prefix.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** The category's group key, whether or not the group has other members. */
export function categoryGroupKey(category: Category): string | null {
  return split(category.category_name)?.key ?? null;
}

/**
 * Groups categories by prefix, in the provider's order of first appearance.
 * A prefix needs at least two categories to make a group; the rest go in a
 * last group with a `null` key. Without any group, that is the only one.
 */
export function groupCategories(categories: readonly Category[]): CategoryGroup[] {
  const splits = categories.map((category) => ({ category, split: split(category.category_name) }));
  const sizes = new Map<string, number>();
  for (const { split } of splits) {
    if (split) {
      sizes.set(split.key, (sizes.get(split.key) ?? 0) + 1);
    }
  }
  const groups = new Map<string | null, CategoryGroup>();
  const other: CategoryGroup = { key: null, name: 'Other', categories: [] };
  for (const { category, split } of splits) {
    if (split && sizes.get(split.key)! > 1) {
      let group = groups.get(split.key);
      if (!group) {
        group = { key: split.key, name: split.name, categories: [] };
        groups.set(split.key, group);
      }
      group.categories.push({ category, label: split.rest || category.category_name });
    } else {
      other.categories.push({ category, label: category.category_name });
    }
  }
  return [...groups.values(), ...(other.categories.length ? [other] : [])];
}

/** Whether the user hid the category, or its whole group. */
export function isCategoryHidden(category: Category, prefs: CategoryPrefs): boolean {
  if (prefs.hidden.includes(category.category_id)) {
    return true;
  }
  const key = prefs.hiddenGroups.length ? categoryGroupKey(category) : null;
  return key !== null && prefs.hiddenGroups.includes(key);
}

/** Ids of the hidden categories, to leave their items out of "All". */
export function hiddenCategoryIds(
  categories: readonly Category[],
  prefs: CategoryPrefs,
): ReadonlySet<string> {
  return new Set(categories.filter((c) => isCategoryHidden(c, prefs)).map((c) => c.category_id));
}

/** The items of "All": everything outside a hidden category. */
export function withoutHidden<T extends { category_id: string | null | undefined }>(
  items: T[],
  hidden: ReadonlySet<string>,
): T[] {
  return hidden.size ? items.filter((item) => !hidden.has(String(item.category_id))) : items;
}
