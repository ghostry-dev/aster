import { AsterError } from "./Error";
import { subexpressions, type Kind } from "./IR";
import type { Expr } from "./Types";

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
 * One body node on the explicit walk stack, with the index of the next
 * subexpression to visit.
 */
interface Frame {
  readonly expr: Expr;
  readonly subexpressions: readonly Expr[];
  next: number;
}

/**
 * Validate one rule body at definition time and return whether it can match the
 * empty string. `nullable` holds the answer for every rule defined before this
 * one; because a body can only reference earlier rules, that is all the
 * information a reference needs, and the rules are checked in one forward pass
 * with no graph search.
 *
 * The body is walked post-order with an explicit stack, never by recursion, so
 * nesting depth is bounded by memory rather than the call stack. A node is
 * validated when first pushed, so the walk only ever descends into well-formed
 * nodes; its nullability is computed when popped, from its subexpressions'
 * results, which sit on top of the `results` stack in order.
 */
export function check(
  rule: string,
  body: Expr,
  nullable: ReadonlyMap<string, boolean>,
): boolean {
  const frames: Frame[] = [open(rule, body, nullable)];
  const results: boolean[] = [];

  for (let top = frames.pop(); top !== undefined; top = frames.pop()) {
    const next = top.subexpressions[top.next];
    if (next !== undefined) {
      top.next += 1;
      frames.push(top, open(rule, next, nullable));
      continue;
    }
    const count = top.subexpressions.length;
    const own = results.splice(results.length - count, count);
    results.push(close(rule, top.expr, own, nullable));
  }

  return results[0] === true;
}

/**
 * Validate a node's own fields and make its frame. Everything checked here is
 * local to the node, so the error can name the rule but needs no path.
 */
function open(
  rule: string,
  expr: Expr,
  nullable: ReadonlyMap<string, boolean>,
): Frame {
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

  return { expr, subexpressions: subexpressions(expr), next: 0 };
}

/**
 * Whether a node can match the empty string, given the same answer for each of
 * its subexpressions in order. A repetition of a nullable body is rejected
 * here, since this is the first point its body's answer is known.
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
      return true;
    case "repeat":
      if (own[0] === true) throw new AsterError.NullableRepetitionError(rule);
      return expr.min === 0;
  }
}

/**
 * The code point of a string that is exactly one code point, else `undefined`.
 * A lone surrogate counts as one code point, as it does to a `v` flag regex.
 */
function codePoint(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const point = value.codePointAt(0);
  if (point === undefined) return undefined;
  return value.length === (point > 0xffff ? 2 : 1) ? point : undefined;
}
