/**
 * The `@ghostry/aster/unstable-ir` subpath: the introspection IR a consumer
 * such as `@ghostry/fabricator` walks. `grammar.rules` is this IR already; this
 * module names its shape and gives walkers the one primitive they all need.
 *
 * Unstable until the fabricator integration freezes it, which waits until aster
 * has been released on its own. Until then a kind or a field can change in any
 * release, which is why it lives on a subpath named for that and not on the
 * package root.
 *
 * Four properties hold now and will hold after the freeze:
 *
 * 1. **Plain data.** No closures, class instances, or methods; every node is
 *    frozen and survives a JSON round trip unchanged.
 * 2. **References by name.** A `reference` node holds a rule name, never the
 *    referenced body. Inlining is a compiler concern.
 * 3. **Closed union.** `kind` is a fixed union, so a `switch` over it can be
 *    exhaustive and a new kind is a compile error at every consumer.
 * 4. **Separate from compiled forms.** This is not the NFA or the regex AST; the
 *    compiler lowers it into those privately.
 *
 * `grammar.rules` is in definition order, which is also a topological order of
 * the reference graph: a rule only references rules before it. A per-rule pass
 * is one forward loop that reads results already computed for earlier rules.
 *
 * @module
 */

import type { Expr } from "../Types";

export type {
  Either,
  Expr,
  Grammar,
  Literal,
  Optional,
  Range,
  Repeat,
  RuleDefinition,
  RuleRef,
  Sequence,
} from "../Types";

/**
 * Every node kind.
 */
export type Kind = Expr["kind"];

/**
 * The direct subexpressions of `expr`, in order: a sequence's items, an
 * either's alternatives, an optional's or a repetition's body, and nothing for
 * a literal, range, or reference. A reference's target is a different rule, not
 * a subexpression.
 *
 * This is what lets a walker stay a loop over an explicit stack, whatever the
 * nesting depth: push the subexpressions, never recurse into them.
 */
export function subexpressions(expr: Expr): readonly Expr[] {
  switch (expr.kind) {
    case "sequence":
      return expr.items;
    case "either":
      return expr.alternatives;
    case "optional":
    case "repeat":
      return [expr.body];
    case "literal":
    case "range":
    case "reference":
      return [];
  }
}
