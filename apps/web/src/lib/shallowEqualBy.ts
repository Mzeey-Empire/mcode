/**
 * Returns true if arrays `a` and `b` contain the same elements
 * compared by the given keys (shallow per-element check).
 */
export function shallowEqualBy<T>(a: readonly T[], b: readonly T[], keys: (keyof T)[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((itemA, i) => keys.every((k) => itemA[k] === b[i][k]));
}
