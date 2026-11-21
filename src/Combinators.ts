/**
 * Every combinator returns frozen plain data: no closures, no class instances,
 * nothing that would stop a rule body from being serialized or walked by a
 * consumer that knows only the `kind` union.
 *
 * @module
 */

import type {
  Either,
  Expr,
  Literal,
  Optional,
  Range,
  Repeat,
  Sequence,
} from "./Types.ts";

/**
 * Match `value` exactly.
 */
export function literal<const $Value extends string>(
  value: $Value,
): Literal<$Value> {
  return Object.freeze({ kind: "literal", value });
}

/**
 * Match one code point from `from` to `to`, inclusive.
 */
export function range(from: string, to: string): Range {
  return Object.freeze({ kind: "range", from, to });
}

/**
 * Match each item in order.
 */
export function sequence<const $Items extends readonly Expr[]>(
  items: $Items,
): Sequence<$Items> {
  return Object.freeze({
    kind: "sequence",
    items: Object.freeze(items.slice()) as $Items,
  });
}

/**
 * Match any one alternative. Where several lead to a match, the earliest is
 * preferred: the parser returns that derivation, as JS regex would.
 */
export function either<const $Alternatives extends readonly [Expr, ...Expr[]]>(
  ...alternatives: $Alternatives
): Either<$Alternatives> {
  return Object.freeze({
    kind: "either",
    alternatives: Object.freeze(alternatives.slice()) as $Alternatives,
  });
}

/**
 * Match `body` or nothing, preferring `body`.
 */
export function optional<const $Body extends Expr>(
  body: $Body,
): Optional<$Body> {
  return Object.freeze({ kind: "optional", body });
}

/**
 * Match `body` any number of times, greedily.
 */
export function zeroOrMore<const $Body extends Expr>(
  body: $Body,
): Repeat<$Body> {
  return Object.freeze({ kind: "repeat", body, min: 0 });
}

/**
 * Match `body` at least once, greedily.
 */
export function oneOrMore<const $Body extends Expr>(
  body: $Body,
): Repeat<$Body> {
  return Object.freeze({ kind: "repeat", body, min: 1 });
}

/**
 * Match `body` from `min` to `max` times, greedily; leave out `max` for no
 * upper bound. The bounds are checked when the rule is defined, not here, so
 * every check names the rule it failed in.
 */
export function repeat<const $Body extends Expr>(
  body: $Body,
  bounds: { readonly min: number; readonly max?: number },
): Repeat<$Body> {
  return Object.freeze(
    bounds.max === undefined
      ? { kind: "repeat", body, min: bounds.min }
      : { kind: "repeat", body, min: bounds.min, max: bounds.max },
  );
}
