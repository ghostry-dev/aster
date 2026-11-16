import { either, grammar, literal, range, toPattern } from "@ghostry/aster";
import { attest, describe, expect, test } from ".";

/**
 * The escaper is exercised through the public emitter, because it is what
 * ships. Every pattern is compiled under both `v` (what `toRegExp` uses) and
 * `u` (what JSON Schema validators typically use), since the output promises to
 * be valid and to mean the same thing under both.
 */
const FLAGS = ["v", "u"] as const;

/**
 * Every ASCII code point, plus the non-ASCII ones the escaper treats specially:
 * C1 controls, U+2028/U+2029, U+FEFF, lone surrogates, the last BMP code point,
 * and astral code points.
 */
const POINTS = [
  ...Array.from({ length: 0x80 }, (_, point) => point),
  0x80,
  0x85,
  0x9f,
  0xa0,
  0x2028,
  0x2029,
  0xfeff,
  0xd800,
  0xdbff,
  0xdc00,
  0xdfff,
  0xffff,
  0x1f600,
  0x10ffff,
];

/**
 * Outside every set tested below, so it must never match.
 */
const OUTSIDER = "Ā";

function compileAll(pattern: string): RegExp[] {
  return FLAGS.map((flags) => new RegExp(pattern, flags));
}

describe("outside a class", () => {
  test("each code point as a one-character literal matches itself only", () => {
    for (const point of POINTS) {
      const text = String.fromCodePoint(point);
      const composed = grammar()
        .define("char", () => literal(text))
        .compose();
      for (const regex of compileAll(toPattern(composed, "char"))) {
        expect([point, regex.test(text)]).toEqual([point, true]);
        expect([point, regex.test(OUTSIDER)]).toEqual([point, false]);
        expect([point, regex.test(text + text)]).toEqual([point, false]);
      }
    }
  });

  test("a literal of every ASCII code point matches exactly that string", () => {
    const text = String.fromCodePoint(
      ...Array.from({ length: 0x80 }, (_, point) => point),
    );
    const composed = grammar()
      .define("all", () => literal(text))
      .compose();
    for (const regex of compileAll(toPattern(composed, "all"))) {
      expect(regex.test(text)).toBe(true);
      expect(regex.test(text.slice(1))).toBe(false);
    }
  });
});

/**
 * Every pair of ASCII code points, as a two-member class and as a range, so
 * every character appears in every class position and beside every other
 * character, which is where `v`'s reserved double punctuators (`&&`, `!!`, …)
 * and class syntax (`-`, `]`, `^`) would break a naive escaper.
 */
describe("inside a class", () => {
  test("every pair of ASCII code points, as members and as a range", () => {
    for (let low = 0; low < 0x80; low += 1) {
      for (let high = low + 1; high < 0x80; high += 1) {
        const a = String.fromCodePoint(low);
        const b = String.fromCodePoint(high);
        const middle = String.fromCodePoint(Math.floor((low + high) / 2));
        const composed = grammar()
          .define("pair", () => either(literal(a), literal(b)))
          .define("span", () => range(a, b))
          .compose();

        for (const regex of compileAll(toPattern(composed, "pair"))) {
          expect([low, high, regex.test(a), regex.test(b)]).toEqual([
            low,
            high,
            true,
            true,
          ]);
          expect(regex.test(OUTSIDER)).toBe(false);
        }
        for (const regex of compileAll(toPattern(composed, "span"))) {
          expect([low, high, regex.test(a), regex.test(b)]).toEqual([
            low,
            high,
            true,
            true,
          ]);
          expect(regex.test(middle)).toBe(true);
          expect(regex.test(OUTSIDER)).toBe(false);
        }
      }
    }
  });

  test("a class of every special code point matches each one", () => {
    const texts = POINTS.map((point) => String.fromCodePoint(point));
    const [first, second, ...rest] = texts.map((text) => literal(text));
    const composed = grammar()
      .define("all", () =>
        either(
          attest.definitely(first, "first alternative"),
          attest.definitely(second, "second alternative"),
          ...rest,
        ),
      )
      .compose();
    for (const regex of compileAll(toPattern(composed, "all"))) {
      for (const text of texts) expect(regex.test(text)).toBe(true);
      expect(regex.test(OUTSIDER)).toBe(false);
    }
  });
});
