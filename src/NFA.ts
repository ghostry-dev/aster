import { checkThrough } from "./Check";
import { codePoint, codePoints, type CodePointSet } from "./CodePoints";
import { AsterError } from "./Error";
import type { Expr, Grammar } from "./Types";
import { fold } from "./Walk";

/**
 * Something the parser records when a thread passes a `mark` instruction. The
 * marks on the winning path are everything the AST fold needs:
 *
 * - `enter`/`exit` bracket every occurrence of a named rule, giving its span.
 * - `choice` records each decision taken at a split: which alternative of an
 *   `either`, whether an `optional` was taken (`1`) or skipped (`0`), and for a
 *   repetition, `1` before every iteration and `0` when it stops. `node`
 *   identifies the combinator by its post-order index within its rule's body,
 *   so a fold walking the body can match each choice to the node it decides.
 *
 * Literals and ranges need no marks: given the choices, each consumes a known
 * number of code points.
 */
export type Mark =
  | { readonly kind: "enter"; readonly rule: string }
  | { readonly kind: "exit"; readonly rule: string }
  | { readonly kind: "choice"; readonly node: number; readonly branch: number };

/**
 * One NFA state. A Thompson NFA in program form, as RE2 and Rust's `regex`
 * build it: states are an array and transitions are indices into it.
 *
 * - `char`: consume one code point in `set`, then go to `next`.
 * - `split`: an ε-fork. `first` is preferred over `second`, which is how JS regex
 *   priority (alternatives left to right, greedy quantifiers) is encoded. A
 *   parser that keeps the highest-priority thread per state picks the same
 *   derivation backtracking would.
 * - `jump`: an ε-move to `next`.
 * - `mark`: an ε-move to `next` that records `mark` on the thread's trace.
 * - `match`: accept, if the input is exhausted.
 */
export type Instruction =
  | { readonly op: "char"; readonly set: CodePointSet; next: number }
  | { readonly op: "split"; first: number; second: number }
  | { readonly op: "jump"; next: number }
  | { readonly op: "mark"; readonly mark: Mark; next: number }
  | { readonly op: "match" };

/**
 * A compiled rule: `start` is the entry state, and exactly one state is
 * `match`. The program begins with the rule's own `enter` mark and ends with
 * its `exit` mark before `match`.
 */
export interface Program {
  readonly rule: string;
  readonly instructions: readonly Instruction[];
  readonly start: number;
}

/**
 * An NFA fragment under construction. Its states occupy `[low, high)` of the
 * instruction array; `hole` is the one state whose `next` is not yet set.
 *
 * Every fragment has exactly one hole. Where several paths leave a fragment
 * (the alternatives of an `either`, the two outcomes of an `optional`), they
 * meet at a `jump` that becomes the single hole. That costs one ε-state per
 * join and makes construction linear: patching is one assignment, never a walk
 * over a list of dangling exits.
 */
interface Fragment {
  readonly low: number;
  readonly high: number;
  readonly start: number;
  readonly hole: number;
}

const HOLE = -1;

/**
 * Compile `rule` to a Thompson NFA.
 *
 * Rules are compiled one at a time in definition order, each into its own
 * fragment, so a reference finds the referenced rule already built and inlines
 * a copy of it between that rule's `enter` and `exit` marks. Building per rule
 * is what leaves room for `.recursive()` later: a recursive reference would
 * become a call to another rule's fragment instead of a copy.
 *
 * The grammar is checked first, as `toPattern` checks it, so a grammar that
 * arrived as data is validated before it compiles.
 */
export function compile(grammar: Grammar, rule: string): Program {
  const last = grammar.rules.findIndex(
    (definition) => definition.name === rule,
  );
  if (last === -1) throw new AsterError.UnknownRuleError(rule);
  checkThrough(grammar.rules, last);

  const compiled = new Map<string, readonly Instruction[]>();
  for (let index = 0; index <= last; index += 1) {
    const definition = grammar.rules[index];
    if (definition === undefined) break;
    compiled.set(
      definition.name,
      compileRule(definition.name, definition.body, compiled),
    );
  }

  const instructions = [...(compiled.get(rule) ?? [])];
  const end = instructions.length;
  instructions.push({ op: "match" });
  patch(instructions, holeOf(instructions), end);
  return { rule, instructions, start: 0 };
}

/**
 * One rule as a standalone fragment that starts at index 0 and spans its whole
 * array: `enter` mark, body, `exit` mark, with the `exit` mark's `next` left as
 * the hole.
 */
