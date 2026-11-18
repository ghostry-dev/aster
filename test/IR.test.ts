import {
  either,
  grammar,
  literal,
  oneOrMore,
  optional,
  range,
  repeat,
  sequence,
  zeroOrMore,
} from "@ghostry/aster";
import { subexpressions, type Expr } from "@ghostry/aster/unstable-ir";
import { expect, test } from "./index.ts";

const every = grammar()
  .define("digit", () => range("0", "9"))
  .define("sign", () => either(literal("+"), literal("-")))
  .define("number", ({ sign, digit }) =>
    sequence([
      optional(sign),
      oneOrMore(digit),
      zeroOrMore(sequence([literal(","), repeat(digit, { min: 3, max: 3 })])),
      repeat(literal("!"), { min: 2 }),
    ]),
  )
  .compose();

test("a grammar survives a JSON round trip unchanged", () => {
  expect(JSON.parse(JSON.stringify(every))).toStrictEqual(every);
});

test("an unbounded repetition omits max rather than holding undefined", () => {
  const unbounded = repeat(literal("a"), { min: 2 });
  const bounded = repeat(literal("a"), { min: 2, max: 5 });

  expect("max" in unbounded).toBe(false);
  expect("max" in zeroOrMore(literal("a"))).toBe(false);
  expect("max" in oneOrMore(literal("a"))).toBe(false);
  expect(bounded.max).toBe(5);
  expect(zeroOrMore(literal("a")).min).toBe(0);
  expect(oneOrMore(literal("a")).min).toBe(1);
});

test("subexpressions lists direct children in order, never a reference target", () => {
  const a = literal("a");
  const b = range("b", "c");
  const ref: Expr = { kind: "reference", name: "digit" };

  expect(subexpressions(a)).toEqual([]);
  expect(subexpressions(b)).toEqual([]);
  expect(subexpressions(ref)).toEqual([]);
  expect(subexpressions(sequence([a, b, ref]))).toEqual([a, b, ref]);
  expect(subexpressions(either(b, a))).toEqual([b, a]);
  expect(subexpressions(optional(a))).toEqual([a]);
  expect(subexpressions(repeat(b, { min: 1, max: 2 }))).toEqual([b]);
});

test("rules are in definition order, so references only point backward", () => {
  const seen = new Set<string>();
  for (const rule of every.rules) {
    const pending: Expr[] = [rule.body];
    for (let expr = pending.pop(); expr !== undefined; expr = pending.pop()) {
      if (expr.kind === "reference") expect(seen.has(expr.name)).toBe(true);
      pending.push(...subexpressions(expr));
    }
    seen.add(rule.name);
  }
  expect([...seen]).toEqual(["digit", "sign", "number"]);
});
