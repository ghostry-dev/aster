/**
 * Type-only: the expression vocabulary combinators build, the flat union of
 * rule definitions `.define()` accumulates, and the AST types inferred from
 * them. No runtime code lives here; a value export is a module-kind change.
 *
 * @module
 */

/**
 * An exact string. Its children are the matched text.
 */
export interface Literal {
  readonly kind: "literal";
  readonly value: string;
}

/**
 * One code point between `from` and `to`, inclusive. Its children are the
 * matched text.
 */
export interface Range {
  readonly kind: "range";
  readonly from: string;
  readonly to: string;
}

/**
 * Each item in order. Its children are a tuple with one entry per item.
 */
export interface Sequence<$Items extends readonly Expr[] = readonly Expr[]> {
  readonly kind: "sequence";
  readonly items: $Items;
}

/**
 * Any alternative that leads to a match. Where several do, the earliest is
 * preferred, as in JS regex. Its children record which alternative matched,
 * since two alternatives with the same child type could not otherwise be told
 * apart.
 */
export interface Either<
  $Alternatives extends readonly Expr[] = readonly Expr[],
> {
  readonly kind: "either";
  readonly alternatives: $Alternatives;
}

/**
 * The body or nothing, preferring the body.
 */
export interface Optional<$Body extends Expr = Expr> {
  readonly kind: "optional";
  readonly body: $Body;
}

/**
 * The body at least `min` and at most `max` times, greedily; no `max` means
 * unbounded. Every iteration is kept in the children, unlike a regex capture
 * inside a loop.
 *
 * One kind with bounds rather than a kind per quantifier, so `{m,n}` needs no
 * new kind and a consumer handles every quantifier in one branch. `optional`
 * stays its own kind, because its children (`A | undefined`) differ from a
 * repetition's (`A[]`). An absent `max` is omitted rather than `undefined`, so
 * the node survives a JSON round trip unchanged.
 */
export interface Repeat<$Body extends Expr = Expr> {
  readonly kind: "repeat";
  readonly body: $Body;
  readonly min: number;
  readonly max?: number;
}

/**
 * A reference to a named rule defined earlier in the same grammar: its name and
 * nothing else, at the type level as at runtime.
 *
 * Carrying the referenced body as a type argument would make every reference's
 * type contain the bodies of everything it reaches, so a grammar whose rules
 * each reference two earlier ones grows types shaped like the reference DAG
 * unfolded into a tree. At a hundred such rules that costs seconds of checking
 * for the `.define()` chain alone; by name, it costs milliseconds. Bodies are
 * looked up by name from the grammar's {@link RuleDefinition} union when an AST
 * type is asked for.
 */
export interface RuleRef<$Name extends string = string> {
  readonly kind: "reference";
  readonly name: $Name;
}

/**
 * Every expression a rule body can be built from. Closed, so a consumer can
 * switch on `kind` exhaustively.
 */
export type Expr =
  | Literal
  | Range
  | Sequence
  | Either
  | Optional
  | Repeat
  | RuleRef;

/**
 * One defined rule. At runtime a grammar stores these in definition order; at
 * the type level a grammar is the union of them.
 */
export interface RuleDefinition<
  $Name extends string = string,
  $Body extends Expr = Expr,
> {
  readonly name: $Name;
  readonly body: $Body;
}

/**
 * The rules a builder can see: a reference for each rule defined so far, keyed
 * by name.
 *
 * A grammar accumulates a flat **union** of definitions, never a chain of
 * object types. A union is flattened as it is built, so the hundredth rule's
 * vocabulary is one key-remapped mapped type over a hundred members, one level
 * deep. Accumulating `{ [K in keyof Previous | Name]: … }` instead looks flat
 * but is represented as a chain of deferred mapped types, one per link, and
 * reading the keys of the last one walks every link: about fifty rules is
 * enough to overrun the checker's instantiation depth limit (TS2589).
 */
export type Vocabulary<$Rules extends RuleDefinition = RuleDefinition> = {
  readonly [R in $Rules as R["name"]]: RuleRef<R["name"]>;
};

/**
 * What `.define()` accepts as a name: a string literal not already defined. A
 * rejected name intersects the argument with a message, which is what the
 * compiler then shows.
 */
