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
 * `optional` a value or `undefined`; `zeroOrMore`/`oneOrMore` an array holding
 * every iteration; `either` the index of the alternative that matched beside
 * its value.
 */
export {
  either,
  literal,
  oneOrMore,
  optional,
  range,
  sequence,
  zeroOrMore,
} from "./Combinators";

/**
 * `AsterError` is the base; `DuplicateRuleError` is a rule name defined twice
 * in one grammar.
 */
export { AsterError } from "./Error";

/**
 * The expression types are what the combinators return, exported so inferred
 * grammar types can be named in a consumer's declarations. They are not yet a
 * stable introspection contract; that arrives with the unstable IR subpath.
 *
 * A grammar's type is the flat union of its `RuleDefinition`s; a `RuleRef` is a
 * rule's name alone. `Vocabulary` is the by-name object a builder sees, derived
 * from that union, and `RuleName` what `.define()` accepts as a name.
 * `Ast`/`AstOf` infer the {@link Node} a rule produces, and `Children` what an
 * expression contributes to its enclosing rule's node, resolving references by
 * name. Inference runs only when one of them is used, never at each `.define()`
 * link.
 */
export type {
  Ast,
  AstOf,
  Children,
  Either,
  Expr,
  Grammar,
  GrammarBuilder,
  Literal,
  Node,
  Optional,
  Range,
  Repeat,
  RuleDefinition,
  RuleName,
  RuleNames,
  RuleRef,
  Sequence,
  Span,
  Vocabulary,
} from "./Types";
