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
 * The first alternative that leads to a match, in JS regex priority order. Its
 * children record which alternative matched, since two alternatives with the
 * same child type could not otherwise be told apart.
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
 * A half-open range in the input. Line and column are code point based and
 * computed on demand, so the common case pays nothing for them.
 */
export interface Span {
  readonly start: number;
  readonly end: number;
  position(): { line: number; column: number };
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
 */
export type Children<$Expr extends Expr, $Rules extends RuleDefinition> =
  $Expr extends RuleRef<infer $Name>
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