export type RuleName<
  $Name extends string,
  $Rules extends RuleDefinition,
> = string extends $Name
  ? "rule names must be string literals"
  : $Name extends $Rules["name"]
    ? `rule "${$Name}" is already defined`
    : unknown;

/**
 * The chain `grammar()` starts. Each builder sees only the rules defined before
 * it, so the rule graph is a DAG by construction and every grammar is regular.
 */
export interface GrammarBuilder<$Rules extends RuleDefinition = never> {
  /**
   * Add a rule. `build` receives references to every earlier rule and returns
   * the new rule's body.
   */
  define<$Name extends string, $Body extends Expr>(
    name: $Name & RuleName<$Name, $Rules>,
    build: (rules: Vocabulary<$Rules>) => $Body,
  ): GrammarBuilder<$Rules | RuleDefinition<$Name, $Body>>;

  /**
   * Finish the grammar.
   */
  compose(): Grammar<$Rules>;
}

/**
 * A finished grammar. `rules` is in definition order, which is also a
 * topological order of the reference graph, so any per-rule pass is one forward
 * loop. Its element type is the union of every definition, which is all the
 * type level knows about the grammar.
 */
export interface Grammar<$Rules extends RuleDefinition = RuleDefinition> {
  readonly rules: readonly $Rules[];
}

/**
 * A place in the input as a person counts it: a 1-based line, ending at `\n`,
 * `\r\n`, or a lone `\r`, and a 1-based column counted in code points, so an
 * astral character is one column.
 */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/**
 * A half-open range in the input, as UTF-16 offsets. `position()` gives both
 * ends as lines and columns, computed on demand, so the common case pays
 * nothing for them.
 */
export interface Span {
  readonly start: number;
  readonly end: number;

  /**
   * Where the span starts and ends. `end` is just past the last code point, as
   * the offset is, so a span that ends with a line break ends at column 1 of
   * the next line, and an empty span starts and ends at the same place.
   */
  position(): { readonly start: Position; readonly end: Position };
}

/**
 * A parsed occurrence of a named rule. Offsets are UTF-16 code unit offsets
 * into the original input, so `input.slice(start, end)` is O(1).
 */
export interface Node<$Name extends string, $Children> {
  readonly rule: $Name;
  readonly span: Span;
  readonly text: string;
  readonly children: $Children;
}

/**
 * Each rule's body by name. One mapped type per grammar, so looking a body up
 * is a property read rather than a distribution over every definition.
 */
type Bodies<$Rules extends RuleDefinition> = {
  readonly [R in $Rules as R["name"]]: R["body"];
};

/**
 * The body of the rule named `$Name`. The `infer` restates what `.define()`
 * already guaranteed, which the checker cannot see through the mapped type.
 */
type BodyOf<
  $Rules extends RuleDefinition,
  $Name extends string,
> = Bodies<$Rules>[$Name & keyof Bodies<$Rules>] extends infer $Body extends
  Expr
  ? $Body
  : never;

/**
 * The children an expression contributes to the nearest enclosing named rule,
 * with references resolved against `$Rules`. Anonymous combinators produce no
 * node of their own; a reference produces the referenced rule's node.
 *
 * An expression typed as the whole {@link Expr} union, as a body built in a
 * loop or a grammar that arrived as data is, has `unknown` children. Its shape
 * is not known statically, and inferring through `Sequence<readonly Expr[]>`
 * would never terminate.
 */
export type Children<
  $Expr extends Expr,
  $Rules extends RuleDefinition,
> = Expr extends $Expr
  ? unknown
  : $Expr extends RuleRef<infer $Name>
    ? Node<$Name, Children<BodyOf<$Rules, $Name>, $Rules>>
    : $Expr extends Literal | Range
      ? string
      : $Expr extends Sequence<infer $Items>
        ? { readonly [I in keyof $Items]: Children<$Items[I], $Rules> }
        : $Expr extends Optional<infer $Body>
          ? Children<$Body, $Rules> | undefined
          : $Expr extends Repeat<infer $Body>
            ? readonly Children<$Body, $Rules>[]
            : $Expr extends Either<infer $Alternatives>
              ? Alternative<$Alternatives, $Rules>
              : never;

/**
 * `{ alternative: i, value }` for each alternative `i`, as one union.
 */
