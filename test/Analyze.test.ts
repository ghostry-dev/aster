import {
  AsterError,
  either,
  grammar,
  initialize,
  literal,
  oneOrMore,
  optional,
  range,
  repeat,
  sequence,
  zeroOrMore,
  type Analysis,
  type Attack,
  type Grammar,
  type RuleNames,
} from "@ghostry/aster";
import type { Expr } from "@ghostry/aster/unstable-ir";
import { checkSync } from "recheck";
import { attest, describe, expect, test } from ".";
import { deep } from "./fixtures/deep";
import { realistic } from "./stress/Realistic";

const { analyze, toPattern, toRegExp, toParser } = initialize({
  allowedComplexity: "exponential",
});

const a = literal("a");
const b = literal("b");

const shapes = grammar()
  .define("letters", () => oneOrMore(range("a", "z")))
  .define("separated", () => sequence([zeroOrMore(a), b, zeroOrMore(a)]))
  .define("anchoredTail", () => sequence([zeroOrMore(a), b]))
  .define("collapsed", () =>
    zeroOrMore(either(range("a", "c"), range("b", "d"))),
  )
  .define("same", () => zeroOrMore(either(a, a)))
  .define("counted", () =>
    zeroOrMore(
      sequence([repeat(literal("ab"), { min: 0, max: 2 }), literal("c")]),
    ),
  )
  .define("twoLoops", () => sequence([zeroOrMore(a), zeroOrMore(a)]))
  .define("threeLoops", () =>
    sequence([zeroOrMore(a), zeroOrMore(a), zeroOrMore(a)]),
  )
  .define("nested", () => oneOrMore(oneOrMore(a)))
  .define("overlapping", () =>
    sequence([zeroOrMore(either(a, literal("aa"))), b]),
  )
  .define("emptyAlternatives", () =>
    zeroOrMore(sequence([either(literal(""), literal("")), a])),
  )
  .define("word", () => oneOrMore(range("a", "z")))
  .define("words", ({ word }) => zeroOrMore(either(word, literal(" "))))
  .define("line", ({ words }) => sequence([literal(">"), words]))
  /**
   * Exponential work before an empty match: the optional body is tried first,
   * so even a search, which succeeds with the empty match, pays for it.
   */
  .define("early", () => optional(sequence([oneOrMore(oneOrMore(a)), b])))
  /**
   * The same behind a `>`. From the `>`, the engine succeeds, by the empty
   * match, but only after the exponential work: a branch that succeeds is still
   * explored up to its success.
   */
  .define("prefixed", () =>
    sequence([literal(">"), optional(sequence([oneOrMore(oneOrMore(a)), b]))]),
  )
  /**
   * Safe only as a search: wherever the slow branch could start, the first
   * branch matches first. Anchored, the first branch fails at the end and the
   * engine falls through to the slow one.
   */
  .define("guarded", () =>
    either(a, sequence([zeroOrMore(either(a, literal("aa"))), b])),
  )
  /**
   * As a search on `aⁿ(ba)ⁿ`, every offset before the first `b` runs the
   * failing first branch in full, quadratic in the `(ba)` loops, before the
   * search moves on and matches the `b`: cubic, though the search loop itself
   * succeeds. Every input that makes the search loop fail lacks a `b`, so the
   * degree is only visible through a loop that succeeds.
   */
  .define("retried", () =>
    either(
      sequence([
        zeroOrMore(a),
        zeroOrMore(literal("ba")),
        zeroOrMore(literal("ba")),
        literal("c"),
      ]),
      b,
    ),
  )
  /**
   * Accepts every code point, so no single character makes it fail: the
   * attack's suffix has to come from the look-ahead.
   */
  .define("anything", () =>
    sequence([
      zeroOrMore(either(a, literal("aa"))),
      range("\u0000", "\u{10FFFF}"),
    ]),
  )
  .compose();

type Shape = RuleNames<typeof shapes>;

