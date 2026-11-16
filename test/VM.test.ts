import { compile, type Program } from "#internal/NFA";
import { run } from "#internal/VM";
import {
  either,
  grammar,
  literal,
  oneOrMore,
  optional,
  range,
  repeat,
  sequence,
  toRegExp,
  zeroOrMore,
  type Grammar,
  type RuleNames,
} from "@ghostry/aster";
import type { Expr } from "@ghostry/aster/unstable-ir";
import { describe, expect, test } from ".";
import { backtrack } from "./fixtures/backtrack";
import { strings } from "./fixtures/inputs";
import { realistic } from "./stress/Realistic";

type Realistic = RuleNames<typeof realistic>;

/**
 * The VM's answer in the oracle's shape: the winning events, or `undefined`.
 */
function events(program: Program, input: string) {
  const result = run(program, input);
  return result.ok ? result.events : undefined;
}

/**
 * Same inputs and derivations as the backtracking oracle, which explores the
 * program depth-first in priority order exactly as JS regex does. Equal traces
 * mean the VM picked the derivation backtracking would, mark for mark and
 * offset for offset.
 */
describe("the VM picks the derivation backtracking picks", () => {
  const accepted: readonly (readonly [Realistic, string])[] = [
    ["timestamp", "2026-11-15T09:30:00Z"],
    ["timestamp", "2026-11-15T09:30:00.123+05:30"],
    ["semver", "1.0.0"],
    ["semver", "10.20.30-alpha.1+build.5"],
    ["semver", "0.0.0-0"],
    ["semver", "1.0.0-0a.00.x-y"],
    ["ipv4", "192.168.0.1"],
    ["ipv4", "255.255.255.255"],
    ["uri", "https://example.com/a/b?q=1#top"],
    ["uri", "s3+x://10.0.0.1:9000/bucket"],
    [
      "logLine",
      "2026-11-15T09:30:00Z INFO 10.0.0.1 https://ex.com/x 1.2.3 -- ok",
    ],
  ];

  test.each(accepted)("%s on %p", ({ row: [rule, input] }) => {
    const program = compile(realistic, rule);
    const found = events(program, input);
    expect(found).toBeDefined();
    expect(found).toEqual(backtrack(program, input));
  });

  /**
   * Grammars that are ambiguous on purpose, checked on every short string over
   * their alphabet: overlapping alternatives, loops over them, optionals that
   * compete with what follows, and bounded loops next to unbounded ones.
   */
  const a = literal("a");
  const b = literal("b");
  const ab = literal("ab");
  const ambiguous: readonly (readonly [string, Expr])[] = [
    ["overlapping loop", sequence([zeroOrMore(either(a, ab, b)), optional(b)])],
    ["loop then same", sequence([zeroOrMore(a), a, zeroOrMore(either(a, b))])],
    ["nested loops", oneOrMore(sequence([oneOrMore(a), optional(b)]))],
    [
      "bounded beside unbounded",
      sequence([repeat(either(a, ab), { min: 1, max: 3 }), zeroOrMore(b)]),
    ],
    [
      "optional against loop",
      sequence([optional(ab), zeroOrMore(either(a, b))]),
    ],
    ["alternatives of sequences", either(sequence([a, b]), sequence([ab]), b)],
  ];

  test.each(ambiguous)("%s, on every string up to length 7", ({ row }) => {
    const [, body] = row;
    const composed: Grammar = { rules: [{ name: "rule", body }] };
    const program = compile(composed, "rule");
    for (const input of strings(["a", "b"], 7)) {
      expect([input, events(program, input)]).toEqual([
        input,
        backtrack(program, input),
      ]);
    }
  });
});

describe("membership agrees with the emitted regex", () => {
  test("on every short string over a grammar's alphabet", () => {
    const composed = grammar()
      .define("digit", () => range("0", "2"))
      .define("number", ({ digit }) =>
        sequence([optional(literal("-")), oneOrMore(digit)]),
      )
      .define("list", ({ number }) =>
        sequence([number, zeroOrMore(sequence([literal(","), number]))]),
      )
      .compose();
    const program = compile(composed, "list");
    const regex = toRegExp(composed, "list");
    for (const input of strings(["0", "1", "-", ","], 6))
      expect([input, run(program, input).ok]).toEqual([
        input,
        regex.test(input),
      ]);
  });
});

describe("failure offsets", () => {
  const composed = grammar()
    .define("word", () => either(literal("cat"), literal("car")))
    .define("words", ({ word }) =>
      sequence([word, zeroOrMore(sequence([literal(" "), word]))]),
    )
    .compose();
  const program = compile(composed, "words");

  const cases: readonly (readonly [string, number])[] = [
    ["", 0],
    ["x", 0],
    ["cab", 2],
    ["ca", 2],
    ["cat cars", 7],
    ["cat cow", 5],
    ["cat car ", 8],
    ["catx", 3],
  ];

  test.each(cases)("%p fails at %d", ({ row: [input, offset] }) => {
    expect(run(program, input)).toEqual({ ok: false, offset });
  });
});

describe("code points", () => {
  const composed = grammar()
    .define("face", () => range("😀", "😿"))
    .define("faces", ({ face }) => oneOrMore(face))
    .compose();
  const program = compile(composed, "faces");

  test("an astral character is one step, and offsets count code units", () => {
    const found = events(program, "😀😺");
    expect(found?.map(({ offset }) => offset)).toEqual([
      0, 0, 0, 2, 2, 2, 4, 4, 4,
    ]);
  });

  test("a lone surrogate is one code point, outside an astral range", () => {
    expect(run(program, "😀\uD83D")).toEqual({ ok: false, offset: 2 });
  });
});

/**
 * The VM visits each state at most once per input position, so inputs that send
 * a backtracker into exponential time cost it linear time.
 */
describe("linear time", () => {
  test("a catastrophic-backtracking shape rejects quickly", () => {
    const composed = grammar()
      .define("rule", () =>
        sequence([
          oneOrMore(either(literal("a"), literal("a"), literal("aa"))),
          literal("b"),
        ]),
      )
      .compose();
    const program = compile(composed, "rule");
    const input = "a".repeat(20_000);
    expect(run(program, input)).toEqual({ ok: false, offset: input.length });
    expect(run(program, `${input}b`).ok).toBe(true);
  });

  test("a body nested a hundred thousand levels deep accepts and rejects", () => {
    const DEPTH = 100_000;
    let body: Expr = literal("ab");
    for (let level = 0; level < DEPTH; level += 1) body = optional(body);
    const program = compile(
      grammar()
        .define("deep", () => body)
        .compose(),
      "deep",
    );
    expect(events(program, "ab")).toHaveLength(DEPTH + 2);
    expect(events(program, "")).toHaveLength(DEPTH + 2);
    expect(run(program, "abc")).toEqual({ ok: false, offset: 2 });
    expect(run(program, "a")).toEqual({ ok: false, offset: 1 });
  });
});
