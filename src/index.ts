/**
 * The `@ghostry/aster` package export. One grammar definition is meant to
 * produce two outputs that accept exactly the same strings: a `RegExp` for
 * validation and a parser that returns a typed AST with source spans.
 *
 * Grammars are regular by construction. Each `.define()` builder sees only the
 * rules defined before it, so the rule graph is a DAG and always has a regex
 * target.
 *
 * @module
 */

/**
 * Start a grammar: `grammar().define(name, (rules) => body)…compose()`. Each
 * builder receives references to the earlier rules only. Builders are
 * immutable, so chains can branch from a shared prefix.
 */
export { grammar } from "./Grammar";

/**
 * The combinators a rule body is built from. Each returns frozen plain data.
 * `literal` and `range` contribute the matched text; `sequence` a tuple;
 * `optional` a value or `undefined`; `zeroOrMore`/`oneOrMore`/`repeat` an array
 * holding every iteration; `either` the index of the alternative that matched
 * beside its value.
 */
export {
  either,
  literal,
  oneOrMore,
  optional,
  range,
  repeat,
  sequence,
  zeroOrMore,
} from "./Combinators";

/**
 * Build the functions that consume a grammar: `toPattern`, `toRegExp`,
 * `toParser`, and `analyze`. `initialize()` with no config is safe by default:
 * `toPattern` and `toRegExp` throw `VulnerablePatternError` rather than return
 * a pattern a backtracking engine can take superlinear time on. `redos` relaxes
 * that to exponential patterns only, or turns it off; `analyze` reports either
 * way, with an attack string, and the parser is linear for every grammar.
 *
 * Patterns are anchored unless `anchored: false`, written for the `v` flag and
 * valid with the same meaning under `u` (so they serve as a JSON Schema
 * `pattern`), and capture-free. The parser accepts exactly the strings the
 * regex accepts, returns the derivation JS regex backtracking would pick as a
 * typed {@link Node} tree with spans, and returns a {@link ParseFailure} for an
 * input that does not match: the furthest offset any derivation reached, what
 * was expected there, and a message with its line and column.
 */
export { initialize } from "./Initialize";

/**
 * `AsterError` is the base, and `instanceof AsterError` catches everything the
 * library throws. Each subclass's `name` is `"@ghostry/aster:<Class>"`.
 * `.define()` throws `DuplicateRuleError`, `UnknownReferenceError`,
 * `InvalidRangeError`, `InvalidRepetitionError`, `EmptyEitherError`,
 * `NullableQuantifierError`, and `InvalidExpressionError`, each naming the
 * rule. `initialize` throws `InvalidConfigError` for an option it does not
 * accept. `toPattern`/`toRegExp` throw `VulnerablePatternError` for a pattern
 * `redos` rejects. `toPattern`/`toRegExp`/`toParser`/`analyze` throw
 * `UnknownRuleError`, plus any of those for a grammar that arrived as data.
 */
export { AsterError } from "./Error";

/**
 * The expression types are what the combinators return, exported so inferred
 * grammar types can be named in a consumer's declarations. They are not yet a
 * stable introspection contract; `./unstable-ir` is the closest there is.
 *
 * A grammar's type is the flat union of its `RuleDefinition`s; a `RuleRef` is a
 * rule's name alone. `Vocabulary` is the by-name object a builder sees, derived
 * from that union, and `RuleName` what `.define()` accepts as a name.
 * `Ast`/`AstOf` infer the {@link Node} a rule produces, and `Children` what an
 * expression contributes to its enclosing rule's node, resolving references by
 * name. Inference runs only when one of them is used, never at each `.define()`
 * link. `Parser` is what `toParser` returns, and `ParseResult` what a parser
 * returns: a `ParseSuccess` holding the root node or a `ParseFailure`, whose
 * `expected` entries are `Expectation`s.
 */
export type {
  Analysis,
  Ast,
  AstOf,
  Attack,
  Children,
  Config,
  Either,
  Expectation,
  Expr,
  Grammar,
  GrammarBuilder,
  Initialized,
  Literal,
  Node,
  Optional,
  ParseFailure,
  Parser,
  ParseResult,
  ParseSuccess,
  PatternOptions,
  Range,
  Repeat,
  RuleDefinition,
  RuleName,
  RuleNames,
  RuleRef,
  Sequence,
  Span,
  Vocabulary,
  Vulnerability,
} from "./Types";