describe("verdicts", () => {
  const cases: readonly (readonly [
    Shape,
    Analysis["complexity"],
    number,
    string,
  ])[] = [
    /** A single loop, or loops a separator keeps apart. */
    ["letters", "linear", 0, ""],
    ["separated", "linear", 0, ""],
    ["anchoredTail", "linear", 0, ""],
    /**
     * Overlapping alternatives of one character collapse into one class, so the
     * engine has one path; `same` is `a*`.
     */
    ["collapsed", "linear", 0, ""],
    ["same", "linear", 0, ""],
    /**
     * A counter takes each count one way: `(?:ab){0,2}` is `(?:ab(?:ab)?)?`,
     * never `(?:ab)?(?:ab)?`, which would split `ab` two ways per iteration.
     */
    ["counted", "linear", 0, ""],
    /** Adjacent loops over the same characters. */
    ["twoLoops", "polynomial", 2, "twoLoops"],
    ["threeLoops", "polynomial", 3, "threeLoops"],
    /** Loops that can split one run of input many ways. */
    ["nested", "exponential", 0, "nested"],
    ["overlapping", "exponential", 0, "overlapping"],
    /** Two empty alternatives are two paths the engine tries. */
    ["emptyAlternatives", "exponential", 0, "emptyAlternatives"],
    /** The finding names the innermost rule holding the ambiguity. */
    ["line", "exponential", 0, "words"],
    ["early", "exponential", 0, "early"],
    ["prefixed", "exponential", 0, "prefixed"],
    ["guarded", "exponential", 0, "guarded"],
    ["anything", "exponential", 0, "anything"],
  ];

  test.each(cases)("%s is %s", ({ row: [rule, complexity, degree, where] }) => {
    const found = analyze(shapes, rule);
    expect(found.complexity).toBe(complexity);
    if (found.complexity === "linear") return;
    expect(found.rule).toBe(where);
    if (found.complexity === "polynomial") expect(found.degree).toBe(degree);
  });

  /**
   * A search stops at its first match, so an ambiguity only costs time where
   * every path through it fails. A search also retries at every offset, which
   * adds a degree where nothing matches: `a*b` is linear anchored and quadratic
   * as a search.
   */
  const searches: readonly (readonly [
    Shape,
    Analysis["complexity"],
    number,
  ])[] = [
    ["letters", "linear", 0],
    ["twoLoops", "linear", 0],
    ["nested", "linear", 0],
    ["guarded", "linear", 0],
    ["anything", "linear", 0],
    ["anchoredTail", "polynomial", 2],
    ["early", "exponential", 0],
    ["prefixed", "exponential", 0],
    ["retried", "polynomial", 3],
  ];

  test.each(searches)(
    "as a search, %s is %s",
    ({ row: [rule, complexity, degree] }) => {
      const found = analyze(shapes, rule, { anchored: false });
      expect(found.complexity).toBe(complexity);
      if (found.complexity === "linear") return;
      expect(found.exact).toBe(true);
      if (found.complexity === "polynomial") expect(found.degree).toBe(degree);
    },
  );

  test("every rule of the realistic grammar is linear", () => {
    const slow = realistic.rules
      .filter(({ name }) => analyze(realistic, name).complexity !== "linear")
      .map(({ name }) => name);
    expect(slow).toEqual([]);
  });
});

/**
 * Run `regex` on the attack with the pump repeated `n` times, growing `n` until
 * one match takes longer than `threshold` milliseconds or `n` passes `limit`.
 * `grow` is how `n` increases: by a little for an exponential pattern, so one
 * step can never hang the test, and by doubling for a polynomial one.
 */
function slowsAt(
  regex: RegExp,
  { prefix, pump, suffix }: Attack,
  grow: (n: number) => number,
  limit: number,
  threshold = 25,
): number | undefined {
  for (let n = 1; n <= limit; n = grow(n)) {
    const input = prefix + pump.repeat(n) + suffix;
    const started = performance.now();
    regex.test(input);
    if (performance.now() - started > threshold) return n;
  }
  return undefined;
}

/**
 * The attack strings are real: the engine's time blows up on them, at sizes
 * where a linear pattern would take microseconds, and the parser stays fast.
 */
