import { compile } from "./NFA";
import { Source, SourceSpan } from "./Source";
import type {
  AstOf,
  Either,
  Expr,
  Grammar,
  Node,
  Optional,
  Parser,
  Repeat,
  RuleNames,
  Sequence,
  Span,
} from "./Types";
import { run, type Event } from "./VM";
import { fold } from "./Walk";

/**
 * Compile a parser for `rule`. It accepts exactly the strings
 * `toRegExp(grammar, rule)` accepts and, where an input has several
 * derivations, returns the one JS regex backtracking would find. It runs in
 * time linear in the input for every grammar.
 *
 * Compilation happens once, here, so build a parser once and call it many
 * times. The grammar is checked as `toPattern` checks it.
 */
export function toParser<
  $Grammar extends Grammar,
  $Name extends RuleNames<$Grammar>,
>(grammar: $Grammar, rule: $Name): Parser<AstOf<$Grammar, $Name>> {
  const program = compile(grammar, rule);
  const last = grammar.rules.findIndex(
    (definition) => definition.name === rule,
  );

  const bodies = new Map<string, Expr>();
  const sizes = new Map<Expr, number>();
  for (let index = 0; index <= last; index += 1) {
    const definition = grammar.rules[index];
    if (definition === undefined) break;
    bodies.set(definition.name, definition.body);
    fold<number>(definition.body, ignore, (expr, own) => {
      let size = 1;
      for (const count of own) size += count;
      sizes.set(expr, size);
      return size;
    });
  }

  return (input) => {
    const result = run(program, input);
    if (!result.ok) return { ok: false, offset: result.offset };
    const node = replay(rule, result.events, input, bodies, sizes);
    return { ok: true, node: node as AstOf<$Grammar, $Name> };
  };
}

function ignore(): void {}

/**
 * A node of the AST. `text` is read from the input only when asked for, and the
 * input is a private field, so a node's own properties are `rule`, `span`, and
 * `children`.
 */
class ParsedNode implements Node<string, unknown> {
  readonly #source: Source;

  constructor(
    source: Source,
    readonly rule: string,
    readonly span: Span,
    readonly children: unknown,
  ) {
    this.#source = source;
  }

  get text(): string {
    return this.#source.input.slice(this.span.start, this.span.end);
  }
}

/**
 * An expression being rebuilt from the trace. `base` is the post-order index of
 * the first node in the expression's subtree within its rule's body, so the
 * expression's own index, the one its `choice` marks carry, is `base + size -
 * 1`.
 */
type Frame =
  | { readonly kind: "rule"; readonly rule: string; start: number }
  | { readonly kind: "leaf"; readonly expr: Expr }
  | {
      readonly kind: "sequence";
      readonly expr: Sequence;
      readonly values: unknown[];
      /** The `base` of the next item. */
      next: number;
    }
  | {
      readonly kind: "either";
      readonly expr: Either;
      readonly base: number;
      branch: number;
    }
  | {
      readonly kind: "optional";
      readonly expr: Optional;
      readonly base: number;
      taken: boolean;
    }
  | {
      readonly kind: "repeat";
      readonly expr: Repeat;
      readonly base: number;
      readonly values: unknown[];
    };

/**
 * Fold the winning trace into the root rule's node.
 *
 * The replay walks the rule bodies again, forward, with an explicit stack of
 * open frames, and lets the trace decide every choice: which alternative of an
 * `either`, whether an `optional` was taken, how many times a repetition ran.
 * Between choices it advances a cursor over the input by what each literal and
 * range consumed, which is where leaf text comes from. `enter`/`exit` marks
 * give each rule its span, and are checked against the cursor.
 *
 * Every check here guards an invariant between the NFA and this replay, not a
 * property of the input, so a failure is a bug and throws a plain `Error`.
 */
