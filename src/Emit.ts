import { checkThrough } from "./Check";
import { codePoint, codePoints, merge, type CodePointSet } from "./CodePoints";
import { AsterError } from "./Error";
import { escapeInside, escapeOutside } from "./Escape";
import type { Expr, Grammar, RuleNames } from "./Types";
import { fold } from "./Walk";

/**
 * How tightly an emitted fragment binds, loosest last. A context that needs a
 * tighter fragment than it has wraps it in `(?:…)`, so groups appear only where
 * precedence requires them.
 *
 * - `EMPTY`: matches only the empty string and is written as nothing.
 * - `ATOM`: one character, one class, or one group; a quantifier applies to it
 *   whole.
 * - `QUANTIFIED`: an atom with a quantifier. Quantifying it again needs a group,
 *   since `a??` and `a+?` are lazy quantifiers, not nested ones.
 * - `CONCAT`: several terms in a row.
 * - `ALTERNATION`: contains a top-level `|`.
 */
const EMPTY = 0;
const ATOM = 1;
const QUANTIFIED = 2;
const CONCAT = 3;
const ALTERNATION = 4;

type Level =
  | typeof EMPTY
  | typeof ATOM
  | typeof QUANTIFIED
  | typeof CONCAT
  | typeof ALTERNATION;

/**
 * An emitted expression. `set` is present when the expression matches exactly
 * one code point from a known set, which is what lets an `either` of such
 * expressions collapse into a single character class.
 */
interface Fragment {
  readonly text: string;
  readonly level: Level;
  readonly set: CodePointSet | undefined;
}

const NOTHING: Fragment = { text: "", level: EMPTY, set: undefined };

/**
 * Options for {@link toPattern} and {@link toRegExp}.
 */
export interface PatternOptions {
  /**
   * Whether the pattern must match the whole input: `^(?:…)$`. Defaults to
   * `true`, which is what the parser accepts and what a JSON Schema `pattern`
   * needs to mean "is a valid X" rather than "contains a valid X". Set it to
   * `false` to search for a match inside a longer string.
   */
  readonly anchored?: boolean;
}

/**
 * The pattern source for one rule. It is written for the `v` flag, and is also
 * valid with the same meaning under `u`, so it can be used as a JSON Schema
 * `pattern`. It has no capturing groups: extracting structure is the parser's
 * job.
 *
 * The grammar is checked as `.define()` would check it, in case it arrived as
 * data rather than from `.compose()`. Only the rule and the rules before it are
 * read, since a rule can only reference earlier ones.
 */
export function toPattern<$Grammar extends Grammar>(
  grammar: $Grammar,
  rule: RuleNames<$Grammar>,
  options: PatternOptions = {},
): string {
  const { text, level } = emit(grammar, rule);
  if (options.anchored === false) return text;
  return level === ALTERNATION ? `^(?:${text})$` : `^${text}$`;
}

/**
 * {@link toPattern} compiled with the `v` flag.
 */
export function toRegExp<$Grammar extends Grammar>(
  grammar: $Grammar,
  rule: RuleNames<$Grammar>,
  options: PatternOptions = {},
): RegExp {
  return new RegExp(toPattern(grammar, rule, options), "v");
}

/**
 * Emit every rule from the first through `rule`, in definition order, so each
 * reference reads a fragment already emitted for an earlier rule. A reference
 * is inlined as that fragment; JS regex has no subroutine calls.
 */
function emit(grammar: Grammar, rule: string): Fragment {
  const last = grammar.rules.findIndex(
    (definition) => definition.name === rule,
  );
  if (last === -1) throw new AsterError.UnknownRuleError(rule);
  checkThrough(grammar.rules, last);

  const fragments = new Map<string, Fragment>();
  for (let index = 0; index <= last; index += 1) {
    const definition = grammar.rules[index];
    if (definition === undefined) break;
    fragments.set(
      definition.name,
      fold<Fragment>(definition.body, ignore, (expr, own) =>
        lower(expr, own, fragments),
      ),
    );
  }
  return fragments.get(rule) ?? NOTHING;
}

