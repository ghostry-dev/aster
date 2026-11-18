import { escapeInside, escapeOutside } from "#internal/Escape";
import { fold } from "#internal/Walk";
import type { Grammar, Node } from "@ghostry/aster";
import type { Expr } from "@ghostry/aster/unstable-ir";
import type { Random } from "./random.ts";

/**
 * Characters every random grammar draws from, and a pool of awkward ones it
 * adds one or two of: regex syntax, class syntax, an astral character, both
 * halves of a surrogate pair on their own, and a line break.
 */
const BASE = ["a", "b"];
const AWKWARD = [
  "-",
  "]",
  "^",
  "\\",
  ".",
  "|",
  "&",
  "(",
  "{",
  "$",
  "\n",
  "😀",
  "\uD83D",
  "\uDE00",
];

/**
 * A random grammar as data, with its alphabet. It may break a definition-time
 * rule (most often a repetition of a nullable body); the caller checks it and
 * draws again. Built top-down with an explicit stack of holes to fill, like
 * every walk in this repository.
 */
export function randomGrammar(random: Random): {
  readonly grammar: Grammar;
  readonly alphabet: readonly string[];
} {
  const alphabet = [...BASE];
  for (let extra = random.int(1, 2); extra > 0; extra -= 1)
    alphabet.push(random.pick(AWKWARD));

  const rules: { name: string; body: Expr }[] = [];
  const count = random.int(1, 5);
  for (let index = 0; index < count; index += 1) {
    const names = rules.map(({ name }) => name);
    let root: Expr | undefined;
    const holes: { depth: number; fill: (expr: Expr) => void }[] = [
      { depth: 0, fill: (expr) => (root = expr) },
    ];
    for (let hole = holes.pop(); hole !== undefined; hole = holes.pop()) {
      const { depth, fill } = hole;
      const leaf = depth >= 4 || random.chance(depth * 0.2);
      const kinds = leaf
        ? ["literal", "literal", "range", "reference"]
        : [
            "literal",
            "range",
            "reference",
            "sequence",
            "sequence",
            "either",
            "either",
            "optional",
            "repeat",
            "repeat",
          ];
      let kind = random.pick(kinds);
      if (kind === "reference" && names.length === 0) kind = "literal";
      const below = (assign: (expr: Expr) => void) =>
        holes.push({ depth: depth + 1, fill: assign });

      switch (kind) {
        case "literal": {
          let value = "";
          for (let length = random.int(0, 3); length > 0; length -= 1)
            value += random.pick(alphabet);
          fill({ kind: "literal", value });
          break;
        }
        case "range": {
          const [from, to] = [
            random.pick(alphabet),
            random.pick(alphabet),
          ].sort(
            (left, right) =>
              (left.codePointAt(0) ?? 0) - (right.codePointAt(0) ?? 0),
          );
          fill({ kind: "range", from: from ?? "a", to: to ?? "a" });
          break;
        }
        case "reference":
          fill({ kind: "reference", name: random.pick(names) });
          break;
        case "sequence": {
          const items: Expr[] = [];
          for (let item = random.int(0, 3); item > 0; item -= 1)
            items.push({ kind: "literal", value: "" });
          items.forEach((_, at) => below((expr) => (items[at] = expr)));
          fill({ kind: "sequence", items });
          break;
        }
        case "either": {
          const alternatives: Expr[] = [];
          for (let item = random.int(1, 3); item > 0; item -= 1)
            alternatives.push({ kind: "literal", value: "" });
          alternatives.forEach((_, at) =>
            below((expr) => (alternatives[at] = expr)),
          );
          fill({ kind: "either", alternatives });
          break;
        }
        case "optional":
          below((body) => fill({ kind: "optional", body }));
          break;
        case "repeat": {
          const min = random.int(0, 2);
          const bounded = random.chance(0.5);
          const max = min + random.int(min === 0 ? 1 : 0, 2);
          below((body) =>
            fill(
              bounded
                ? { kind: "repeat", body, min, max }
                : { kind: "repeat", body, min },
            ),
          );
          break;
        }
      }
    }
    if (root === undefined) throw new Error("no root");
    rules.push({ name: `r${index}`, body: root });
  }
  return { grammar: { rules }, alphabet };
}

/**
 * The body of every rule, by name.
 */
