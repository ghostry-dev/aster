import { check } from "./Check";
import { AsterError } from "./Error";
import type {
  Expr,
  GrammarBuilder,
  RuleDefinition,
  RuleRef,
  Vocabulary,
} from "./Types";

/**
 * Start a grammar. Rules are added with `.define()` and the grammar is finished
 * with `.compose()`.
 *
 * Every builder is immutable: `.define()` returns a new builder and leaves the
 * one it was called on unchanged, so two chains branching from a shared prefix
 * never see each other's rules.
 */
export function grammar(): GrammarBuilder {
  return builder([], new Map());
}

/**
 * `nullable` maps every rule defined so far to whether it can match the empty
 * string. It is what `check` needs to resolve a reference, and it is carried
 * forward rather than recomputed because each rule only references earlier
 * ones: definition order is already the order to analyze in.
 */
function builder<$Rules extends RuleDefinition>(
  rules: readonly RuleDefinition[],
  nullable: ReadonlyMap<string, boolean>,
): GrammarBuilder<$Rules> {
  return {
    define(name, build) {
      if (nullable.has(name)) throw new AsterError.DuplicateRuleError(name);
      const body: Expr = build(references(rules) as Vocabulary<$Rules>);
      const definition: RuleDefinition = Object.freeze({ name, body });
      return builder(
        [...rules, definition],
        new Map(nullable).set(name, check(name, body, nullable)),
      );
    },
    compose() {
      return Object.freeze({
        rules: Object.freeze(rules.slice()) as readonly $Rules[],
      });
    },
  } satisfies GrammarBuilder<$Rules>;
}

/**
 * The vocabulary handed to a builder: a reference node for each earlier rule
 * and nothing else, so even an untyped caller cannot refer forward. Built with
 * `defineProperty` so a rule named `__proto__` becomes an own key rather than
 * replacing the object's prototype.
 */
function references(rules: readonly RuleDefinition[]): Vocabulary {
  const vocabulary: Record<string, RuleRef> = {};
  for (const { name } of rules) {
    Object.defineProperty(vocabulary, name, {
      value: Object.freeze({ kind: "reference", name }),
      enumerable: true,
    });
  }
  return Object.freeze(vocabulary);
}
