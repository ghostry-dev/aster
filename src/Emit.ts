import { checkThrough } from "./Check";
import { codePoint, codePoints, merge, type CodePointSet } from "./CodePoints";
import { AsterError } from "./Error";
import { escapeInside, escapeOutside } from "./Escape";
import type { Expr, Grammar, PatternOptions } from "./Types";
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
 * The structure of an emitted pattern, as a backtracking engine executes it:
 * what the ReDoS analysis reads. It is built by the same decisions that write
 * the text, in the same function, so the two cannot disagree about grouping,
 * collapsing, or dropped empties.
 *
 * `rule` marks where a named rule's text was inlined. It writes nothing; it
 * lets a finding name the rule it is in. A reused rule's node is shared, so
 * this is a DAG, and a walk that treats it as a tree expands each occurrence,
 * as the pattern text does.
 */
export type Regex =
  | { readonly kind: "empty" }
  | { readonly kind: "class"; readonly set: CodePointSet }
  | { readonly kind: "concat"; readonly parts: readonly Regex[] }
  | { readonly kind: "alternation"; readonly alternatives: readonly Regex[] }
  | {
      readonly kind: "repeat";
      readonly body: Regex;
      readonly min: number;
      readonly max: number | undefined;
    }
  | { readonly kind: "rule"; readonly name: string; readonly body: Regex };

/**
 * An emitted expression: its text, how tightly the text binds, and its
 * structure. `set` is present when the expression matches exactly one code
 * point from a known set, which is what lets an `either` of such expressions
 * collapse into a single character class.
 */
export interface Fragment {
  readonly text: string;
  readonly level: Level;
  readonly set: CodePointSet | undefined;
  readonly node: Regex;
}

const NOTHING: Fragment = {
  text: "",
  level: EMPTY,
  set: undefined,
  node: { kind: "empty" },
};

/**
 * The pattern source for one rule, anchored unless asked otherwise. Written for
 * the `v` flag and valid with the same meaning under `u`, with no capturing
 * groups.
 */
export function pattern(
  grammar: Grammar,
  rule: string,
  options: PatternOptions = {},
): string {
  return anchor(emit(grammar, rule), options);
}

/**
 * Wrap a rule's fragment in `^…$`, grouping a top-level alternation so the
 * anchors bind to all of it.
 */
export function anchor(fragment: Fragment, options: PatternOptions): string {
  const { text, level } = fragment;
  if (options.anchored === false) return text;
  return level === ALTERNATION ? `^(?:${text})$` : `^${text}$`;
}

/**
 * Emit every rule from the first through `rule`, in definition order, so each
 * reference reads a fragment already emitted for an earlier rule. A reference
 * is inlined as that fragment; JS regex has no subroutine calls.
 *
 * The grammar is checked as `.define()` would check it, in case it arrived as
 * data rather than from `.compose()`. Only the rule and the rules before it are
 * read, since a rule can only reference earlier ones.
 */
export function emit(grammar: Grammar, rule: string): Fragment {
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
  const root = fragments.get(rule) ?? NOTHING;
  return { ...root, node: { kind: "rule", name: rule, body: root.node } };
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
    case "reference": {
      const fragment = fragments.get(expr.name) ?? NOTHING;
      return {
        ...fragment,
        node: { kind: "rule", name: expr.name, body: fragment.node },
      };
    }
    case "sequence":
      return sequence(own);
    case "either":
      return either(own);
    case "optional":
      return quantify(first(own), 0, 1);
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
    node: {
      kind: "concat",
      parts: points.map((point) => ({ kind: "class", set: [[point, point]] })),
    },
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
    node: { kind: "concat", parts: present.map((part) => part.node) },
  };
}

/**
 * An alternation, or one character class when every alternative matches exactly
 * one code point. Collapsing changes nothing about which strings match, and
 * since every alternative consumes exactly one code point, nothing about how a
 * capture-free regex matches either. It does change how a backtracking engine
 * explores the pattern, since overlapping alternatives become one class, which
 * is why the analysis reads the collapsed structure.
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
        node: {
          kind: "alternation",
          alternatives: alternatives.map((part) => part.node),
        },
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
  if (min === 1 && max === 1) return body;
  return quantify(body, min, max);
}

/**
 * Quantify a fragment, writing the shortest quantifier for the bounds.
 */
function quantify(
  body: Fragment,
  min: number,
  max: number | undefined,
): Fragment {
  if (body.level === EMPTY) return NOTHING;
  const operand = body.level === ATOM ? body.text : group(body.text);
  return {
    text: operand + quantifier(min, max),
    level: QUANTIFIED,
    set: undefined,
    node: { kind: "repeat", body: body.node, min, max },
  };
}

function quantifier(min: number, max: number | undefined): string {
  if (max === undefined) {
    if (min === 0) return "*";
    if (min === 1) return "+";
    return `{${min},}`;
  }
  if (min === 0 && max === 1) return "?";
  if (min === max) return `{${min}}`;
  return `{${min},${max}}`;
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
  const node: Regex = { kind: "class", set: merged };
  const [only] = merged;
  if (merged.length === 1 && only !== undefined && only[0] === only[1]) {
    return { text: escapeOutside(only[0]), level: ATOM, set: merged, node };
  }
  const members = merged.map(([from, to]) => {
    if (from === to) return escapeInside(from);
    if (to === from + 1) return escapeInside(from) + escapeInside(to);
    return `${escapeInside(from)}-${escapeInside(to)}`;
  });
  return { text: `[${members.join("")}]`, level: ATOM, set: merged, node };
}
