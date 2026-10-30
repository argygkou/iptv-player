import { NO_CATEGORY_PREFS } from '../core/library/library.models';
import { Category } from '../core/xtream/xtream.models';
import {
  categoryGroupKey,
  groupCategories,
  hiddenCategoryIds,
  withoutHidden,
} from './category-groups';

const category = (id: string, name: string): Category => ({
  category_id: id,
  category_name: name,
  parent_id: 0,
});

describe('categoryGroupKey', () => {
  it('reads the usual provider prefixes', () => {
    const key = (name: string) => categoryGroupKey(category('1', name));
    expect(key('UK | Sports')).toBe('UK');
    expect(key('|DE| Kinder')).toBe('DE');
    expect(key('[fr] Cinéma')).toBe('FR');
    expect(key('GR: News')).toBe('GR');
    expect(key('US - Movies')).toBe('US');
    expect(key('Greece | News')).toBe('GREECE');
  });

  it('leaves names without a prefix whole', () => {
    expect(categoryGroupKey(category('1', 'Documentaries'))).toBeNull();
    expect(categoryGroupKey(category('1', 'Action - Adventure'))).toBeNull();
    expect(categoryGroupKey(category('1', 'Spider-Man'))).toBeNull();
  });
});

describe('groupCategories', () => {
  it('groups shared prefixes in provider order and puts the rest last', () => {
    const groups = groupCategories([
      category('1', 'UK | Sports'),
      category('2', 'Documentaries'),
      category('3', '|DE| Kinder'),
      category('4', 'uk | News'),
      category('5', 'FR | Only one'),
      category('6', 'DE: Sport'),
    ]);
    expect(groups.map((g) => [g.key, g.name, g.categories.map((c) => c.label)])).toEqual([
      ['UK', 'UK', ['Sports', 'News']],
      ['DE', 'DE', ['Kinder', 'Sport']],
      [null, 'Other', ['Documentaries', 'FR | Only one']],
    ]);
  });

  it('makes one ungrouped list when nothing shares a prefix', () => {
    const groups = groupCategories([category('1', 'Action'), category('2', 'Drama')]);
    expect(groups.length).toBe(1);
    expect(groups[0].key).toBeNull();
  });
});

describe('hidden categories', () => {
  const categories = [
    category('1', 'UK | Sports'),
    category('2', 'UK | News'),
    category('3', 'Greece | News'),
  ];

  it('hides single categories and whole groups', () => {
    expect([...hiddenCategoryIds(categories, NO_CATEGORY_PREFS)]).toEqual([]);
    const prefs = { pinned: [], hidden: ['3'], hiddenGroups: ['UK'] };
    expect([...hiddenCategoryIds(categories, prefs)].sort()).toEqual(['1', '2', '3']);
  });

  it('leaves items of hidden categories out', () => {
    const items = [{ category_id: '1' }, { category_id: '3' }];
    expect(withoutHidden(items, new Set(['1']))).toEqual([{ category_id: '3' }]);
  });
});
