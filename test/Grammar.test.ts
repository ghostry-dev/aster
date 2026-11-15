import {
  AsterError,
  either,
  grammar,
  literal,
  oneOrMore,
  optional,
  range,
  sequence,
  zeroOrMore,
  type Vocabulary,
} from "@ghostry/aster";
import { attest, expect, test } from ".";

test("rules are stored in definition order as name-referenced plain data", () => {
  const composed = grammar()
    .define("digit", () => range("0", "9"))
    .define("year", ({ digit }) => sequence([digit, digit, digit, digit]))
    .compose();

  expect(composed.rules).toEqual([
    { name: "digit", body: { kind: "range", from: "0", to: "9" } },
    {
      name: "year",
      body: {
        kind: "sequence",
        items: [
          { kind: "reference", name: "digit" },
          { kind: "reference", name: "digit" },
          { kind: "reference", name: "digit" },
          { kind: "reference", name: "digit" },
        ],
      },
    },
  ]);
});

test("every combinator produces frozen, JSON-serializable data", () => {
  const composed = grammar()
    .define("a", () => literal("a"))
    .define("b", ({ a }) =>
      sequence([
        either(a, literal("b")),
        optional(a),
        zeroOrMore(a),
        oneOrMore(range("x", "z")),
      ]),
    )
    .compose();

  expect(JSON.parse(JSON.stringify(composed))).toEqual(composed);

  const stack: unknown[] = [composed];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null) continue;
    expect(Object.isFrozen(value)).toBe(true);
    stack.push(...Object.values(value));
  }
});

test("a builder receives references to exactly the earlier rules", () => {
  const seen: Vocabulary[] = [];
  grammar()
    .define("first", (rules) => {
      seen.push(rules);
      return literal("1");
    })
    .define("second", (rules) => {
      seen.push(rules);
      return literal("2");
    })
    .define("third", (rules) => {
      seen.push(rules);
      return literal("3");
    });

  expect(seen.map((rules) => Object.keys(rules))).toEqual([
    [],
    ["first"],
    ["first", "second"],
  ]);
  expect(seen[2]).toEqual({
    first: { kind: "reference", name: "first" },
    second: { kind: "reference", name: "second" },
  });
});

test("a rule named __proto__ is an own reference, not a prototype", () => {
  let rules: Vocabulary = {};
  grammar()
    .define("__proto__", () => literal("p"))
    .define("next", (seen) => {
      rules = seen;
      return literal("n");
    });

  expect(Object.keys(rules)).toEqual(["__proto__"]);
  expect(Object.getPrototypeOf(rules)).toBe(Object.prototype);
});

test("defining a name twice throws DuplicateRuleError naming the rule", () => {
  const base = grammar().define("digit", () => range("0", "9"));

  const error = attest.throws(AsterError.DuplicateRuleError, () =>
    // @ts-expect-error `digit` is already defined; the runtime check is under test
    base.define("digit", () => literal("0")),
  );

  expect(error).toBeInstanceOf(AsterError);
  expect(error.name).toBe("@ghostry/aster:DuplicateRuleError");
  expect(error.rule).toBe("digit");
  expect(error.message).toContain('"digit"');
});

test("builders are immutable, so chains branch from a shared prefix", () => {
  const base = grammar().define("digit", () => range("0", "9"));
  const left = base.define("left", () => literal("l")).compose();
  const right = base.define("right", () => literal("r")).compose();

  expect(base.compose().rules.map((rule) => rule.name)).toEqual(["digit"]);
  expect(left.rules.map((rule) => rule.name)).toEqual(["digit", "left"]);
  expect(right.rules.map((rule) => rule.name)).toEqual(["digit", "right"]);
});
