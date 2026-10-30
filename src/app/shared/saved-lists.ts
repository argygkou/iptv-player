import { ExtraCategory } from './category-list';

/**
 * Lists from the user's library that the catalogue pages show above the
 * provider's categories. Their ids share the `category` query param with
 * provider category ids, which are numeric.
 */
export const FAVOURITES: ExtraCategory = { id: 'favourites', label: '★ Favourites' };
export const RECENT: ExtraCategory = { id: 'recent', label: 'Recently watched' };
export const CONTINUE: ExtraCategory = { id: 'continue', label: 'Continue watching' };

export function isSavedList(category: string | undefined): boolean {
  return [FAVOURITES, RECENT, CONTINUE].some((list) => list.id === category);
}