type Alternative<
  $Alternatives extends readonly Expr[],
  $Rules extends RuleDefinition,
> = {
  [I in keyof $Alternatives]: {
    readonly alternative: I extends `${infer $Index extends number}`
      ? $Index
      : never;
    readonly value: Children<$Alternatives[I], $Rules>;
  };
}[number];

/**
 * The names of a grammar's rules.
 */
export type RuleNames<$Grammar extends Grammar> =
  $Grammar extends Grammar<infer $Rules> ? $Rules["name"] : never;

/**
 * The AST node a rule produces, inferred only when asked.
 *
 * {@link Children} and {@link AstOf} spell out `Node<…>` rather than naming
 * this alias. The checker prints a type through the alias it was reached by,
 * and this alias's first argument is the grammar's entire definition union, so
 * hovers and emitted declarations would show that union instead of the tree.
 */
export type Ast<$Rules extends RuleDefinition, $Name extends string> = Node<
  $Name,
  Children<BodyOf<$Rules, $Name>, $Rules>
>;

/**
 * The AST node a grammar's rule produces.
 */
export type AstOf<$Grammar extends Grammar, $Name extends RuleNames<$Grammar>> =
  $Grammar extends Grammar<infer $Rules>
    ? Node<$Name, Children<BodyOf<$Rules, $Name>, $Rules>>
    : never;

/**
 * A successful parse: the root rule's node.
 */
export interface ParseSuccess<$Node> {
  readonly ok: true;
  readonly node: $Node;
}

/**
 * Something a parse could have continued with at the point it failed.
 *
 * - `rule`: a named rule that would have started there. Where several rules start
 *   at that offset, one inside another, the outermost is reported: a date's
 *   `month`, not the `digit` that begins it.
 * - `characters`: one code point from these inclusive ranges, where no named rule
 *   starts at that offset, such as the `-` between a year and a month. Ranges
 *   are sorted and merged across everything anonymous that was expected, so
 *   there is at most one such entry.
 * - `end`: the end of the input. A complete match was found, but the input
 *   continues.
 */
export type Expectation =
  | { readonly kind: "rule"; readonly rule: string }
  | {
      readonly kind: "characters";
      readonly ranges: readonly (readonly [string, string])[];
    }
  | { readonly kind: "end" };

/**
 * A failed parse, reported at the furthest offset any derivation reached.
 *
 * `span` starts there and covers the code point found, so it is empty when the
 * input ran out. `expected` lists what could have come next, in the order the
 * grammar prefers them, without duplicates. `message` says the same for a
 * person, with a 1-based line and a column counted in code points.
 */
export interface ParseFailure {
  readonly ok: false;
  readonly span: Span;
  readonly expected: readonly Expectation[];
  readonly message: string;
}

/**
 * What a {@link Parser} returns. A failure is a value, not an exception: an
 * input that does not match is an expected outcome, not an error.
 */
export type ParseResult<$Node> = ParseSuccess<$Node> | ParseFailure;

/**
 * A compiled parser for one rule. It accepts exactly the strings the rule's
 * anchored regex accepts, and picks the derivation that regex would.
 */
export type Parser<$Node> = (input: string) => ParseResult<$Node>;

/**
 * Options for `toPattern`, `toRegExp`, and `analyze`.
 */
export interface PatternOptions {
  /**
   * Whether the pattern must match the whole input: `^(?:…)$`. Defaults to
   * `true`, which is what the parser accepts and what a JSON Schema `pattern`
   * needs to mean "is a valid X" rather than "contains a valid X". Set it to
   * `false` to search for a match inside a longer string. A search retries at
   * every offset, so it can be slower than the anchored pattern: `a*b` is
   * linear anchored and quadratic as a search.
   */
  readonly anchored?: boolean;
}

/**
 * An input that drives a pattern's worst case: `prefix`, then `pump` repeated,
 * then `suffix`. The suffix makes every path through the pumped part fail, so a
 * backtracking engine tries them all before giving up or finding a match.
 */
export interface Attack {
  readonly prefix: string;
  readonly pump: string;
  readonly suffix: string;
}

