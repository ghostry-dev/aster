import {
  grammar,
  literal,
  range,
  repeat,
  type AstOf,
  type Node,
} from "@ghostry/aster";
import type { Expr, Kind } from "@ghostry/aster/unstable-ir";

/**
 * Compile-time assertions — see `Grammar.types.test.ts` for why
 * `Equal`/`Expect` are shaped this way.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<_ extends true> = true;

export type KindAssertions = [
  Expect<
    Equal<
      Kind,
      | "literal"
      | "range"
      | "sequence"
      | "either"
      | "optional"
      | "repeat"
      | "reference"
    >
  >,
];

/**
 * The union is closed: a `switch` over `kind` with no default is exhaustive,
 * and a new kind makes the `never` assignment fail to compile here first.
 */
export function describe(expr: Expr): string {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "range":
      return `${expr.from}-${expr.to}`;
    case "sequence":
      return `sequence of ${expr.items.length}`;
    case "either":
      return `either of ${expr.alternatives.length}`;
    case "optional":
      return "optional";
    case "repeat":
      return `${expr.min}..${expr.max ?? "∞"}`;
    case "reference":
      return expr.name;
    default: {
      const unreachable: never = expr;
      return unreachable;
    }
  }
}

const bounded = grammar()
  .define("digit", () => range("0", "9"))
  .define("triple", ({ digit }) => repeat(digit, { min: 3, max: 3 }))
  .define("bangs", () => repeat(literal("!"), { min: 1 }))
  .compose();

/**
 * A bounded repetition still keeps every iteration in an array; the bounds are
 * not reflected in the type.
 */
export type RepeatAssertions = [
  Expect<
    Equal<
      AstOf<typeof bounded, "triple">["children"],
      readonly Node<"digit", string>[]
    >
  >,
  Expect<Equal<AstOf<typeof bounded, "bangs">["children"], readonly "!"[]>>,
];