function ignore(): void {}

/**
 * Lower one node, given its subexpressions' fragments in order.
 */
function lower(
  expr: Expr,
  own: readonly Fragment[],
  fragments: ReadonlyMap<string, Fragment>,
): Fragment {
  switch (expr.kind) {
    case "literal":
      return literal(expr.value);
    case "range":
      return characterClass([
        [codePoint(expr.from) ?? 0, codePoint(expr.to) ?? 0],
      ]);
    case "reference":
      return fragments.get(expr.name) ?? NOTHING;
    case "sequence":
      return sequence(own);
    case "either":
      return either(own);
    case "optional":
      return quantify(first(own), "?");
    case "repeat":
      return repeat(first(own), expr.min, expr.max);
  }
}

function first(own: readonly Fragment[]): Fragment {
  return own[0] ?? NOTHING;
}

function literal(value: string): Fragment {
  const points = codePoints(value);
  const [only] = points;
  if (only === undefined) return NOTHING;
  if (points.length === 1) return characterClass([[only, only]]);
  return {
    text: points.map(escapeOutside).join(""),
    level: CONCAT,
    set: undefined,
  };
}

function sequence(parts: readonly Fragment[]): Fragment {
  const present = parts.filter((part) => part.level !== EMPTY);
  if (present.length === 0) return NOTHING;
  if (present.length === 1) return present[0] ?? NOTHING;
  return {
    text: present
      .map((part) =>
        part.level === ALTERNATION ? group(part.text) : part.text,
      )
      .join(""),
    level: CONCAT,
    set: undefined,
  };
}

/**
 * An alternation, or one character class when every alternative matches exactly
 * one code point. Collapsing changes nothing about which strings match, and
 * since every alternative consumes exactly one code point, nothing about how a
 * capture-free regex matches either.
 */
function either(alternatives: readonly Fragment[]): Fragment {
  if (alternatives.length === 1) return alternatives[0] ?? NOTHING;
  const sets: (readonly [number, number])[] = [];
  for (const alternative of alternatives) {
    if (alternative.set === undefined) {
      return {
        text: alternatives.map((part) => part.text).join("|"),
        level: ALTERNATION,
        set: undefined,
      };
    }
    sets.push(...alternative.set);
  }
  return characterClass(sets);
}

function repeat(
  body: Fragment,
  min: number,
  max: number | undefined,
): Fragment {
  if (max === undefined) {
    if (min === 0) return quantify(body, "*");
    if (min === 1) return quantify(body, "+");
    return quantify(body, `{${min},}`);
  }
  if (min === max) return min === 1 ? body : quantify(body, `{${min}}`);
  if (min === 0 && max === 1) return quantify(body, "?");
  return quantify(body, `{${min},${max}}`);
}

function quantify(body: Fragment, quantifier: string): Fragment {
  if (body.level === EMPTY) return NOTHING;
  const operand = body.level === ATOM ? body.text : group(body.text);
  return { text: operand + quantifier, level: QUANTIFIED, set: undefined };
}

function group(text: string): string {
  return `(?:${text})`;
}

/**
 * One code point as an escaped character, or a set of them as a class, with
 * ranges sorted and merged first so the class is canonical and never writes a
 * character twice in a row (which `v` would read as a reserved double
 * punctuator such as `&&`).
 */
function characterClass(ranges: CodePointSet): Fragment {
  const merged = merge(ranges);
  const [only] = merged;
  if (merged.length === 1 && only !== undefined && only[0] === only[1]) {
    return { text: escapeOutside(only[0]), level: ATOM, set: merged };
  }
  const members = merged.map(([from, to]) => {
    if (from === to) return escapeInside(from);
    if (to === from + 1) return escapeInside(from) + escapeInside(to);
    return `${escapeInside(from)}-${escapeInside(to)}`;
  });
  return { text: `[${members.join("")}]`, level: ATOM, set: merged };
}