/**
 * How long a backtracking regex engine can take on a rule's pattern, as a
 * function of input length, from the static analysis `analyze` runs.
 *
 * - `linear`: no input makes the engine try more than a bounded number of paths
 *   per character.
 * - `polynomial`: some input makes it take time proportional to `nᵈᵉᵍʳᵉᵉ`.
 * - `exponential`: some input makes each repetition of `attack.pump` double the
 *   work.
 *
 * `rule` is the innermost named rule containing the ambiguity, which is where
 * to rewrite. `exact` says whether the finding accounts for the engine stopping
 * at the first match it finds: a search stops there, so an ambiguity costs time
 * only where every path through it fails. An exact finding is what a
 * backtracking engine does. One that is not, because the pattern was too large
 * to analyze exactly within `analysisBudget`, assumes every path fails: it
 * never misses a slow pattern, but it can report one a real engine always
 * matches quickly. A linear verdict is always exact.
 */
export type Analysis =
  | { readonly complexity: "linear" }
  | {
      readonly complexity: "polynomial";
      readonly degree: number;
      readonly rule: string;
      readonly attack: Attack;
      readonly exact: boolean;
    }
  | {
      readonly complexity: "exponential";
      readonly rule: string;
      readonly attack: Attack;
      readonly exact: boolean;
    };

/**
 * A finding: an {@link Analysis} that is not linear.
 */
export type Vulnerability = Exclude<
  Analysis,
  { readonly complexity: "linear" }
>;

/**
 * What `initialize` accepts. Every field is optional.
 */
export interface Config {
  /**
   * The slowest a pattern from `toPattern` or `toRegExp` may be in a
   * backtracking regex engine, on the scale `analyze` reports. A slower one
   * throws `VulnerablePatternError` instead. Defaults to `"linear"`, which
   * rejects any superlinear pattern. `"polynomial"` rejects only exponential
   * ones, and `"exponential"`, the worst there is, turns the check off.
   * `analyze` reports either way, and the parser is linear for every grammar.
   */
  readonly allowedComplexity?: "linear" | "polynomial" | "exponential";

  /**
   * How many steps the analysis may take to account for the engine stopping at
   * its first match, after a pass that assumes every path fails finds a pattern
   * superlinear. The exact pass can need exponentially many steps in the size
   * of the pattern, as for `(?:a[ab]{20}a|a|b)*`, where what succeeds depends
   * on which of the next 20 characters are `a`. Past the budget that pass's
   * finding stands, with `exact: false`, which may over-report but never misses
   * a slow pattern. Defaults to 1,000,000, about half a second when it runs
   * out. `0` skips the exact pass, and `Infinity` never falls back.
   */
  readonly analysisBudget?: number;
}

/**
 * The functions that consume a grammar, built by `initialize` from a
 * {@link Config}.
 */
export interface Initialized {
  /**
   * The pattern source for a rule: anchored unless `anchored: false`, written
   * for the `v` flag and valid with the same meaning under `u`, so it can serve
   * as a JSON Schema `pattern`, and free of capturing groups. Throws
   * `VulnerablePatternError` if the pattern is slower than
   * `allowedComplexity`.
   */
  toPattern<$Grammar extends Grammar>(
    grammar: $Grammar,
    rule: RuleNames<$Grammar>,
    options?: PatternOptions,
  ): string;

  /**
   * `toPattern`, compiled with the `v` flag.
   */
  toRegExp<$Grammar extends Grammar>(
    grammar: $Grammar,
    rule: RuleNames<$Grammar>,
    options?: PatternOptions,
  ): RegExp;

  /**
   * A parser for a rule. It accepts exactly the strings `toRegExp` accepts,
   * returns the derivation JS regex backtracking would pick, and runs in time
   * linear in the input for every grammar, including ones whose pattern
   * `toRegExp` refuses.
   */
  toParser<$Grammar extends Grammar, $Name extends RuleNames<$Grammar>>(
    grammar: $Grammar,
    rule: $Name,
  ): Parser<AstOf<$Grammar, $Name>>;

  /**
   * How long a backtracking engine can take on the rule's pattern, with an
   * attack string when it is superlinear. Never throws for a slow pattern.
   */
  analyze<$Grammar extends Grammar>(
    grammar: $Grammar,
    rule: RuleNames<$Grammar>,
    options?: PatternOptions,
  ): Analysis;
}
