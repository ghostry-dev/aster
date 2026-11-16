import { codePoint } from "./CodePoints";
import { AsterError } from "./Error";
import type { Kind } from "./IR";
import type { Expr, RuleDefinition } from "./Types";
import { fold } from "./Walk";

/**
 * Every kind, as an object rather than an array so that adding a kind to the
 * union without adding it here is a compile error.
 */
const KINDS: Readonly<Record<Kind, true>> = {
  literal: true,
  range: true,
  sequence: true,
  either: true,
  optional: true,
  repeat: true,
  reference: true,
};

/**
 * Validate one rule body at definition time and return whether it can match the
 * empty string. `nullable` holds the answer for every rule defined before this
 * one; because a body can only reference earlier rules, that is all the
 * information a reference needs, and the rules are checked in one forward pass
 * with no graph search.
 *
 * The body is walked with {@link fold}. A node is validated when first reached,
 * so the walk only ever descends into well-formed nodes; its nullability is
 * computed on the way back up, from its subexpressions' answers.
 */
export function check(
  rule: string,
  body: Expr,
  nullable: ReadonlyMap<string, boolean>,
): boolean {
  return fold<boolean>(
    body,
    (expr) => validate(rule, expr, nullable),
    (expr, own) => close(rule, expr, own, nullable),
  );
}

/**
 * Check every rule from the first through `rules[last]` as `.define()` would
 * have, in definition order. A grammar from `.compose()` always passes; this is
 * for one that arrived as data, such as a JSON round trip or a hand-built
 * object, before anything compiles it.
 */
export function checkThrough(
  rules: readonly RuleDefinition[],
  last: number,
): void {
  const nullable = new Map<string, boolean>();
  for (let index = 0; index <= last; index += 1) {
    const rule = rules[index];
    if (rule === undefined) return;
    if (nullable.has(rule.name)) {
      throw new AsterError.DuplicateRuleError(rule.name);
    }
    nullable.set(rule.name, check(rule.name, rule.body, nullable));
  }
}

/**
 * Validate a node's own fields. Everything checked here is local to the node,
 * so the error can name the rule but needs no path.
 */
function validate(
  rule: string,
  expr: Expr,
  nullable: ReadonlyMap<string, boolean>,
): void {
  const value: unknown = expr;
  if (
    typeof value !== "object"
    || value === null
    || !Object.prototype.hasOwnProperty.call(KINDS, (value as Expr).kind)
  ) {
    throw new AsterError.InvalidExpressionError(rule, value);
  }

  switch (expr.kind) {
    case "range": {
      const from = codePoint(expr.from);
      const to = codePoint(expr.to);
      if (from === undefined || to === undefined) {
        throw new AsterError.InvalidRangeError(
          rule,
          expr.from,
          expr.to,
          "endpoint",
        );
      }
      if (from > to) {
        throw new AsterError.InvalidRangeError(
          rule,
          expr.from,
          expr.to,
          "order",
        );
      }
      break;
    }
    case "repeat": {
      const { min, max } = expr;
      const minimum = Number.isSafeInteger(min) && min >= 0;
      const maximum =
        max === undefined
        || (Number.isSafeInteger(max) && max >= 1 && max >= min);
      if (!minimum || !maximum) {
        throw new AsterError.InvalidRepetitionError(rule, min, max);
      }
      break;
    }
    case "either":
      if (expr.alternatives.length === 0) {
        throw new AsterError.EmptyEitherError(rule);
      }
      break;
    case "reference":
      if (!nullable.has(expr.name)) {
        throw new AsterError.UnknownReferenceError(rule, expr.name);
      }
      break;
    case "literal":
    case "sequence":
    case "optional":
      break;
  }
}

/**
 * Whether a node can match the empty string, given the same answer for each of
 * its subexpressions in order. An `optional` or a repetition of a nullable body
 * is rejected here, since this is the first point its body's answer is known.
 */
function close(
  rule: string,
  expr: Expr,
  own: readonly boolean[],
  nullable: ReadonlyMap<string, boolean>,
): boolean {
  switch (expr.kind) {
    case "literal":
      return expr.value === "";
    case "range":
      return false;
    case "reference":
      return nullable.get(expr.name) === true;
    case "sequence":
      return own.every(Boolean);
    case "either":
      return own.some(Boolean);
    case "optional":
      if (own[0] === true)
        throw new AsterError.NullableQuantifierError(rule, "optional");
      return true;
    case "repeat":
      if (own[0] === true)
        throw new AsterError.NullableQuantifierError(rule, "repeat");
      return expr.min === 0;
  }
}