function compileRule(
  rule: string,
  body: Expr,
  compiled: ReadonlyMap<string, readonly Instruction[]>,
): readonly Instruction[] {
  const instructions: Instruction[] = [];
  const builder = new Builder(instructions);
  let node = 0;

  const enter = builder.mark({ kind: "enter", rule });
  const inner = fold<Fragment>(
    body,
    () => {},
    (expr, own) => builder.lower(expr, own, node++, compiled),
  );
  const exit = builder.mark({ kind: "exit", rule });

  patch(instructions, enter.hole, inner.start);
  patch(instructions, inner.hole, exit.start);

  /**
   * The `enter` mark was appended first, so it is at index 0 and the fragment
   * starts there; the whole array is the rule's fragment.
   */
  return instructions;
}

class Builder {
  constructor(private readonly instructions: Instruction[]) {}

  lower(
    expr: Expr,
    own: readonly Fragment[],
    node: number,
    compiled: ReadonlyMap<string, readonly Instruction[]>,
  ): Fragment {
    switch (expr.kind) {
      case "literal":
        return this.literal(expr.value);
      case "range":
        return this.char([
          [codePoint(expr.from) ?? 0, codePoint(expr.to) ?? 0],
        ]);
      case "reference":
        return this.inline(compiled.get(expr.name) ?? []);
      case "sequence":
        return this.sequence(own);
      case "either":
        return this.either(own, node);
      case "optional":
        return this.optional(first(own), node);
      case "repeat":
        return this.repeat(first(own), expr.min, expr.max, node);
    }
  }

  /**
   * Append a state and return its index.
   */
  private push(instruction: Instruction): number {
    this.instructions.push(instruction);
    return this.instructions.length - 1;
  }

  private get end(): number {
    return this.instructions.length;
  }

  private single(at: number): Fragment {
    return { low: at, high: at + 1, start: at, hole: at };
  }

  char(set: CodePointSet): Fragment {
    return this.single(this.push({ op: "char", set, next: HOLE }));
  }

  mark(mark: Mark): Fragment {
    return this.single(this.push({ op: "mark", mark, next: HOLE }));
  }

  epsilon(): Fragment {
    return this.single(this.push({ op: "jump", next: HOLE }));
  }

  literal(value: string): Fragment {
    const low = this.end;
    const points = codePoints(value);
    if (points.length === 0) return this.epsilon();
    let previous: Fragment | undefined;
    for (const point of points) {
      const current = this.char([[point, point]]);
      if (previous !== undefined)
        patch(this.instructions, previous.hole, current.start);
      previous = current;
    }
    const last = previous ?? this.epsilon();
    return { low, high: this.end, start: low, hole: last.hole };
  }

  sequence(parts: readonly Fragment[]): Fragment {
    const [head] = parts;
    if (head === undefined) return this.epsilon();
    let previous = head;
    for (let index = 1; index < parts.length; index += 1) {
      const current = parts[index];
      if (current === undefined) break;
      patch(this.instructions, previous.hole, current.start);
      previous = current;
    }
    return {
      low: head.low,
      high: this.end,
      start: head.start,
      hole: previous.hole,
    };
  }

  /**
   * A chain of splits, each preferring the next alternative in order, with a
   * `choice` mark at the head of each alternative and one join after them.
   */
  either(alternatives: readonly Fragment[], node: number): Fragment {
    const low = alternatives[0]?.low ?? this.end;
    const join = this.epsilon();
    const heads = alternatives.map((alternative, branch) => {
      const mark = this.mark({ kind: "choice", node, branch });
      patch(this.instructions, mark.hole, alternative.start);
      patch(this.instructions, alternative.hole, join.start);
      return mark.start;
    });

    let start = heads[heads.length - 1] ?? join.start;
    for (let index = heads.length - 2; index >= 0; index -= 1) {
      start = this.push({
        op: "split",
        first: heads[index] ?? join.start,
        second: start,
      });
    }
    return { low, high: this.end, start, hole: join.hole };
  }

  /**
   * Prefer taking the body, as a greedy `?` does.
   */
  optional(body: Fragment, node: number): Fragment {
    const join = this.epsilon();
    const take = this.mark({ kind: "choice", node, branch: 1 });
    const skip = this.mark({ kind: "choice", node, branch: 0 });
    patch(this.instructions, take.hole, body.start);
    patch(this.instructions, body.hole, join.start);
    patch(this.instructions, skip.hole, join.start);
    const start = this.push({
      op: "split",
      first: take.start,
      second: skip.start,
    });
    return { low: body.low, high: this.end, start, hole: join.hole };
  }

