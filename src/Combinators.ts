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
} from "./Types";

/**
 * Match `value` exactly.
 */
export function literal(value: string): Literal {
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
 * Match the first alternative, in order, that leads to an overall match.
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
): Repeat<$Body, 0> {
  return Object.freeze({ kind: "repeat", body, min: 0 });
}

/**
 * Match `body` at least once, greedily.
 */
export function oneOrMore<const $Body extends Expr>(
  body: $Body,
): Repeat<$Body, 1> {
  return Object.freeze({ kind: "repeat", body, min: 1 });
}