describe("attacks", () => {
  const vulnerable = (rule: Shape, anchored = true): Attack => {
    const found = analyze(shapes, rule, { anchored });
    if (found.complexity === "linear") throw new Error(`${rule} is linear`);
    return found.attack;
  };

  test.each([
    "nested",
    "overlapping",
    "emptyAlternatives",
    "line",
    "early",
    "anything",
  ] as const)("%s is exponential in the engine", ({ row: rule }) => {
    const attack = vulnerable(rule);
    const regex = toRegExp(shapes, rule);
    expect(slowsAt(regex, attack, (n) => n + 1, 60)).toBeDefined();
    const parse = toParser(shapes, rule);
    const started = performance.now();
    parse(attack.prefix + attack.pump.repeat(10_000) + attack.suffix);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("twoLoops is superlinear in the engine", () => {
    const attack = vulnerable("twoLoops");
    expect(
      slowsAt(toRegExp(shapes, "twoLoops"), attack, (n) => n * 2, 1 << 20),
    ).toBeDefined();
  });

  test("as a search, early is exponential in the engine", () => {
    const attack = vulnerable("early", false);
    const regex = toRegExp(shapes, "early", { anchored: false });
    expect(slowsAt(regex, attack, (n) => n + 1, 60)).toBeDefined();
  });

  test("as a search, retried is superlinear in the engine", () => {
    const attack = vulnerable("retried", false);
    const regex = toRegExp(shapes, "retried", { anchored: false });
    expect(slowsAt(regex, attack, (n) => n * 2, 1 << 20)).toBeDefined();
  });

  test("as a search, anchoredTail is superlinear in the engine", () => {
    const attack = vulnerable("anchoredTail", false);
    const regex = toRegExp(shapes, "anchoredTail", { anchored: false });
    expect(slowsAt(regex, attack, (n) => n * 2, 1 << 20)).toBeDefined();
  });

  test("a linear pattern does not slow on the same input", () => {
    const attack = vulnerable("twoLoops");
    expect(
      slowsAt(toRegExp(shapes, "letters"), attack, (n) => n * 2, 1 << 20),
    ).toBeUndefined();
  });
});

/**
 * recheck is an independent ReDoS checker, with an automaton-based mode that
 * models match priority the way the analysis does, so the two must agree
 * exactly, anchored and as a search. As a search the priority-free fallback
 * disagrees: an unanchored `[a-z]+` stops at its first match, and only priority
 * shows it, so the fallback reports the search loop's extra degree.
 *
 * recheck takes seconds on patterns of several hundred characters, so the
 * realistic grammar is compared on its shorter rules.
 */
describe("agreement with recheck", () => {
  const severity = (complexity: string): number =>
    complexity === "exponential" ? 2 : complexity === "polynomial" ? 1 : 0;

  /**
   * `[ours, recheck's]` as severity and degree, or `undefined` if recheck gave
   * no answer.
   */
  const compare = (
    grammar: Grammar,
    rule: string,
    anchored: boolean,
    instance = initialize({ allowedComplexity: "exponential" }),
  ) => {
    const mine: Analysis = instance.analyze(grammar, rule, { anchored });
    const pattern = toPattern(grammar, rule, { anchored });
    const theirs = checkSync(pattern, "u", { checker: "automaton" });
    if (theirs.status === "unknown") return undefined;
    return {
      rule,
      anchored,
      ours: [
        severity(mine.complexity),
        mine.complexity === "polynomial" ? mine.degree : 0,
      ],
      theirs: [
        severity(theirs.complexity.type),
        theirs.complexity.type === "polynomial" ? theirs.complexity.degree : 0,
      ],
    };
  };
  const differs = (result: ReturnType<typeof compare>): boolean =>
    result !== undefined
    && JSON.stringify(result.ours) !== JSON.stringify(result.theirs);
  const unsound = (result: ReturnType<typeof compare>): boolean =>
    result !== undefined
    && (result.ours[0] ?? 0) * 100 + (result.ours[1] ?? 0)
      < (result.theirs[0] ?? 0) * 100 + (result.theirs[1] ?? 0);

  test.each([true, false])("anchored: %p, every shape agrees", ({ row }) => {
    const results = shapes.rules.map(({ name }) => compare(shapes, name, row));
    expect(results.filter(differs)).toEqual([]);
  });

  test("the realistic grammar's shorter rules agree, anchored and as searches", () => {
    const results = realistic.rules
      .filter(({ name }) => toPattern(realistic, name).length < 200)
      .flatMap(({ name }) => [
        compare(realistic, name, true),
        compare(realistic, name, false),
      ]);
    expect(results.filter(differs)).toEqual([]);
    expect(
      results.filter((result) => result !== undefined).length,
    ).toBeGreaterThan(80);
  });

  test("without the exact pass, a search is at least as severe", () => {
    const sound = initialize({
      allowedComplexity: "exponential",
      analysisBudget: 0,
    });
    const results = shapes.rules.map(({ name }) =>
      compare(shapes, name, false, sound),
    );
    expect(results.filter(unsound)).toEqual([]);
    expect(results.filter(differs).length).toBeGreaterThan(0);
  });
});

describe("allowedComplexity", () => {
  test("by default, any superlinear pattern throws", () => {
    const strict = initialize();
    const error = attest.throws(AsterError.VulnerablePatternError, () =>
      strict.toPattern(shapes, "twoLoops"),
    );
    expect(error.name).toBe("@ghostry/aster:VulnerablePatternError");
    expect(error.rule).toBe("twoLoops");
    expect(error.analysis).toMatchObject({
      complexity: "polynomial",
      degree: 2,
    });
    expect(error.message).toContain('rule "twoLoops"');
    expect(error.message).toContain("toParser()");
    attest.throws(AsterError.VulnerablePatternError, () =>
      strict.toRegExp(shapes, "nested"),
    );
    expect(strict.toPattern(shapes, "letters")).toBe("^[a-z]+$");
  });

  test("the message names an inner rule where the ambiguity is", () => {
    const error = attest.throws(AsterError.VulnerablePatternError, () =>
      initialize().toPattern(shapes, "line"),
    );
    expect(error.message).toContain("exponential time");
    expect(error.message).toContain('in rule "words"');
  });

  test('"polynomial" allows polynomial patterns but not exponential ones', () => {
    const relaxed = initialize({ allowedComplexity: "polynomial" });
    expect(relaxed.toPattern(shapes, "twoLoops")).toBe("^a*a*$");
    attest.throws(AsterError.VulnerablePatternError, () =>
      relaxed.toPattern(shapes, "nested"),
    );
  });

  test('"exponential" allows everything, and analyze reports either way', () => {
    const open = initialize({ allowedComplexity: "exponential" });
    expect(open.toPattern(shapes, "nested")).toBe("^(?:a+)+$");
    expect(initialize().analyze(shapes, "nested").complexity).toBe(
      "exponential",
    );
  });

  test("a search is judged as a search", () => {
    const strict = initialize();
    expect(strict.toPattern(shapes, "anchoredTail")).toBe("^a*b$");
    attest.throws(AsterError.VulnerablePatternError, () =>
      strict.toPattern(shapes, "anchoredTail", { anchored: false }),
    );
  });

  test("the parser is available for every grammar", () => {
    const parse = initialize().toParser(shapes, "nested");
    expect(parse("aaa").ok).toBe(true);
  });

  test("an unknown setting throws rather than falling back", () => {
    const error = attest.throws(AsterError.InvalidConfigError, () =>
      // @ts-expect-error `sometimes` is not a setting
      initialize({ allowedComplexity: "sometimes" }),
    );
    expect(error.name).toBe("@ghostry/aster:InvalidConfigError");
    expect([error.option, error.value]).toEqual([
      "allowedComplexity",
      "sometimes",
    ]);
  });
});

/**
 * `(?:a[ab]{n}a|a|b)*`: whether a state inside the counter succeeds depends on
 * which of the next `n` characters are `a`, so the look-ahead needs about 2ⁿ
 * states. Exact for `n = 10` takes about 10⁵ steps.
 */
const blowup = (n: number) =>
  grammar()
    .define("blowup", () =>
      zeroOrMore(
        either(
          sequence([a, repeat(either(a, b), { min: n, max: n }), a]),
          a,
          b,
        ),
      ),
    )
    .compose();

describe("analysisBudget", () => {
  test("past the default budget, the priority-free finding stands, quickly", () => {
    const started = performance.now();
    const found = analyze(blowup(16), "blowup");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(found).toMatchObject({ complexity: "exponential", exact: false });
    const error = attest.throws(AsterError.VulnerablePatternError, () =>
      initialize().toPattern(blowup(16), "blowup"),
    );
    expect(error.analysis.exact).toBe(false);
    expect(error.message).toContain("analysisBudget");
  });

  test("a larger budget makes the same finding exact", () => {
    const grammar = blowup(10);
    const small = initialize({ analysisBudget: 50_000 });
    const large = initialize({ analysisBudget: 200_000 });
    expect(small.analyze(grammar, "blowup")).toMatchObject({ exact: false });
    expect(large.analyze(grammar, "blowup")).toMatchObject({ exact: true });
    expect(
      initialize({ analysisBudget: Infinity }).analyze(grammar, "blowup"),
    ).toMatchObject({ exact: true });
  });

  test("an exact finding's message does not mention the budget", () => {
    const error = attest.throws(AsterError.VulnerablePatternError, () =>
      initialize().toPattern(shapes, "nested"),
    );
    expect(error.analysis.exact).toBe(true);
    expect(error.message).not.toContain("analysisBudget");
  });

  test("0 skips the exact pass", () => {
    const sound = initialize({ analysisBudget: 0 });
    expect(sound.analyze(shapes, "letters", { anchored: false })).toMatchObject(
      { complexity: "polynomial", degree: 2, exact: false },
    );
    expect(analyze(shapes, "letters", { anchored: false }).complexity).toBe(
      "linear",
    );
  });

  test.each([-1, 1.5, Number.NaN, -Infinity, "10"] as const)(
    "%p throws rather than falling back",
    ({ row }) => {
      const error = attest.throws(AsterError.InvalidConfigError, () =>
        // @ts-expect-error a string is not a budget
        initialize({ analysisBudget: row }),
      );
      expect(error.option).toBe("analysisBudget");
      expect(error.value).toBe(row);
    },
  );
});

describe("caching", () => {
  test("a composed grammar's analysis is computed once", () => {
    const instance = initialize();
    expect(instance.analyze(shapes, "nested")).toBe(
      instance.analyze(shapes, "nested"),
    );
  });

  test("define freezes a hand-built body, so the cache cannot go stale", () => {
    const body = { kind: "literal", value: "a" } as const;
    const composed = grammar()
      .define("rule", () => body)
      .compose();
    expect(Object.isFrozen(composed.rules[0]?.body)).toBe(true);
  });

  test("a grammar that arrived as data is analyzed every time", () => {
    const instance = initialize({ allowedComplexity: "exponential" });
    const data = JSON.parse(JSON.stringify(shapes)) as Grammar;
    expect(instance.analyze(data, "letters").complexity).toBe("linear");
    const letters = data.rules.find(({ name }) => name === "letters");
    if (letters === undefined) throw new Error("no letters");
    Object.assign(letters, { body: oneOrMore(oneOrMore(range("a", "z"))) });
    expect(instance.analyze(data, "letters").complexity).toBe("exponential");
  });
});

/**
 * The analysis walks the pattern with explicit stacks and computes ε-closures
 * only where a search needs them, so a body nested 10⁵ levels deep analyzes,
 * and the run of 10⁵ optionals in `deep` costs linear time rather than the
 * quadratic number of skip edges it has.
 */
describe("size", () => {
  test("a body nested a hundred thousand levels deep is analyzed", () => {
    const body = deep(100_000);
    const composed = grammar()
      .define("deep", () => body)
      .compose();
    expect(initialize().analyze(composed, "deep").complexity).toBe("linear");
  });

  test("so is one nested a hundred thousand groups deep", () => {
    let body: Expr = literal("b");
    for (let level = 0; level < 100_000; level += 1)
      body = optional(sequence([a, body]));
    const nested = body;
    const composed = grammar()
      .define("nested", () => nested)
      .compose();
    expect(initialize().analyze(composed, "nested").complexity).toBe("linear");
  });
});
