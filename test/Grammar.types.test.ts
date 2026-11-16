import {
  either,
  grammar,
  literal,
  oneOrMore,
  optional,
  range,
  sequence,
  toParser,
  zeroOrMore,
  type AstOf,
  type Grammar as AnyGrammar,
  type Node,
  type ParseResult,
  type RuleNames,
  type RuleRef,
} from "@ghostry/aster";

/**
 * Compile-time assertions. `Equal` compares through deferred generic
 * signatures, which distinguishes `any`, `readonly` and optional modifiers that
 * a mutual `extends` check would let through.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<_ extends true> = true;

const date = grammar()
  .define("digit", () => range("0", "9"))
  .define("dash", () => literal("-"))
  .define("year", ({ digit }) => sequence([digit, digit, digit, digit]))
  .define("month", ({ digit }) => sequence([digit, digit]))
  .define("sign", () => either(literal("+"), literal("-")))
  .define("offset", ({ sign, month }) => optional(sequence([sign, month])))
  .define("digits", ({ digit }) => oneOrMore(digit))
  .define("padding", () => zeroOrMore(literal(" ")))
  .define("date", ({ year, dash, month, offset }) =>
    sequence([year, dash, month, offset]),
  )
  .compose();

type Grammar = typeof date;
type DigitNode = Node<"digit", string>;
const parseDate = toParser(date, "date");

export type Assertions = [
  Expect<
    Equal<
      RuleNames<Grammar>,
      | "digit"
      | "dash"
      | "year"
      | "month"
      | "sign"
      | "offset"
      | "digits"
      | "padding"
      | "date"
    >
  >,
  /** literal and range → the matched text. */
  Expect<Equal<AstOf<Grammar, "digit">, DigitNode>>,
  Expect<Equal<AstOf<Grammar, "dash">, Node<"dash", string>>>,
  /** sequence → a tuple; a reference → that rule's node. */
  Expect<
    Equal<
      AstOf<Grammar, "year">,
      Node<"year", readonly [DigitNode, DigitNode, DigitNode, DigitNode]>
    >
  >,
  /** either → the alternative's index beside its value. */
  Expect<
    Equal<
      AstOf<Grammar, "sign">,
      Node<
        "sign",
        | { readonly alternative: 0; readonly value: string }
        | { readonly alternative: 1; readonly value: string }
      >
    >
  >,
  /** optional → the value or undefined. */
  Expect<
    Equal<
      AstOf<Grammar, "offset">["children"],
      readonly [AstOf<Grammar, "sign">, AstOf<Grammar, "month">] | undefined
    >
  >,
  /** repetition → every iteration. */
  Expect<Equal<AstOf<Grammar, "digits">["children"], readonly DigitNode[]>>,
  Expect<Equal<AstOf<Grammar, "padding">["children"], readonly string[]>>,
  /** references compose through several levels. */
  Expect<
    Equal<
      AstOf<Grammar, "date">["children"],
      readonly [
        AstOf<Grammar, "year">,
        Node<"dash", string>,
        AstOf<Grammar, "month">,
        AstOf<Grammar, "offset">,
      ]
    >
  >,
  /** a parser returns the rule's node. */
  Expect<
    Equal<ReturnType<typeof parseDate>, ParseResult<AstOf<Grammar, "date">>>
  >,
  /** a grammar whose shape is not known statically has unknown children. */
  Expect<Equal<AstOf<AnyGrammar, string>, Node<string, unknown>>>,
];

/**
 * Each case here must fail to compile. They sit in a function that never runs,
 * because `bun test` executes this file too and the duplicate would throw.
 */
export function rejected(wide: string): void {
  /** A builder sees only the rules before it, so the graph stays a DAG. */
  grammar()
    .define("early", (rules) => {
      // @ts-expect-error `late` is defined after `early`
      void rules.late;
      return literal("e");
    })
    .define("late", () => literal("l"));

  grammar()
    .define("digit", () => range("0", "9"))
    // @ts-expect-error `digit` is already defined
    .define("digit", () => range("0", "9"));

  // @ts-expect-error a rule name must be a string literal
  grammar().define(wide, () => literal("w"));
}

/**
 * The vocabulary after many links is still one flat object type, not an
 * intersection chain, and each reference is its name alone.
 */
const chain = grammar()
  .define("r0", () => literal("0"))
  .define("r1", ({ r0 }) => sequence([r0, r0]))
  .define("r2", ({ r1 }) => sequence([r1, r1]))
  .define("r3", ({ r2 }) => sequence([r2, r2]))
  .define("r4", ({ r3 }) => sequence([r3, r3]));

type ChainVocabulary = Parameters<Parameters<typeof chain.define>[1]>[0];

/**
 * `Equal` tells `{ a } & { b }` apart from `{ a; b }`, so matching the flat
 * literal below is what shows no intersection built up.
 */
export type FlatAssertions = [
  Expect<
    Equal<
      ChainVocabulary,
      {
        readonly r0: RuleRef<"r0">;
        readonly r1: RuleRef<"r1">;
        readonly r2: RuleRef<"r2">;
        readonly r3: RuleRef<"r3">;
        readonly r4: RuleRef<"r4">;
      }
    >
  >,
];