  /**
   * Unrolled, as RE2 does: `min` required copies of the body, then either a
   * loop (no `max`) or `max - min` nested optional copies. Every iteration is
   * preceded by a `1` choice and the repetition ends with a `0` choice, so the
   * fold can count iterations without knowing the bounds. Each split prefers
   * another iteration, which is what makes the repetition greedy.
   *
   * The body was already emitted once; further copies are cloned from its
   * contiguous range. A large bound therefore costs states in proportion to the
   * bound.
   */
  repeat(
    body: Fragment,
    min: number,
    max: number | undefined,
    node: number,
  ): Fragment {
    /**
     * Every copy is cloned before anything is patched, while the body's hole is
     * still a hole; a clone taken after patching would carry a target outside
     * its own range.
     */
    const count = min + (max === undefined ? 1 : max - min);
    const bodies: Fragment[] = [body];
    for (let index = 1; index < count; index += 1)
      bodies.push(this.clone(body));

    const join = this.epsilon();
    const stop = this.mark({ kind: "choice", node, branch: 0 });
    patch(this.instructions, stop.hole, join.start);

    let start = HOLE;
    let hole = HOLE;
    const connect = (entry: number): void => {
      if (start === HOLE) start = entry;
      else patch(this.instructions, hole, entry);
    };
    const iteration = (index: number): { entry: number; exit: number } => {
      const mark = this.mark({ kind: "choice", node, branch: 1 });
      const copy = bodies[index] ?? body;
      patch(this.instructions, mark.hole, copy.start);
      return { entry: mark.start, exit: copy.hole };
    };

    let index = 0;
    for (; index < min; index += 1) {
      const required = iteration(index);
      connect(required.entry);
      hole = required.exit;
    }

    if (max === undefined) {
      const loop = iteration(index);
      const fork = this.push({
        op: "split",
        first: loop.entry,
        second: stop.start,
      });
      patch(this.instructions, loop.exit, fork);
      connect(fork);
    } else {
      for (; index < max; index += 1) {
        const extra = iteration(index);
        const fork = this.push({
          op: "split",
          first: extra.entry,
          second: stop.start,
        });
        connect(fork);
        hole = extra.exit;
      }
      connect(stop.start);
    }

    return { low: body.low, high: this.end, start, hole: join.hole };
  }

  /**
   * Copy another rule's compiled fragment to the end of this array.
   */
  inline(source: readonly Instruction[]): Fragment {
    return this.copyRange(source, 0, source.length, holeOf(source));
  }

  /**
   * Copy a fragment of this array to its end.
   */
  private clone(fragment: Fragment): Fragment {
    return this.copyRange(
      this.instructions,
      fragment.low,
      fragment.high,
      fragment.hole,
      fragment.start,
    );
  }

  /**
   * Append a copy of `source[low, high)`, relocating every target inside the
   * range. A fragment's targets all fall inside its own range, apart from its
   * hole, which stays a hole.
   */
  private copyRange(
    source: readonly Instruction[],
    low: number,
    high: number,
    hole: number,
    start: number = low,
  ): Fragment {
    const offset = this.end - low;
    const move = (target: number): number =>
      target === HOLE ? HOLE : target + offset;
    for (let index = low; index < high; index += 1) {
      const instruction = source[index];
      if (instruction === undefined) break;
      switch (instruction.op) {
        case "char":
          this.push({
            op: "char",
            set: instruction.set,
            next: move(instruction.next),
          });
          break;
        case "jump":
          this.push({ op: "jump", next: move(instruction.next) });
          break;
        case "mark":
          this.push({
            op: "mark",
            mark: instruction.mark,
            next: move(instruction.next),
          });
          break;
        case "split":
          this.push({
            op: "split",
            first: move(instruction.first),
            second: move(instruction.second),
          });
          break;
        case "match":
          this.push({ op: "match" });
          break;
      }
    }
    return {
      low: low + offset,
      high: this.end,
      start: start + offset,
      hole: hole + offset,
    };
  }
}

function first(own: readonly Fragment[]): Fragment {
  const [body] = own;
  if (body === undefined)
    throw new Error("a combinator with a body has one subexpression");
  return body;
}

/**
 * Point the hole at `target`. Holes are only ever in `next` fields: every
 * `split` is built with both targets known.
 */
function patch(
  instructions: Instruction[],
  hole: number,
  target: number,
): void {
  const instruction = instructions[hole];
  if (
    instruction === undefined
    || instruction.op === "split"
    || instruction.op === "match"
  ) {
    throw new Error(`state ${hole} is not a hole`);
  }
  instruction.next = target;
}

/**
 * The one state of a compiled rule whose `next` is still a hole.
 */
function holeOf(instructions: readonly Instruction[]): number {
  for (let index = instructions.length - 1; index >= 0; index -= 1) {
    const instruction = instructions[index];
    if (
      instruction !== undefined
      && "next" in instruction
      && instruction.next === HOLE
    ) {
      return index;
    }
  }
  throw new Error("a compiled rule has one hole");
}
