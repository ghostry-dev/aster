/**
 * Near misses: every single-character deletion, duplication, and adjacent swap
 * of an accepted input, plus a few replacements. These sit right at the
 * language boundary, which is where a construction bug would show.
 */
export function nearMisses(input: string): string[] {
  const variants = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const at = input.charAt(index);
    variants.add(input.slice(0, index) + input.slice(index + 1));
    variants.add(input.slice(0, index) + at + input.slice(index));
    variants.add(
      input.slice(0, index)
        + input.charAt(index + 1)
        + at
        + input.slice(index + 2),
    );
    variants.add(`${input.slice(0, index)}x${input.slice(index + 1)}`);
    variants.add(`${input.slice(0, index)}.${input.slice(index + 1)}`);
  }
  variants.delete(input);
  return [...variants];
}

/**
 * Every string over `alphabet` of length at most `length`, shortest first.
 */
export function strings(alphabet: readonly string[], length: number): string[] {
  const all = [""];
  let layer = [""];
  for (let size = 1; size <= length; size += 1) {
    layer = layer.flatMap((prefix) => alphabet.map((last) => prefix + last));
    all.push(...layer);
  }
  return all;
}
