import {
  AsterError,
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
import type { Expr } from "@ghostry/aster/unstable-ir";
import { attest, describe, expect, test } from ".";
import { deep } from "./fixtures/deep";

const base = grammar()
  .define("digit", () => range("0", "9"))
  .define("maybe", () => optional(literal("m")));

describe("repetition of an expression that can match nothing", () => {
  const loops: readonly (readonly [string, () => Expr])[] = [
    ["optional body", () => zeroOrMore(optional(literal("a")))],
    ["empty literal", () => oneOrMore(literal(""))],
    ["empty sequence", () => zeroOrMore(sequence([]))],
    ["nested zeroOrMore", () => oneOrMore(zeroOrMore(literal("a")))],
    [
      "minimum-zero repeat",
      () => repeat(repeat(literal("a"), { min: 0, max: 2 }), { min: 1 }),
    ],
    [
      "all-nullable sequence",
      () => zeroOrMore(sequence([optional(literal("a")), literal("")])),
    ],
    [
      "one nullable alternative",
      () => zeroOrMore(either(literal("a"), optional(literal("b")))),
    ],
  ];

  test.each(loops)("is rejected: %s", ({ row: [, body] }) => {
    const error = attest.throws(AsterError.NullableQuantifierError, () =>
      base.define("loop", body),
    );
    expect(error.name).toBe("@ghostry/aster:NullableQuantifierError");
    expect(error.rule).toBe("loop");
    expect(error.combinator).toBe("repeat");
    expect(error.message).toContain('"loop"');
  });

  test("is rejected through a reference to a nullable rule", () => {
    const error = attest.throws(AsterError.NullableQuantifierError, () =>
      base.define("loop", ({ maybe }) => oneOrMore(maybe)),
    );
    expect(error.rule).toBe("loop");
  });

  test("is rejected through a chain of nullable references", () => {
    const error = attest.throws(AsterError.NullableQuantifierError, () =>
      base
        .define("wrapped", ({ maybe }) => sequence([maybe, maybe]))
        .define("loop", ({ wrapped }) => zeroOrMore(wrapped)),
    );
    expect(error.rule).toBe("loop");
  });

  test("is allowed when every iteration consumes input", () => {
    const composed = base
      .define("digits", ({ digit }) => oneOrMore(digit))
      .define("nested", ({ digits }) => zeroOrMore(digits))
      .define("either", ({ digit }) => zeroOrMore(either(digit, literal("x"))))
      .define("mixed", ({ maybe, digit }) =>
        zeroOrMore(sequence([maybe, digit])),
      )
      .define("optionalOutside", () => optional(oneOrMore(literal("a"))))
      .compose();
    expect(composed.rules).toHaveLength(7);
  });
});

/**
 * `?` is a quantifier in the emitted regex, and JS skips an optional whose body
 * matched nothing, which the parser cannot reproduce. Such an `optional` adds
 * nothing to the language, so it is rejected.
 */
describe("optional of an expression that can match nothing", () => {
  const optionals: readonly (readonly [string, () => Expr])[] = [
    ["empty literal", () => optional(literal(""))],
    ["empty sequence", () => optional(sequence([]))],
    ["nested optional", () => optional(optional(literal("a")))],
    ["zeroOrMore", () => optional(zeroOrMore(literal("a")))],
    [
      "one nullable alternative",
      () => optional(either(literal("a"), literal(""))),
    ],
  ];

  test.each(optionals)("is rejected: %s", ({ row: [, body] }) => {
    const error = attest.throws(AsterError.NullableQuantifierError, () =>
      base.define("maybeNothing", body),
    );
    expect(error.name).toBe("@ghostry/aster:NullableQuantifierError");
    expect(error.rule).toBe("maybeNothing");
    expect(error.combinator).toBe("optional");
    expect(error.message).toContain("optional()");
  });

  test("is rejected through a reference to a nullable rule", () => {
    const error = attest.throws(AsterError.NullableQuantifierError, () =>
      base.define("twice", ({ maybe }) => optional(maybe)),
    );
    expect(error.combinator).toBe("optional");
  });

  test("is allowed when the body always consumes input", () => {
    const composed = base
      .define("run", () => optional(oneOrMore(literal("a"))))
      .define("signed", ({ maybe, digit }) =>
        optional(sequence([maybe, digit])),
      )
      .compose();
    expect(composed.rules).toHaveLength(4);
  });
});

describe("range", () => {
  test("accepts endpoints of one code point, including astral ones", () => {
    const composed = grammar()
      .define("emoji", () => range("😀", "😏"))
      .define("same", () => range("a", "a"))
      .compose();
    expect(composed.rules).toHaveLength(2);
  });

  const endpoints: readonly (readonly [string, string])[] = [
    ["ab", "z"],
    ["a", ""],
    ["", "z"],
    ["😀😀", "😏"],
  ];

  test.each(endpoints)("rejects endpoint %p..%p", ({ row: [from, to] }) => {
    const error = attest.throws(AsterError.InvalidRangeError, () =>
      grammar().define("bad", () => range(from, to)),
    );
    expect(error.name).toBe("@ghostry/aster:InvalidRangeError");
    expect(error.rule).toBe("bad");
    expect(error.reason).toBe("endpoint");
    expect([error.from, error.to]).toEqual([from, to]);
  });

  test("rejects a reversed range", () => {
    const error = attest.throws(AsterError.InvalidRangeError, () =>
      grammar().define("bad", () => range("z", "a")),
    );
    expect(error.reason).toBe("order");
    expect(error.message).toContain('"bad"');
  });
});

describe("repetition bounds", () => {
  test("accept exact, ranged, and unbounded counts", () => {
    const composed = grammar()
      .define("exact", () => repeat(literal("a"), { min: 3, max: 3 }))
      .define("ranged", () => repeat(literal("a"), { min: 0, max: 4 }))
      .define("atLeast", () => repeat(literal("a"), { min: 2 }))
      .compose();
    expect(composed.rules).toHaveLength(3);
  });

  const bounds: readonly (readonly [number, number | undefined])[] = [
    [-1, undefined],
    [1.5, undefined],
    [Number.NaN, undefined],
    [0, 0],
    [3, 2],
    [0, 2.5],
    [0, Number.POSITIVE_INFINITY],
  ];

  test.each(bounds)("reject min %p, max %p", ({ row: [min, max] }) => {
    const given = max === undefined ? { min } : { min, max };
    const error = attest.throws(AsterError.InvalidRepetitionError, () =>
      grammar().define("bad", () => repeat(literal("a"), given)),
    );
    expect(error.name).toBe("@ghostry/aster:InvalidRepetitionError");
    expect(error.rule).toBe("bad");
    expect(error.min).toBe(min);
    expect(error.max).toBe(max);
  });
});

describe("bodies assembled by hand", () => {
  test("an either with no alternatives is rejected", () => {
    const error = attest.throws(AsterError.EmptyEitherError, () =>
      // @ts-expect-error `either()` requires an alternative
      grammar().define("bad", () => either()),
    );
    expect(error.name).toBe("@ghostry/aster:EmptyEitherError");
    expect(error.rule).toBe("bad");
  });

  test("a forward reference is rejected", () => {
    const error = attest.throws(AsterError.UnknownReferenceError, () =>
      grammar().define(
        "early",
        () => ({ kind: "reference", name: "late" }) as const,
      ),
    );
    expect(error.name).toBe("@ghostry/aster:UnknownReferenceError");
    expect(error.rule).toBe("early");
    expect(error.reference).toBe("late");
  });

  test("a self-reference is rejected, so no grammar is recursive", () => {
    const error = attest.throws(AsterError.UnknownReferenceError, () =>
      grammar().define("self", () =>
        sequence([literal("("), { kind: "reference", name: "self" } as const]),
      ),
    );
    expect(error.reference).toBe("self");
  });

  const values: readonly (readonly [string, unknown])[] = [
    ["an unknown kind", { kind: "bogus" }],
    ["null", null],
    ["a string", "a"],
  ];

  test.each(values)("%s is rejected", ({ row: [, value] }) => {
    const error = attest.throws(AsterError.InvalidExpressionError, () =>
      grammar().define("bad", () => sequence([value as unknown as Expr])),
    );
    expect(error.name).toBe("@ghostry/aster:InvalidExpressionError");
    expect(error.rule).toBe("bad");
    expect(error.value).toBe(value);
  });
});

test("a rejected definition leaves the builder usable", () => {
  attest.throws(AsterError.NullableQuantifierError, () =>
    base.define("loop", ({ maybe }) => zeroOrMore(maybe)),
  );
  const composed = base
    .define("loop", ({ digit }) => zeroOrMore(digit))
    .compose();
  expect(composed.rules.map((rule) => rule.name)).toEqual([
    "digit",
    "maybe",
    "loop",
  ]);
});

/**
 * The check walks a body with an explicit stack, so nesting depth is bounded by
 * memory, not the call stack. A recursive walk overflows long before this.
 */
describe("deep nesting", () => {
  const DEPTH = 100_000;

  test("a body nested a hundred thousand levels is checked", () => {
    const body = deep(DEPTH);
    expect(
      grammar()
        .define("deep", () => body)
        .compose().rules,
    ).toHaveLength(1);
  });

  test("a violation at the bottom of a deep body is still found", () => {
    let body: Expr = zeroOrMore(literal(""));
    for (let level = 0; level < DEPTH; level += 1) body = sequence([body]);
    attest.throws(AsterError.NullableQuantifierError, () =>
      grammar().define("deep", () => body),
    );
  });
});
