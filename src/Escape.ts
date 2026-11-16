/**
 * The only way text reaches an emitted pattern. Every character of a literal
 * goes through {@link escapeOutside}, and every class member through
 * {@link escapeInside}; no raw string is ever concatenated into a pattern.
 *
 * The output is valid, and means the same thing, under both the `v` flag (what
 * `toRegExp` uses) and the `u` flag (what most JSON Schema validators compile a
 * `pattern` with). That constrains the choices:
 *
 * - Only syntax characters and `/` get an identity escape (`\.`), because `u` and
 *   `v` reject `\` before anything else, such as `\&` or `\:`.
 * - Inside a class, `v` additionally reserves `( ) [ ] { } / - \ |`, all of which
 *   `u` also accepts escaped. `v` also reserves doubled punctuators such as
 *   `&&` and `!!`. Members are emitted sorted, merged, and disjoint, so no
 *   character is ever written twice in a row, and those need no escape.
 * - Characters that are invisible or that a JSON string or a line-based tool
 *   would mangle are written as `\t \n \v \f \r` or `\u{…}`: C0 and C1
 *   controls, DEL, U+2028/U+2029, U+FEFF, and lone surrogates.
 *
 * @module
 */

/**
 * Syntax characters, plus `/` so the pattern can also sit inside a regex
 * literal.
 */
const SYNTAX = new Set("^$\\.*+?()[]{}|/");

/**
 * What `v` reserves inside a class beyond {@link SYNTAX}, plus `^`, which would
 * negate the class in first position and is escaped everywhere for simplicity.
 */
const CLASS_SYNTAX = new Set("()[]{}/-\\|^");

const NAMED: Readonly<Record<number, string>> = {
  0x09: "\\t",
  0x0a: "\\n",
  0x0b: "\\v",
  0x0c: "\\f",
  0x0d: "\\r",
};

/**
 * Write one code point outside a character class.
 */
export function escapeOutside(point: number): string {
  return invisible(point) ?? identity(point, SYNTAX);
}

/**
 * Write one code point as a member or range endpoint inside a character class.
 */
export function escapeInside(point: number): string {
  return invisible(point) ?? identity(point, CLASS_SYNTAX);
}

function identity(point: number, syntax: ReadonlySet<string>): string {
  const text = String.fromCodePoint(point);
  return syntax.has(text) ? `\\${text}` : text;
}

function invisible(point: number): string | undefined {
  const named = NAMED[point];
  if (named !== undefined) return named;
  const hidden =
    point < 0x20
    || (point >= 0x7f && point <= 0x9f)
    || point === 0x2028
    || point === 0x2029
    || point === 0xfeff
    || (point >= 0xd800 && point <= 0xdfff);
  return hidden ? `\\u{${point.toString(16).toUpperCase()}}` : undefined;
}
