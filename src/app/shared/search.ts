/** Case-insensitive name filter shared by the catalogue pages. */
export function filterByName<T extends { name: string }>(items: readonly T[], term: string): T[] {
  const needle = term.trim().toLowerCase();
  return needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : [...items];
}