function bodies(grammar: Grammar): ReadonlyMap<string, Expr> {
  return new Map(grammar.rules.map(({ name, body }) => [name, body]));
}

/**
 * A random string the rule probably accepts: one random derivation, written
 * out. Not always accepted, because adjacent lone surrogates from separate
 * leaves can join into one astral character. That is fine; it only has to be a
 * likely member.
 */
export function sample(
  grammar: Grammar,
  rule: string,
  random: Random,
  limit = 16,
): string {
  const lookup = bodies(grammar);
  const pending: Expr[] = [{ kind: "reference", name: rule }];
  let text = "";
  for (let expr = pending.pop(); expr !== undefined; expr = pending.pop()) {
    if (text.length > limit) break;
    switch (expr.kind) {
      case "literal":
        text += expr.value;
        break;
      case "range": {
        const from = expr.from.codePointAt(0) ?? 0;
        const to = expr.to.codePointAt(0) ?? 0;
        const point = random.chance(0.5)
          ? random.pick([from, to])
          : random.int(from, Math.min(to, from + 64));
        text += String.fromCodePoint(point);
        break;
      }
      case "reference": {
        const body = lookup.get(expr.name);
        if (body !== undefined) pending.push(body);
        break;
      }
      case "sequence":
        for (let index = expr.items.length - 1; index >= 0; index -= 1) {
          const item = expr.items[index];
          if (item !== undefined) pending.push(item);
        }
        break;
      case "either":
        pending.push(random.pick(expr.alternatives));
        break;
      case "optional":
        if (random.chance(0.5)) pending.push(expr.body);
        break;
      case "repeat": {
        const times = random.int(expr.min, expr.max ?? expr.min + 3);
        for (let time = 0; time < times; time += 1) pending.push(expr.body);
        break;
      }
    }
  }
  return text;
}

/**
 * How many subexpression occurrences each expression stands for once references
 * are inlined: itself plus everything below it. Rules are folded in definition
 * order, so a reference reads its rule's size, already computed.
 */
function sizes(grammar: Grammar): ReadonlyMap<Expr, number> {
  const known = new Map<Expr, number>();
  const rules = new Map<string, number>();
  for (const { name, body } of grammar.rules) {
    rules.set(
      name,
      fold<number>(
        body,
        () => {},
        (expr, own) => {
          const size =
            expr.kind === "reference"
              ? 1 + (rules.get(expr.name) ?? 0)
              : own.reduce((total, part) => total + part, 1);
          known.set(expr, size);
          return size;
        },
      ),
    );
  }
  return known;
}

/**
 * The derivation as spans: entry `i` is the span of the `i`th subexpression
 * occurrence in pre-order, references inlined, or `undefined` where the
 * occurrence did not take part. Inside a repetition, only the last iteration
 * counts, and an occurrence the last iteration skipped is `undefined`, which is
 * how a JS regex reports a capture inside a quantifier.
 */
export type Spans = readonly (readonly [number, number] | undefined)[];

/**
 * A regex for `rule` in which every occurrence is its own capturing group, so
 * with the `d` flag a match reports the whole derivation JS chose.
 *
 * Deliberately independent of the emitter: every subexpression is wrapped in a
 * group, so no precedence reasoning is involved, and there is no class
 * collapsing. Groups open in pre-order, which numbers them the way
 * {@link derived} numbers occurrences.
 */
export function capturing(grammar: Grammar, rule: string): RegExp {
  const lookup = bodies(grammar);
  const out: string[] = [];
  const pending: (Expr | string)[] = [{ kind: "reference", name: rule }];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    switch (item.kind) {
      case "literal":
        out.push(`(${[...item.value].map(point(escapeOutside)).join("")})`);
        break;
      case "range":
        out.push(
          `([${point(escapeInside)(item.from)}-${point(escapeInside)(item.to)}])`,
        );
        break;
      case "reference": {
        const body = lookup.get(item.name);
        if (body === undefined) throw new Error(`no rule ${item.name}`);
        out.push("(");
        pending.push(")", body);
        break;
      }
      case "sequence":
        out.push("(");
        pending.push(")", ...[...item.items].reverse());
        break;
      case "either": {
        out.push("(");
        pending.push(")");
        for (let index = item.alternatives.length - 1; index >= 0; index -= 1) {
          const alternative = item.alternatives[index];
          if (alternative !== undefined) pending.push(alternative);
          if (index > 0) pending.push("|");
        }
        break;
      }
      case "optional":
        out.push("(");
        pending.push("?)", item.body);
        break;
      case "repeat": {
        const quantifier =
          item.max === undefined
            ? `{${item.min},}`
            : `{${item.min},${item.max}}`;
        out.push("(");
        pending.push(`${quantifier})`, item.body);
        break;
      }
    }
  }
  return new RegExp(`^${out.join("")}$`, "dv");
}

