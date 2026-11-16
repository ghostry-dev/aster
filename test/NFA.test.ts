import { compile, type Program } from "#internal/NFA";
import {
  AsterError,
  either,
  grammar,
  literal,
  optional,
  range,
  repeat,
  sequence,
  toRegExp,
  zeroOrMore,
  type Grammar,
  type RuleNames,
} from "@ghostry/aster";
import { attest, describe, expect, test } from ".";
import { backtrack, marks, type Event } from "./fixtures/backtrack";
import { deep } from "./fixtures/deep";
import { nearMisses } from "./fixtures/inputs";
import { realistic } from "./stress/Realistic";

type Realistic = RuleNames<typeof realistic>;

const ACCEPTED: readonly (readonly [Realistic, string])[] = [
  ["timestamp", "2026-11-15T09:30:00Z"],
  ["timestamp", "2026-11-15T09:30:00.123+05:30"],
  ["semver", "1.0.0"],
  ["semver", "10.20.30-alpha.1+build.5"],
  ["semver", "0.0.0-0"],
  ["ipv4", "192.168.0.1"],
  ["ipv4", "255.255.255.255"],
  ["uri", "https://example.com/a/b?q=1#top"],
  ["uri", "s3+x://10.0.0.1:9000/bucket"],
  [
    "logLine",
    "2026-11-15T09:30:00Z INFO 10.0.0.1 https://ex.com/x 1.2.3 -- ok",
  ],
];

describe("membership agrees with the emitted regex", () => {
  const programs = new Map<Realistic, Program>();
  const programOf = (rule: Realistic): Program => {
    const known = programs.get(rule);
    if (known !== undefined) return known;
    const program = compile(realistic, rule);
    programs.set(rule, program);
    return program;
  };

  test.each(ACCEPTED)(
    "%s on %p and its near misses",
    ({ row: [rule, input] }) => {
      const program = programOf(rule);
      const regex = toRegExp(realistic, rule);
      for (const candidate of [input, ...nearMisses(input)]) {
        expect([
          candidate,
          backtrack(program, candidate) !== undefined,
        ]).toEqual([candidate, regex.test(candidate)]);
      }
    },
  );
});

/**
 * The derivation the NFA's priorities pick, read from the oracle's first
 * accepting path, against what JS regex captures for the same grammar written
 * by hand with groups. These are the design doc's cases where PEG would reject
 * the input outright.
 */
describe("priority matches JS regex backtracking", () => {
  const digit = range("0", "9");

  test("a greedy loop gives back one iteration: [12][3]", () => {
    const composed = grammar()
      .define("number", () => sequence([zeroOrMore(digit), digit]))
      .compose();
    expect(marks(backtrack(compile(composed, "number"), "123"))).toEqual([
      "+number",
      "1:1",
      "1:1",
      "1:0",
      "-number",
    ]);
    expect(/^(\d*)(\d)$/.exec("123")?.[1]).toBe("12");
  });

  test("an earlier alternative that fails later is abandoned: [ab][c]", () => {
    const composed = grammar()
      .define("rule", () =>
        sequence([either(literal("a"), literal("ab")), literal("c")]),
      )
      .compose();
    expect(marks(backtrack(compile(composed, "rule"), "abc"))).toEqual([
      "+rule",
      "2:1",
      "-rule",
    ]);
    expect(/^(?:(a)|(ab))c$/.exec("abc")?.[2]).toBe("ab");
  });

  test("a longer alternative that fails later is abandoned: [a][bc]", () => {
    const composed = grammar()
      .define("rule", () =>
        sequence([either(literal("ab"), literal("a")), literal("bc")]),
      )
      .compose();
    expect(marks(backtrack(compile(composed, "rule"), "abc"))).toEqual([
      "+rule",
      "2:1",
      "-rule",
    ]);
    expect(/^(?:(ab)|(a))bc$/.exec("abc")?.[2]).toBe("a");
  });

  test("optional prefers taking its body, and gives it up when it must", () => {
    const composed = grammar()
      .define("rule", () => sequence([optional(literal("a")), literal("a")]))
      .compose();
    const program = compile(composed, "rule");
    expect(marks(backtrack(program, "aa"))).toEqual(["+rule", "1:1", "-rule"]);
    expect(marks(backtrack(program, "a"))).toEqual(["+rule", "1:0", "-rule"]);
    expect(/^(a)?a$/.exec("aa")?.[1]).toBe("a");
    expect(/^(a)?a$/.exec("a")?.[1]).toBeUndefined();
  });

  test("a bounded repetition is greedy up to its maximum", () => {
    const composed = grammar()
      .define("rule", () =>
        sequence([
          repeat(digit, { min: 1, max: 3 }),
          repeat(digit, { min: 1 }),
        ]),
      )
      .compose();
    expect(marks(backtrack(compile(composed, "rule"), "12345"))).toEqual([
      "+rule",
      "1:1",
      "1:1",
      "1:1",
      "1:0",
      "3:1",
      "3:1",
      "3:0",
      "-rule",
    ]);
    expect(/^(\d{1,3})(\d+)$/.exec("12345")?.[1]).toBe("123");
  });
});

