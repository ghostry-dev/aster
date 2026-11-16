/**
 * A seeded PRNG (mulberry32), so every fuzz case is reproducible from its seed
 * alone.
 */
export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /**
   * A float in `[0, 1)`.
   */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let mixed = this.#state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * An integer in `[min, max]`.
   */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<$Item>(items: readonly $Item[]): $Item {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}