function point(escape: (point: number) => string) {
  return (character: string): string => escape(character.codePointAt(0) ?? 0);
}

/**
 * What a capturing regex from {@link capturing} reports for `input`, or
 * `undefined` if it does not match.
 */
export function captured(regex: RegExp, input: string): Spans | undefined {
  /**
   * `indices` is ES2022, past this project's `lib`; the `d` flag is set in
   * {@link capturing}.
   */
  const match = regex.exec(input) as
    | (RegExpExecArray & {
        readonly indices: readonly (readonly [number, number] | undefined)[];
      })
    | null;
  const indices = match?.indices;
  if (indices === undefined) return undefined;
  return indices
    .slice(1)
    .map((span) => (span === undefined ? span : [...span]));
}

/**
 * The same spans as {@link captured}, read off the parser's AST instead.
 *
 * The AST says which alternative each `either` took, whether each `optional`
 * did, and every iteration of each repetition. Walking it beside the rule
 * bodies, with a cursor advanced by each leaf's text, gives every occurrence's
 * span. Each iteration of a repetition first clears the occurrences inside its
 * body, as JS resets captures at the start of every iteration.
 */
export function derived(
  grammar: Grammar,
  rule: string,
  node: Node<string, unknown>,
): Spans {
  const lookup = bodies(grammar);
  const known = sizes(grammar);
  const size = (expr: Expr): number => known.get(expr) ?? 1;
  const root: Expr = { kind: "reference", name: rule };
  const total = 1 + size(lookup.get(rule) ?? root);
  const spans: (readonly [number, number] | undefined)[] = Array.from(
    { length: total },
    () => undefined,
  );

  type Item =
    | {
        readonly kind: "open";
        readonly expr: Expr;
        readonly index: number;
        readonly value: unknown;
      }
    | { readonly kind: "close"; readonly index: number; readonly start: number }
    | { readonly kind: "clear"; readonly from: number; readonly to: number };

  let cursor = 0;
  const pending: Item[] = [{ kind: "open", expr: root, index: 0, value: node }];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (item.kind === "close") {
      spans[item.index] = [item.start, cursor];
      continue;
    }
    if (item.kind === "clear") {
      spans.fill(undefined, item.from, item.to);
      continue;
    }
    const { expr, index, value } = item;
    pending.push({ kind: "close", index, start: cursor });
    const open = (child: Expr, at: number, inner: unknown): void => {
      pending.push({ kind: "open", expr: child, index: at, value: inner });
    };
    switch (expr.kind) {
      case "literal":
      case "range":
        cursor += String(value).length;
        break;
      case "reference": {
        const body = lookup.get(expr.name);
        if (body === undefined) throw new Error(`no rule ${expr.name}`);
        open(body, index + 1, (value as Node<string, unknown>).children);
        break;
      }
      case "sequence": {
        const values = value as readonly unknown[];
        let at = index + 1;
        const children = expr.items.map((child, position) => {
          const entry = { child, at, inner: values[position] };
          at += size(child);
          return entry;
        });
        for (const { child, at: start, inner } of children.reverse())
          open(child, start, inner);
        break;
      }
      case "either": {
        const { alternative, value: inner } = value as {
          alternative: number;
          value: unknown;
        };
        let at = index + 1;
        for (let position = 0; position < alternative; position += 1)
          at += size(expr.alternatives[position] ?? root);
        const child = expr.alternatives[alternative];
        if (child !== undefined) open(child, at, inner);
        break;
      }
      case "optional":
        if (value !== undefined) open(expr.body, index + 1, value);
        break;
      case "repeat": {
        const values = value as readonly unknown[];
        for (let position = values.length - 1; position >= 0; position -= 1) {
          open(expr.body, index + 1, values[position]);
          pending.push({
            kind: "clear",
            from: index + 1,
            to: index + size(expr),
          });
        }
        break;
      }
    }
  }
  return spans;
}