describe("marks", () => {
  test("rule marks bracket each occurrence with its offsets", () => {
    const date = grammar()
      .define("digit", () => range("0", "9"))
      .define("year", ({ digit }) => sequence([digit, digit, digit, digit]))
      .define("month", ({ digit }) => sequence([digit, digit]))
      .define("date", ({ year, month }) =>
        sequence([year, literal("-"), month]),
      )
      .compose();
    const trace = attest.definitely(
      backtrack(compile(date, "date"), "2026-11"),
    );
    const rules = trace
      .filter(({ mark }) => mark.kind !== "choice" && mark.rule !== "digit")
      .map(({ mark, offset }) => `${marks([{ mark, offset }])?.[0]}@${offset}`);
    expect(rules).toEqual([
      "+date@0",
      "+year@0",
      "-year@4",
      "+month@5",
      "-month@7",
      "-date@7",
    ]);
    expect(
      trace.filter(
        ({ mark }) => mark.kind === "enter" && mark.rule === "digit",
      ),
    ).toHaveLength(6);
  });

  test.each(ACCEPTED)(
    "%s on %p nests rule marks properly",
    ({ row: [rule, input] }) => {
      const trace = attest.definitely(
        backtrack(compile(realistic, rule), input),
        "trace",
      );
      expect(balanced(trace, input.length)).toBe(true);
    },
  );

  test("a repetition marks every iteration and its stop", () => {
    const composed = grammar()
      .define("rule", () => repeat(literal("ab"), { min: 2, max: 4 }))
      .compose();
    const program = compile(composed, "rule");
    expect(backtrack(program, "ab")).toBeUndefined();
    expect(marks(backtrack(program, "abab"))).toEqual([
      "+rule",
      "1:1",
      "1:1",
      "1:0",
      "-rule",
    ]);
    expect(marks(backtrack(program, "abababab"))).toEqual([
      "+rule",
      "1:1",
      "1:1",
      "1:1",
      "1:1",
      "1:0",
      "-rule",
    ]);
    expect(backtrack(program, "ababababab")).toBeUndefined();
  });
});

/**
 * Every `exit` closes the innermost open `enter` of the same rule, never before
 * it opened, and the outermost pair spans the whole input.
 */
function balanced(trace: readonly Event[], length: number): boolean {
  const open: Event[] = [];
  for (const event of trace) {
    if (event.mark.kind === "enter") open.push(event);
    if (event.mark.kind === "exit") {
      const top = open.pop();
      if (top === undefined || top.mark.kind !== "enter") return false;
      if (top.mark.rule !== event.mark.rule || top.offset > event.offset)
        return false;
    }
  }
  const first = trace[0];
  const last = trace[trace.length - 1];
  return open.length === 0 && first?.offset === 0 && last?.offset === length;
}

describe("grammars that arrive as data", () => {
  test("an unknown rule name throws UnknownRuleError", () => {
    const error = attest.throws(AsterError.UnknownRuleError, () =>
      compile(realistic, "nope"),
    );
    expect(error.rule).toBe("nope");
  });

  test("an invalid rule is rejected as .define() would reject it", () => {
    const broken: Grammar = {
      rules: [{ name: "bad", body: { kind: "range", from: "z", to: "a" } }],
    };
    attest.throws(AsterError.InvalidRangeError, () => compile(broken, "bad"));
  });
});

/**
 * Construction is a fold and every fragment has one hole, so it is linear in
 * the body and never recurses: a body nested 10⁵ levels deep compiles, its
 * program grows by a constant per level, and the oracle runs it. Rejection is
 * not exercised at this depth: the oracle backtracks through every level, so a
 * rejected input costs it O(depth²) steps. That is the oracle being a
 * backtracker; `VM.test.ts` rejects at this depth.
 */
test("a body nested a hundred thousand levels deep compiles linearly", () => {
  const DEPTH = 100_000;
  const body = deep(DEPTH);
  const program = compile(
    grammar()
      .define("deep", () => body)
      .compose(),
    "deep",
  );

  expect(program.instructions.length).toBeLessThanOrEqual(5 * DEPTH + 8);
  expect(backtrack(program, "ab")).toHaveLength(DEPTH + 2);
  expect(backtrack(program, "xxab")).toHaveLength(DEPTH + 2);
});