function replay(
  rule: string,
  events: readonly Event[],
  input: string,
  bodies: ReadonlyMap<string, Expr>,
  sizes: ReadonlyMap<Expr, number>,
): unknown {
  const source = new Source(input);
  let cursor = 0;
  let at = 0;

  const event = (): Event => {
    const next = events[at];
    if (next === undefined) throw new Error("the trace ended early");
    at += 1;
    return next;
  };
  const rulemark = (kind: "enter" | "exit", name: string): void => {
    const { mark, offset } = event();
    if (mark.kind !== kind || mark.rule !== name || offset !== cursor)
      throw new Error(`expected ${kind} ${name} at ${cursor}`);
  };
  const choice = (expr: Expr, base: number): number => {
    const node = base + size(expr) - 1;
    const { mark } = event();
    if (mark.kind !== "choice" || mark.node !== node)
      throw new Error(`expected a choice for node ${node}`);
    return mark.branch;
  };
  const size = (expr: Expr): number => {
    const known = sizes.get(expr);
    if (known === undefined) throw new Error("an expression with no size");
    return known;
  };
  const open = (expr: Expr, base: number): Frame => {
    switch (expr.kind) {
      case "literal":
      case "range":
        return { kind: "leaf", expr };
      case "reference":
        return { kind: "rule", rule: expr.name, start: -1 };
      case "sequence":
        return { kind: "sequence", expr, values: [], next: base };
      case "either":
        return { kind: "either", expr, base, branch: -1 };
      case "optional":
        return { kind: "optional", expr, base, taken: false };
      case "repeat":
        return { kind: "repeat", expr, base, values: [] };
    }
  };

  const frames: Frame[] = [{ kind: "rule", rule, start: -1 }];
  /**
   * The value the frame just popped produced, waiting to be handed to the frame
   * below it.
   */
  let value: unknown;
  let delivered = false;

  for (let top = frames.pop(); top !== undefined; top = frames.pop()) {
    const received = delivered;
    delivered = false;
    let child: Frame | undefined;
    let result: unknown;

    switch (top.kind) {
      case "rule": {
        if (!received) {
          rulemark("enter", top.rule);
          top.start = cursor;
          const body = bodies.get(top.rule);
          if (body === undefined) throw new Error(`no rule ${top.rule}`);
          child = open(body, 0);
        } else {
          rulemark("exit", top.rule);
          const span = new SourceSpan(source, top.start, cursor);
          result = new ParsedNode(source, top.rule, span, value);
        }
        break;
      }
      case "leaf": {
        const { expr } = top;
        if (expr.kind === "literal") {
          result = expr.value;
          cursor += expr.value.length;
        } else {
          const point = input.codePointAt(cursor) ?? 0;
          const width = point > 0xffff ? 2 : 1;
          result = input.slice(cursor, cursor + width);
          cursor += width;
        }
        break;
      }
      case "sequence": {
        if (received) top.values.push(value);
        const item = top.expr.items[top.values.length];
        if (item === undefined) {
          result = top.values;
        } else {
          child = open(item, top.next);
          top.next += size(item);
        }
        break;
      }
      case "either": {
        if (!received) {
          top.branch = choice(top.expr, top.base);
          let base = top.base;
          for (let index = 0; index < top.branch; index += 1)
            base += size(alternative(top.expr, index));
          child = open(alternative(top.expr, top.branch), base);
        } else {
          result = { alternative: top.branch, value };
        }
        break;
      }
      case "optional": {
        if (received) result = value;
        else if (choice(top.expr, top.base) === 1)
          child = open(top.expr.body, top.base);
        else result = undefined;
        break;
      }
      case "repeat": {
        if (received) top.values.push(value);
        if (choice(top.expr, top.base) === 1)
          child = open(top.expr.body, top.base);
        else result = top.values;
        break;
      }
    }

    if (child !== undefined) {
      frames.push(top, child);
    } else {
      value = result;
      delivered = true;
    }
  }

  if (at !== events.length || cursor !== input.length)
    throw new Error("the trace was not fully replayed");
  return value;
}

function alternative(expr: Either, index: number): Expr {
  const found = expr.alternatives[index];
  if (found === undefined) throw new Error(`no alternative ${index}`);
  return found;
}
