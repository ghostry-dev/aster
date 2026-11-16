/**
 * Code point handling shared by the emitter and the NFA. Text is read by code
 * point, never by UTF-16 code unit, matching a `u` or `v` flag regex: an astral
 * character is one code point, and a lone surrogate is one code point too.
 *
 * @module
 */

/**
 * A sorted set of disjoint, non-adjacent, inclusive code point ranges.
 */
export type CodePointSet = readonly (readonly [number, number])[];

/**
 * The code point of a string that is exactly one code point, else `undefined`.
 */
export function codePoint(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const point = value.codePointAt(0);
  if (point === undefined) return undefined;
  return value.length === (point > 0xffff ? 2 : 1) ? point : undefined;
}

/**
 * Every code point of `text`, in order.
 */
export function codePoints(text: string): number[] {
  return [...text].map((character) => character.codePointAt(0) ?? 0);
}

/**
 * Sort and merge ranges into a canonical {@link CodePointSet}: overlapping and
 * adjacent ranges become one.
 */
export function merge(
  ranges: readonly (readonly [number, number])[],
): CodePointSet {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of sorted) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && from <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], to);
    } else {
      merged.push([from, to]);
    }
  }
  return merged;
}

/**
 * Whether `point` is in `set`, by binary search.
 */
export function contains(set: CodePointSet, point: number): boolean {
  let low = 0;
  let high = set.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = set[middle];
    if (range === undefined) return false;
    if (point < range[0]) high = middle - 1;
    else if (point > range[1]) low = middle + 1;
    else return true;
  }
  return false;
}
