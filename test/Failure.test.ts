import {
  either,
  grammar,
  initialize,
  literal,
  oneOrMore,
  range,
  sequence,
  zeroOrMore,
  type Expectation,
  type ParseFailure,
  type ParseResult,
} from "@ghostry/aster";
import { describe, expect, test } from ".";
import { realistic } from "./stress/Realistic";

const { toParser } = initialize();

function rejected<$Node>(result: ParseResult<$Node>): ParseFailure {
  if (result.ok) throw new Error("the input was accepted");
  return result;
}

const rule = (name: string): Expectation => ({ kind: "rule", rule: name });
const end: Expectation = { kind: "end" };
const characters = (...ranges: (readonly [string, string])[]): Expectation => ({
  kind: "characters",
  ranges,
});

const date = grammar()
  .define("digit", () => range("0", "9"))
  .define("year", ({ digit }) => sequence([digit, digit, digit, digit]))
  .define("month", ({ digit }) => sequence([digit, digit]))
  .define("date", ({ year, month }) => sequence([year, literal("-"), month]))
  .compose();

describe("what was expected", () => {
  const parse = toParser(date, "date");
  const cases: readonly (readonly [string, readonly Expectation[], string])[] =
    [
      /** The outermost rule starting at the failure, not the digit inside it. */
      ["2026-x1", [rule("month")], 'Expected month at 1:6, found "x".'],
      /** Inside a rule that started earlier, the rule that starts here. */
      ["2026-1x", [rule("digit")], 'Expected digit at 1:7, found "x".'],
      /** Where no rule starts, the characters themselves. */
      ["2026x11", [characters(["-", "-"])], 'Expected "-" at 1:5, found "x".'],
      ["2026-110", [end], 'Expected end of input at 1:8, found "0".'],
      ["2026-1", [rule("digit")], "Expected digit at 1:7, found end of input."],
      /** The rule being parsed is never reported; what begins it is. */
      ["", [rule("year")], "Expected year at 1:1, found end of input."],
      ["x", [rule("year")], 'Expected year at 1:1, found "x".'],
    ];

  test.each(cases)("%p", ({ row: [input, expected, message] }) => {
    const failure = rejected(parse(input));
    expect(failure.expected).toEqual(expected);
    expect(failure.message).toBe(message);
  });

  test("alternatives are listed in preference order, without duplicates", () => {
    const parse = toParser(realistic, "timestamp");
    expect(rejected(parse("2026-11-15T09:30:00")).message).toBe(
      "Expected fraction or offset at 1:20, found end of input.",
    );
    const log = toParser(realistic, "logLine");
    const failure = rejected(
      log("2026-11-15T09:30:00Z INFO 10.0.0.1 https://x 1.2 -- hi"),
    );
    expect(failure.expected).toEqual([rule("digit"), rule("dot")]);
  });

  test("three or more read as a list", () => {
    const composed = grammar()
      .define("a", () => literal("a"))
      .define("b", () => literal("b"))
      .define("rule", ({ a, b }) =>
        sequence([literal("<"), zeroOrMore(either(a, b)), literal(">")]),
      )
      .compose();
    expect(rejected(toParser(composed, "rule")("<x")).message).toBe(
      'Expected a, b, or ">" at 1:2, found "x".',
    );
  });

  test("anonymous characters merge into one sorted class", () => {
    const composed = grammar()
      .define("rule", () =>
        sequence([
          either(range("x", "z"), literal("b"), range("a", "c"), literal("-")),
          literal("!"),
        ]),
      )
      .compose();
    const failure = rejected(toParser(composed, "rule")("?"));
    expect(failure.expected).toEqual([
      characters(["-", "-"], ["a", "c"], ["x", "z"]),
    ]);
    expect(failure.message).toBe('Expected [-a-cx-z] at 1:1, found "?".');
  });

  test("end of input sits beside what could have continued", () => {
    const composed = grammar()
      .define("digit", () => range("0", "9"))
      .define("number", ({ digit }) => oneOrMore(digit))
      .compose();
    const failure = rejected(toParser(composed, "number")("12a"));
    expect(failure.expected).toEqual([rule("digit"), end]);
    expect(failure.message).toBe(
      'Expected digit or end of input at 1:3, found "a".',
    );
  });
});

describe("where it failed", () => {
  const parse = toParser(date, "date");

  test("the span covers the character found", () => {
    const failure = rejected(parse("2026-1x"));
    expect([failure.span.start, failure.span.end]).toEqual([6, 7]);
  });

  test("an astral character is one code point wide in the span", () => {
    const failure = rejected(parse("2026-1😀"));
    expect([failure.span.start, failure.span.end]).toEqual([6, 8]);
    expect(failure.message).toBe('Expected digit at 1:7, found "😀".');
  });

  test("the span is empty at the end of the input", () => {
    const failure = rejected(parse("2026-1"));
    expect([failure.span.start, failure.span.end]).toEqual([6, 6]);
    expect(failure.span.position()).toEqual({
      start: { line: 1, column: 7 },
      end: { line: 1, column: 7 },
    });
  });

  test("lines and code point columns", () => {
    const composed = grammar()
      .define("letter", () => either(range("a", "z"), literal("😀")))
      .define("word", ({ letter }) => oneOrMore(letter))
      .define("lines", ({ word }) =>
        sequence([word, zeroOrMore(sequence([literal("\n"), word]))]),
      )
      .compose();
    const failure = rejected(toParser(composed, "lines")("ab\n😀😀c?"));
    expect(failure.span.position()).toEqual({
      start: { line: 2, column: 4 },
      end: { line: 2, column: 5 },
    });
    expect(failure.message).toBe(
      'Expected letter, "\\n", or end of input at 2:4, found "?".',
    );
  });

  test("control characters are escaped in messages", () => {
    const failure = rejected(parse("2026\t"));
    expect(failure.message).toBe('Expected "-" at 1:5, found "\\t".');
  });
});
