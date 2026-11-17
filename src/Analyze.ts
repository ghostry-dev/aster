import { contains, intersect, merge, type CodePointSet } from "./CodePoints";
import type { Regex } from "./Emit";
import type { Analysis, Attack } from "./Types";

/**
 * Static ReDoS analysis of an emitted pattern: how many ways a backtracking
 * engine can match the same input, as a function of its length.
 *
 * A backtracking engine that fails to match explores every path through the
 * pattern consistent with the input, so its running time follows the number of
 * those paths. Weber and Seidl's criteria, as Weideman et al. apply them to
 * ReDoS, decide how that number grows:
 *
 * - **Exponential (EDA)**: some state `q` has two distinct paths from `q` back to
 *   `q` on the same word `w`. Each repetition of `w` doubles the paths.
 * - **Polynomial (IDA)**: distinct states `p` and `q` have paths `p → p`, `p →
 *   q`, and `q → q` on the same word. A chain of `k` such links gives `nᵏ`
 *   paths, and the engine runs in `nᵏ⁺¹`.
 *
 * A match that succeeds stops at its first accepting path, so priority decides
 * which ambiguities cost time. The analysis runs in two passes. The first
 * ignores priority, treating every path as failing: it never misses a slow
 * pattern, and if it finds none, the pattern is linear. Otherwise the second
 * pass accounts for priority with a look-ahead, which makes the answer exact
 * for a backtracking engine, within a budget of steps; past it, the first
 * pass's finding stands, marked inexact. It reads the structure the emitter
 * wrote (`Regex`), after class collapsing, since that is what the engine runs:
 * `[a-c]|[b-d]` in a loop is ambiguous, `[a-d]` is not.
 *
 * Every walk is a loop over an explicit worklist, like every other walk here.
 *
 * @module
 */

const ANY: CodePointSet = [[0, 0x10ffff]];

/**
 * The named rules enclosing a state, innermost first.
 */
interface Rules {
  readonly name: string;
  readonly parent: Rules | null;
  readonly depth: number;
}

/**
 * A Thompson ε-NFA state. `split` may have any number of targets, in priority
 * order: the engine tries the first one first.
 */
type State =
  | {
      readonly op: "char";
      readonly set: CodePointSet;
      readonly rules: Rules | null;
      next: number;
    }
  | {
      readonly op: "split";
      readonly targets: readonly number[];
      readonly rules: Rules | null;
    }
  | { readonly op: "jump"; readonly rules: Rules | null; next: number }
  | { readonly op: "accept" };

interface Fragment {
  readonly start: number;
  readonly hole: number;
}

/**
 * The automaton the analysis searches, over the `char` states of a Thompson
 * ε-NFA. Being at a `char` state means its set is the next code point consumed.
 * `successors(c)` is where the automaton can be after consuming it: the `char`
 * states its ε-closure reaches, each with how many distinct ε-paths lead there
 * (1, or 2 for "more than one"). A backtracking engine tries each ε-path
 * separately, so two of them are two paths: `(?:|)a` in a loop is exponential.
 *
 * Successors are computed lazily, per state, and only for the states a search
 * touches. Removing every ε-move up front costs O(m²) on a run of optionals,
 * `x?x?x?…`, where each `x` reaches every later one; but only states on or
 * between loops can be ambiguous, and a pattern without loops never asks.
 * Components and reachability are found on the ε-NFA itself, which is linear in
 * the pattern.
 */
class Automaton {
  readonly #closures = new Map<number, ReadonlyMap<number, number>>();
  readonly #scopes = new Map<number, ReadonlyMap<number, Rules | null>>();
  readonly #ordered = new Map<number, readonly number[]>();
  #accept: number | undefined;
  #reverse: readonly (readonly number[])[] | undefined;

  constructor(
    readonly states: readonly State[],
    readonly start: number,
  ) {}

  /**
   * ε-NFA edges: a `char` state's `next`, a `split`'s targets, a `jump`'s
   * `next`.
   */
  edges(at: number): readonly number[] {
    const state = this.states[at];
    switch (state?.op) {
      case "char":
      case "jump":
        return [state.next];
      case "split":
        return state.targets;
      default:
        return [];
    }
  }

  reverse(at: number): readonly number[] {
    if (this.#reverse === undefined) {
      const reverse: number[][] = this.states.map(() => []);
      this.states.forEach((_, from) => {
        for (const to of this.edges(from)) reverse[to]?.push(from);
      });
      this.#reverse = reverse;
    }
    return this.#reverse[at] ?? [];
  }

  isChar(at: number): boolean {
    return this.states[at]?.op === "char";
  }

  /**
   * The `accept` state. There is exactly one, pushed after the pattern.
   */
  get accept(): number {
    if (this.#accept === undefined) {
      const at = this.states.findIndex((state) => state.op === "accept");
      if (at === -1) throw new Error("an automaton with no accept state");
      this.#accept = at;
    }
    return this.#accept;
  }

  /**
   * The `char` and `accept` states the ε-region from `from` reaches, in the
   * order a backtracking engine first reaches them: a depth-first walk taking
   * each split's targets in priority order. Skipping a state already visited
   * keeps that order, because the first visit explored everything after it.
   */
  ordered(from: number): readonly number[] {
    const known = this.#ordered.get(from);
    if (known !== undefined) return known;
    const out: number[] = [];
    const seen = new Set<number>();
    const stack = [from];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      if (seen.has(at)) continue;
      seen.add(at);
      const op = this.states[at]?.op;
      if (op === "char" || op === "accept") {
        out.push(at);
        continue;
      }
      const targets = this.edges(at);
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        const target = targets[index];
        if (target !== undefined && !seen.has(target)) stack.push(target);
      }
    }
    this.#ordered.set(from, out);
    return out;
  }

  set(at: number): CodePointSet {
    const state = this.states[at];
    return state?.op === "char" ? state.set : [];
  }

  rules(at: number): Rules | null {
    const state = this.states[at];
    return state === undefined || state.op === "accept" ? null : state.rules;
  }

  /**
   * The innermost rule enclosing every state on every ε-path from `char` state
   * `from` to `to`, the states themselves included. A loop that leaves a rule
   * and re-enters it passes through the rule around it, and that is where the
   * ambiguity is: `(?:word| )*` splits a run of letters across iterations of
   * the outer loop, not inside `word`.
   */
  scope(from: number, to: number): Rules | null {
    this.successors(from);
    return this.#scopes.get(from)?.get(to) ?? this.rules(from);
  }

  successors(at: number): ReadonlyMap<number, number> {
    const known = this.#closures.get(at);
    if (known !== undefined) return known;
    const state = this.states[at];
    if (state?.op !== "char") return new Map();
    const { counts, scopes } = this.#closure(state.next);
    const own = this.rules(at);
    this.#closures.set(at, counts);
    this.#scopes.set(
      at,
      new Map([...scopes].map(([to, scope]) => [to, ancestor(own, scope)])),
    );
    return counts;
  }

  /**
   * The `char` states reachable from `from` by ε-moves, counting distinct
   * ε-paths up to 2: order the ε-region from `from` topologically with an
   * iterative post-order walk, then push counts forward along it. Nullable loop
   * bodies are rejected at definition time, so the region is acyclic.
   */
  #closure(from: number): {
    readonly counts: ReadonlyMap<number, number>;
    readonly scopes: ReadonlyMap<number, Rules | null>;
  } {
    const postorder: number[] = [];
    const seen = new Set<number>([from]);
    const done = new Set<number>();
    const pending: { readonly at: number; readonly expanded: boolean }[] = [
      { at: from, expanded: false },
    ];
    for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
      const { at, expanded } = item;
      if (expanded) {
        done.add(at);
        postorder.push(at);
        continue;
      }
      pending.push({ at, expanded: true });
      if (this.isChar(at)) continue;
      for (const next of this.edges(at)) {
        if (seen.has(next)) {
          if (!done.has(next)) throw new Error("an ε-cycle in a pattern");
          continue;
        }
        seen.add(next);
        pending.push({ at: next, expanded: false });
      }
    }
    const counts = new Map<number, number>([[from, 1]]);
    const scopes = new Map<number, Rules | null>([[from, this.rules(from)]]);
    const reached = new Map<number, number>();
    const reachedScopes = new Map<number, Rules | null>();
    for (let index = postorder.length - 1; index >= 0; index -= 1) {
      const at = postorder[index] ?? from;
      const count = counts.get(at) ?? 0;
      const scope = scopes.get(at) ?? null;
      if (this.isChar(at)) {
        reached.set(at, count);
        reachedScopes.set(at, scope);
        continue;
      }
      for (const next of this.edges(at)) {
        counts.set(next, Math.min(2, (counts.get(next) ?? 0) + count));
        const inward = ancestor(scope, this.rules(next));
        scopes.set(
          next,
          scopes.has(next)
            ? ancestor(scopes.get(next) ?? null, inward)
            : inward,
        );
      }
    }
    return { counts: reached, scopes: reachedScopes };
  }
}

/**
 * Analyze the pattern a fragment's structure describes. `root` is the name of
 * the rule the pattern is for, which a finding names when no inner rule
 * encloses it. An unanchored pattern is searched for at every start offset,
 * which the analysis models as a leading `[^]*?`: that is why `a*b` is
 * quadratic as a search and linear when anchored.
 *
 * The sound search runs first, on the automaton alone. Only a superlinear
 * finding is refined by the exact search, which can lower its severity but
 * never raise it, within `budget` steps. Past the budget the sound finding
 * stands, marked inexact.
 */
export function analyze(
  regex: Regex,
  root: string,
  anchored: boolean,
  budget: number,
): Analysis {
  const automaton = new Automaton(...thompson(regex, anchored));
  const sound = soundly(automaton, root);
  if (sound.complexity === "linear" || budget <= 0) return sound;
  try {
    return exactly(automaton, root, anchored, new Budget(budget));
  } catch (error) {
    if (error instanceof OverBudget) return sound;
    throw error;
  }
}

/**
 * The priority-free analysis: every path is assumed to fail, so every ambiguity
 * counts. Components and loops are found on the ε-NFA, which is linear in the
 * pattern, and ε-closures are computed only for the states a product search
 * touches, so a pattern with no loops never computes one.
 */
function soundly(automaton: Automaton, root: string): Analysis {
  const space: Space = {
    automaton,
    looks: 1,
    moves: (_, set) => [{ char: representative(set), look: 0 }],
    next: (state) => automaton.successors(state),
    edges: (at) => automaton.edges(at),
    reverse: (at) => automaton.reverse(at),
    isChar: (at) => automaton.isChar(at),
    spend: () => undefined,
  };
  const { order, component } = components(automaton.states.keys(), (at) =>
    automaton.edges(at),
  );
  /**
   * A component of the ε-NFA has a cycle when it has more than one state: a
   * `char` state never steps to itself directly, and there are no ε-cycles.
   * Every cycle passes through a `char` state, so the `char` states of a cyclic
   * component are a strongly connected component of the automaton.
   */
  const loops = order.map((members) =>
    members.length > 1 ? members.filter((at) => automaton.isChar(at)) : [],
  );
  return report(
    find(space, order, loops, component),
    automaton,
    root,
    false,
    (pump) => attack(automaton, pump.at, pump.pump),
  );
}

/**
 * The priority-aware analysis. A backtracking attempt succeeds at the first
 * path that reaches `accept` and fails only after trying every path. The
 * look-ahead says, for the input remaining at any point, which states would
 * succeed on it. The search runs on pairs of a state and a look-ahead, over the
 * steps the engine actually takes:
 *
 * - From a state that would succeed, the engine tries its successors in priority
 *   order up to and including the first that succeeds, and never reaches the
 *   rest. It reaches that successor by its first ε-path only, so the others do
 *   not count. The states that would succeed therefore form a single path for a
 *   given input, which can carry no ambiguity of its own but can start a
 *   polynomial link: a search retrying offsets before a match further on runs
 *   every failing attempt in full.
 * - Everything a failing state reaches on the same input fails too, so from a
 *   failing state the engine takes every step, along every ε-path, as the sound
 *   analysis assumes.
 *
 * Every copy in a product search shares one look-ahead, since all copies read
 * one input.
 */
function exactly(
  automaton: Automaton,
  root: string,
  anchored: boolean,
  budget: Budget,
): Analysis {
  const lookahead = new Lookahead(automaton, anchored, budget);
  const looks = lookahead.size;
  if (automaton.states.length * looks > Number.MAX_SAFE_INTEGER)
    throw new OverBudget();
  const node = (state: number, look: number): number => state * looks + look;
  const accept = automaton.accept;

  /**
   * The targets of an ordered closure the engine tries when the remaining input
   * has look-ahead `look`: all of them up to and including the first that
   * succeeds. `accept` succeeds where the look-ahead contains it, and otherwise
   * (anchored, before the end) is a dead end the engine backs out of.
   */
  const tried = (
    targets: readonly number[],
    look: number,
  ): { readonly targets: number[]; readonly succeeds: boolean } => {
    const out: number[] = [];
    for (const target of targets) {
      const succeeds = lookahead.succeeds(look, target);
      if (target === accept) {
        if (succeeds) return { targets: out, succeeds };
        continue;
      }
      out.push(target);
      if (succeeds) return { targets: out, succeeds };
    }
    return { targets: out, succeeds: false };
  };

  /**
   * The steps out of `state` into look-ahead `after`, with how many ε-paths the
   * engine takes to each: every one from a failing state, the first from one
   * that succeeds.
   */
  const steps = new Map<number, ReadonlyMap<number, number>>();
  const next = (state: number, after: number): ReadonlyMap<number, number> => {
    const key = node(state, after);
    const known = steps.get(key);
    if (known !== undefined) return known;
    const { targets, succeeds } = tried(
      automaton.ordered(automaton.edges(state)[0] ?? state),
      after,
    );
    const out = succeeds
      ? new Map(targets.map((target) => [target, 1]))
      : automaton.successors(state);
    steps.set(key, out);
    return out;
  };

  /**
   * Reachable pairs, breadth first from every way the input can begin, with the
   * step that first reached each, for the attack's prefix, and their edges.
   */
  const parent = new Map<
    number,
    { readonly from: number; readonly char: number } | null
  >();
  const edges = new Map<number, number[]>();
  const queue: number[] = [];
  const entry = automaton.ordered(automaton.start);
  for (let look = 0; look < looks; look += 1)
    for (const target of tried(entry, look).targets) {
      const at = node(target, look);
      if (parent.has(at)) continue;
      budget.spend();
      parent.set(at, null);
      queue.push(at);
    }
  for (let index = 0; index < queue.length; index += 1) {
    const at = queue[index] ?? 0;
    const state = Math.floor(at / looks);
    const look = at % looks;
    const out: number[] = [];
    for (const move of lookahead.moves(look, automaton.set(state)))
      for (const target of next(state, move.look).keys()) {
        budget.spend();
        const to = node(target, move.look);
        if (!out.includes(to)) out.push(to);
        if (parent.has(to)) continue;
        parent.set(to, { from: at, char: move.char });
        queue.push(to);
      }
    edges.set(at, out);
  }

  const reverse = new Map<number, number[]>();
  for (const [from, targets] of edges)
    for (const to of targets) {
      const list = reverse.get(to);
      if (list === undefined) reverse.set(to, [from]);
      else list.push(from);
    }
  const space: Space = {
    automaton,
    looks,
    moves: (look, set) => lookahead.moves(look, set),
    next,
    edges: (at) => edges.get(at) ?? [],
    reverse: (at) => reverse.get(at) ?? [],
    isChar: () => true,
    spend: () => budget.spend(),
  };
  const { order, component } = components(edges.keys(), space.edges);
  const loops = order.map((members) => {
    const [only] = members;
    return members.length > 1
      || (only !== undefined && space.edges(only).includes(only))
      ? members
      : [];
  });
  return report(
    find(space, order, loops, component),
    automaton,
    root,
    true,
    (pump) => {
      const chars: number[] = [];
      for (
        let step = parent.get(pump.at);
        step !== undefined && step !== null;
        step = parent.get(step.from)
      )
        chars.push(step.char);
      return {
        prefix: String.fromCodePoint(...chars.reverse()),
        pump: pump.pump,
        suffix: lookahead.suffix(pump.at % looks),
      };
    },
  );
}

/**
 * The graph an ambiguity search runs on. A node is a state and a look-ahead,
 * `state * looks + look`. The sound search has one look-ahead, in which nothing
 * succeeds, so its nodes are the automaton's states and its graph the ε-NFA.
 */
interface Space {
  readonly automaton: Automaton;
  readonly looks: number;
  /**
   * The steps on a code point from `set` out of look-ahead `look`: the
   * look-ahead of the input after it, with a code point that leads there.
   */
  moves(look: number, set: CodePointSet): readonly Move[];
  /**
   * The states the engine steps to from `state` when the input after the step
   * has look-ahead `after`, with how many ε-paths it takes to each, up to 2.
   */
  next(state: number, after: number): ReadonlyMap<number, number>;
  /**
   * The graph that components, loops, and reachability between loops are found
   * on, and whether a node consumes a code point.
   */
  edges(node: number): readonly number[];
  reverse(node: number): readonly number[];
  isChar(node: number): boolean;
  /**
   * Called once per product step, so the exact search stays within its budget.
   */
  spend(): void;
}

interface Move {
  readonly char: number;
  readonly look: number;
}

/**
 * The search a sound and an exact analysis share: exponential ambiguity in a
 * loop, nearest the start first, else the longest chain of polynomial links.
 */
type Finding =
  | { readonly complexity: "exponential"; readonly pump: Pump }
  | {
      readonly complexity: "polynomial";
      readonly links: number;
      readonly pump: Pump;
    }
  | undefined;

function find(
  space: Space,
  order: readonly (readonly number[])[],
  loops: readonly (readonly number[])[],
  component: ReadonlyMap<number, number>,
): Finding {
  /**
   * Tarjan emits components in reverse topological order, so the loop nearest
   * the start is last.
   */
  for (let c = loops.length - 1; c >= 0; c -= 1) {
    const members = loops[c] ?? [];
    if (members.length === 0) continue;
    const pump = exponential(members, space);
    if (pump !== undefined) return { complexity: "exponential", pump };
  }
  const found = polynomial(order, loops, component, space);
  if (found === undefined) return undefined;
  return { complexity: "polynomial", links: found.links, pump: found };
}

function report(
  finding: Finding,
  automaton: Automaton,
  root: string,
  exact: boolean,
  attackOf: (pump: Pump) => Attack,
): Analysis {
  if (finding === undefined) return { complexity: "linear" };
  const rule = enclosing(finding.pump.edges, automaton, root);
  const attack = attackOf(finding.pump);
  return finding.complexity === "exponential"
    ? { complexity: "exponential", rule, attack, exact }
    : {
        complexity: "polynomial",
        degree: finding.links + 1,
        rule,
        attack,
        exact,
      };
}

/**
 * Thrown when the exact search runs out of budget, and caught by `analyze`,
 * which falls back to the sound finding.
 */
class OverBudget extends Error {}

class Budget {
  #left: number;

  constructor(steps: number) {
    this.#left = steps;
  }

  spend(): void {
    this.#left -= 1;
    if (this.#left < 0) throw new OverBudget();
  }
}

/**
 * A deterministic automaton that reads the input backwards. Its state at an
 * offset is the set of states that would succeed on the input from there: a
 * `char` state that accepts the next code point and whose ε-closure reaches one
 * that succeeds on the rest, plus `accept` wherever reaching it is success,
 * which is everywhere for a search and only at the end when anchored.
 *
 * It is built by subset construction from the end of the input over atoms, the
 * ranges into which every `char` state's set cuts the code points, so that two
 * code points in one atom behave the same everywhere. Each state remembers the
 * step that first reached it, so a shortest input with a given look-ahead can
 * be read back as an attack's suffix.
 */
class Lookahead {
  readonly #automaton: Automaton;
  readonly #atoms: readonly (readonly [number, number])[];
  readonly #members: ReadonlySet<number>[] = [];
  /**
   * `#back[look].get(atom)`: every look-ahead that `atom` steps back to `look`
   * from, which is what the input after that atom can have.
   */
  readonly #back: Map<number, number[]>[] = [];
  readonly #parent: ({
    readonly from: number;
    readonly char: number;
  } | null)[] = [];
  readonly #moves = new Map<string, readonly Move[]>();

  constructor(automaton: Automaton, anchored: boolean, budget: Budget) {
    this.#automaton = automaton;
    this.#atoms = atoms(automaton);
    const { accept } = automaton;
    const ids = new Map<string, number>();
    const intern = (
      members: readonly number[],
      parent: { readonly from: number; readonly char: number } | null,
    ): number => {
      const key = members.join(",");
      const known = ids.get(key);
      if (known !== undefined) return known;
      budget.spend();
      const id = this.#members.length;
      ids.set(key, id);
      this.#members.push(new Set(members));
      this.#back.push(new Map());
      this.#parent.push(parent);
      return id;
    };
    intern([accept], null);
    for (let look = 0; look < this.#members.length; look += 1) {
      const before = this.#before(this.#members[look] ?? new Set());
      this.#atoms.forEach((atom, index) => {
        budget.spend();
        const members = before.filter((state) =>
          contains(automaton.set(state), atom[0]),
        );
        if (!anchored) members.push(accept);
        members.sort((x, y) => x - y);
        const step = { from: look, char: representative([atom]) };
        const to = intern(members, step);
        /**
         * Any atom from the same look-ahead gives as short a suffix, so prefer
         * one that reads.
         */
        const first = this.#parent[to];
        if (
          first?.from === look
          && !printable(first.char)
          && printable(step.char)
        )
          this.#parent[to] = step;
        const back = this.#back[to];
        const list = back?.get(index);
        if (list === undefined) back?.set(index, [look]);
        else list.push(look);
      });
    }
  }

  get size(): number {
    return this.#members.length;
  }

  succeeds(look: number, state: number): boolean {
    return this.#members[look]?.has(state) ?? false;
  }

  /**
   * The `char` states whose ε-closure reaches a member: a backward walk over
   * ε-moves from the members, stopping at the `char` states it meets.
   */
  #before(members: ReadonlySet<number>): number[] {
    const out = new Set<number>();
    const seen = new Set(members);
    const queue = [...members];
    for (let index = 0; index < queue.length; index += 1) {
      for (const from of this.#automaton.reverse(queue[index] ?? 0)) {
        if (this.#automaton.isChar(from)) out.add(from);
        else if (!seen.has(from)) {
          seen.add(from);
          queue.push(from);
        }
      }
    }
    return [...out];
  }

  moves(look: number, set: CodePointSet): readonly Move[] {
    const key = `${look}:${set.join(";")}`;
    const known = this.#moves.get(key);
    if (known !== undefined) return known;
    const chars = new Map<number, number>();
    const back = this.#back[look];
    for (const index of this.#within(set)) {
      const atom = this.#atoms[index];
      const after = back?.get(index);
      if (atom === undefined || after === undefined) continue;
      const char = representative([atom]);
      for (const to of after) {
        const known = chars.get(to);
        if (known === undefined || (!printable(known) && printable(char)))
          chars.set(to, char);
      }
    }
    const out = [...chars].map(([to, char]) => ({ char, look: to }));
    this.#moves.set(key, out);
    return out;
  }

  /**
   * The atoms inside `set`, which is a union of atoms because every set the
   * search intersects is.
   */
  *#within(set: CodePointSet): Generator<number> {
    for (const [from, to] of set) {
      let low = 0;
      let high = this.#atoms.length - 1;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if ((this.#atoms[middle]?.[1] ?? 0) < from) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < this.#atoms.length; index += 1) {
        const atom = this.#atoms[index];
        if (atom === undefined || atom[0] > to) break;
        yield index;
      }
    }
  }

  /**
   * A shortest input whose look-ahead is `look`, read back from the steps that
   * first reached it: each step prepends a code point.
   */
  suffix(look: number): string {
    const chars: number[] = [];
    for (
      let step = this.#parent[look];
      step !== undefined && step !== null;
      step = this.#parent[step.from]
    )
      chars.push(step.char);
    return String.fromCodePoint(...chars);
  }
}

/**
 * The ranges into which every `char` state's set cuts the code points, in order
 * and covering all of them.
 */
function atoms(automaton: Automaton): (readonly [number, number])[] {
  const cuts = new Set<number>([0]);
  for (const state of automaton.states)
    if (state.op === "char")
      for (const [from, to] of state.set) {
        cuts.add(from);
        if (to < 0x10ffff) cuts.add(to + 1);
      }
  const sorted = [...cuts].sort((x, y) => x - y);
  return sorted.map((from, index) => [
    from,
    (sorted[index + 1] ?? 0x110000) - 1,
  ]);
}

function printable(point: number): boolean {
  return point >= 0x21 && point <= 0x7e;
}

/**
 * Compile a regex tree to a Thompson ε-NFA, walking the tree post-order with an
 * explicit stack. Shared nodes are visited once per occurrence, so each
 * occurrence gets its own states, as each occurrence in the pattern text is
 * matched separately. A counted repetition is expanded into its required copies
 * and then nested optional copies, `x{1,3}` as `x(?:x(?:x)?)?`: that is how a
 * counter behaves, where `xx?x?` would add ambiguity the engine does not have.
 */
function thompson(root: Regex, anchored: boolean): [readonly State[], number] {
  const states: State[] = [];
  const push = (state: State): number => {
    states.push(state);
    return states.length - 1;
  };
  const patch = (hole: number, target: number): void => {
    const state = states[hole];
    if (state === undefined || state.op === "split" || state.op === "accept")
      throw new Error(`state ${hole} is not a hole`);
    state.next = target;
  };
  /**
   * The rules enclosing the node being glued, which every state it creates is
   * in, ε-states included: a finding names the rules its ε-paths pass through
   * as well as its `char` states.
   */
  let current: Rules | null = null;
  const epsilon = (): Fragment => {
    const at = push({ op: "jump", rules: current, next: -1 });
    return { start: at, hole: at };
  };
  const chain = (parts: readonly Fragment[]): Fragment => {
    const [head] = parts;
    if (head === undefined) return epsilon();
    let previous = head;
    for (const part of parts.slice(1)) {
      patch(previous.hole, part.start);
      previous = part;
    }
    return { start: head.start, hole: previous.hole };
  };
  const optional = (body: Fragment): Fragment => {
    const exit = epsilon();
    patch(body.hole, exit.start);
    const start = push({
      op: "split",
      targets: [body.start, exit.start],
      rules: current,
    });
    return { start, hole: exit.hole };
  };

  interface Frame {
    readonly regex: Regex;
    readonly children: readonly Regex[];
    readonly rules: Rules | null;
    readonly results: Fragment[];
  }
  const open = (regex: Regex, rules: Rules | null): Frame => {
    switch (regex.kind) {
      case "empty":
      case "class":
        return { regex, children: [], rules, results: [] };
      case "concat":
        return { regex, children: regex.parts, rules, results: [] };
      case "alternation":
        return { regex, children: regex.alternatives, rules, results: [] };
      case "repeat": {
        const copies =
          regex.min + (regex.max === undefined ? 1 : regex.max - regex.min);
        return {
          regex,
          children: Array.from({ length: copies }, () => regex.body),
          rules,
          results: [],
        };
      }
      case "rule":
        return {
          regex,
          children: [regex.body],
          rules: {
            name: regex.name,
            parent: rules,
            depth: (rules?.depth ?? 0) + 1,
          },
          results: [],
        };
    }
  };
  const glue = (frame: Frame): Fragment => {
    const { regex, results, rules } = frame;
    switch (regex.kind) {
      case "empty":
        return epsilon();
      case "class": {
        const at = push({ op: "char", set: regex.set, rules, next: -1 });
        return { start: at, hole: at };
      }
      case "concat":
        return chain(results);
      case "alternation": {
        const exit = epsilon();
        for (const alternative of results) patch(alternative.hole, exit.start);
        const start = push({
          op: "split",
          targets: results.map((alternative) => alternative.start),
          rules,
        });
        return { start, hole: exit.hole };
      }
      case "rule":
        return results[0] ?? epsilon();
      case "repeat": {
        const required = results.slice(0, regex.min);
        const rest = results.slice(regex.min);
        let tail: Fragment | undefined;
        if (regex.max === undefined) {
          const [body] = rest;
          if (body !== undefined) {
            const exit = epsilon();
            const start = push({
              op: "split",
              targets: [body.start, exit.start],
              rules,
            });
            patch(body.hole, start);
            tail = { start, hole: exit.hole };
          }
        } else {
          for (let index = rest.length - 1; index >= 0; index -= 1) {
            const copy = rest[index];
            if (copy === undefined) continue;
            tail = optional(tail === undefined ? copy : chain([copy, tail]));
          }
        }
        return chain(tail === undefined ? required : [...required, tail]);
      }
    }
  };

  const frames: Frame[] = [open(root, null)];
  let result: Fragment | undefined;
  for (
    let top = frames[frames.length - 1];
    top !== undefined;
    top = frames[frames.length - 1]
  ) {
    if (result !== undefined) {
      top.results.push(result);
      result = undefined;
    }
    const child = top.children[top.results.length];
    if (child !== undefined) {
      frames.push(open(child, top.rules));
      continue;
    }
    frames.pop();
    current = top.rules;
    result = glue(top);
  }
  if (result === undefined) throw new Error("no fragment");

  const accept = push({ op: "accept" });
  patch(result.hole, accept);
  if (anchored) return [states, result.start];

  /**
   * The search loop a non-anchored match runs: try here, else consume any code
   * point and try again.
   */
  const advance = push({ op: "char", set: ANY, rules: null, next: -1 });
  const start = push({
    op: "split",
    targets: [result.start, advance],
    rules: null,
  });
  patch(advance, start);
  return [states, start];
}

/**
 * Tarjan's strongly connected components, iteratively. Components come out in
 * reverse topological order: a component is emitted after every component it
 * reaches. `component` maps each node to the index of its component in
 * `order`.
 */
function components<$Node>(
  nodes: Iterable<$Node>,
  successors: (node: $Node) => Iterable<$Node>,
): {
  readonly order: readonly (readonly $Node[])[];
  readonly component: ReadonlyMap<$Node, number>;
} {
  const index = new Map<$Node, number>();
  const low = new Map<$Node, number>();
  const onStack = new Set<$Node>();
  const stack: $Node[] = [];
  const order: $Node[][] = [];
  const component = new Map<$Node, number>();
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    const calls: { readonly node: $Node; readonly next: Iterator<$Node> }[] =
      [];
    const enter = (node: $Node): void => {
      index.set(node, counter);
      low.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
      calls.push({ node, next: successors(node)[Symbol.iterator]() });
    };
    enter(root);
    for (
      let call = calls[calls.length - 1];
      call !== undefined;
      call = calls[calls.length - 1]
    ) {
      const step = call.next.next();
      if (!step.done) {
        const target = step.value;
        if (!index.has(target)) enter(target);
        else if (onStack.has(target))
          low.set(
            call.node,
            Math.min(low.get(call.node) ?? 0, index.get(target) ?? 0),
          );
        continue;
      }
      calls.pop();
      const parent = calls[calls.length - 1];
      if (parent !== undefined)
        low.set(
          parent.node,
          Math.min(low.get(parent.node) ?? 0, low.get(call.node) ?? 0),
        );
      if (low.get(call.node) === index.get(call.node)) {
        const members: $Node[] = [];
        for (
          let member = stack.pop();
          member !== undefined;
          member = stack.pop()
        ) {
          onStack.delete(member);
          component.set(member, order.length);
          members.push(member);
          if (member === call.node) break;
        }
        order.push(members);
      }
    }
  }
  return { order, component };
}

/**
 * A pump found by a product search: the word, the node it starts and ends at,
 * and every automaton transition its paths take.
 */
interface Pump {
  readonly at: number;
  readonly pump: string;
  readonly edges: readonly (readonly [number, number])[];
}

/**
 * Pairs or triples of indices into lists of the given sizes, packed into one
 * number for a product search's maps and sets. Past the largest safe integer
 * they are numbered as they are met instead. Closures rather than a class with
 * private fields, because the build lowers `#fields` to helper calls and these
 * run on every product step.
 */
interface Tuples {
  key(i: number, j: number, k?: number): number;
  first(key: number): number;
  second(key: number): number;
  third(key: number): number;
}

function tuples(first: number, second: number, third = 1): Tuples {
  if (first * second * third <= Number.MAX_SAFE_INTEGER) {
    const plane = second * third;
    return {
      key: (i, j, k = 0) => (i * second + j) * third + k,
      first: (key) => Math.floor(key / plane),
      second: (key) => Math.floor(key / third) % second,
      third: (key) => key % third,
    };
  }
  const ids = new Map<string, number>();
  const list: (readonly [number, number, number])[] = [];
  return {
    key: (i, j, k = 0) => {
      const text = `${i},${j},${k}`;
      const known = ids.get(text);
      if (known !== undefined) return known;
      ids.set(text, list.length);
      list.push([i, j, k]);
      return list.length - 1;
    },
    first: (key) => list[key]?.[0] ?? 0,
    second: (key) => list[key]?.[1] ?? 0,
    third: (key) => list[key]?.[2] ?? 0,
  };
}

/**
 * Exponential ambiguity inside one loop. In the product of the loop with
 * itself, two distinct paths `q → q` on one word are a cycle through a diagonal
 * node `(q, q)` that either leaves the diagonal or takes a step two ε-paths
 * make (a parallel pair of edges). Both cycles stay inside the loop, so the
 * product never needs more of the graph. Both copies read the same input, so
 * they share a look-ahead.
 */
function exponential(
  members: readonly number[],
  space: Space,
): Pump | undefined {
  const { automaton, looks } = space;
  const index = new Map(members.map((member, at) => [member, at]));
  const packed = tuples(members.length, members.length);
  const nodes = (product: number): [number, number] => [
    members[packed.first(product)] ?? 0,
    members[packed.second(product)] ?? 0,
  ];

  /**
   * Each step of the product consumes one code point both states accept.
   */
  const steps = (
    product: number,
  ): {
    readonly to: number;
    readonly char: number;
    readonly double: boolean;
  }[] => {
    space.spend();
    const [u, v] = nodes(product);
    const a = Math.floor(u / looks);
    const b = Math.floor(v / looks);
    const both = intersect(automaton.set(a), automaton.set(b));
    if (both.length === 0) return [];
    const out = [];
    for (const move of space.moves(u % looks, both))
      for (const [t1, m1] of space.next(a, move.look)) {
        const i = index.get(t1 * looks + move.look);
        if (i === undefined) continue;
        for (const t2 of space.next(b, move.look).keys()) {
          const j = index.get(t2 * looks + move.look);
          if (j === undefined) continue;
          out.push({
            to: packed.key(i, j),
            char: move.char,
            double: u === v && t1 === t2 && m1 > 1,
          });
        }
      }
    return out;
  };
  const diagonal = (product: number): boolean =>
    packed.first(product) === packed.second(product);

  const reachable = explore(
    members.map((_, at) => packed.key(at, at)),
    (product) => steps(product).map(({ to }) => to),
  );
  const { order } = components(reachable, (product) =>
    steps(product).map(({ to }) => to),
  );

  for (const group of order) {
    const here = new Set(group);
    const anchor = group.find(diagonal);
    if (anchor === undefined) continue;
    const within = (product: number) =>
      steps(product).filter(({ to }) => here.has(to));

    /**
     * The off-diagonal node nearest the anchor, so the pump is short.
     */
    const away = explore([anchor], (product) =>
      within(product).map(({ to }) => to),
    ).find((product) => !diagonal(product));
    let word: number[] | undefined;
    let visited: number[] = [];
    if (away !== undefined) {
      const there = route(anchor, away, within);
      const back = route(away, anchor, within);
      if (there !== undefined && back !== undefined) {
        word = [...there.chars, ...back.chars];
        visited = [anchor, ...there.nodes, ...back.nodes];
      }
    } else {
      for (const from of group) {
        const double = within(from).find((step) => step.double);
        if (double === undefined) continue;
        const there = route(anchor, from, within);
        const back = route(double.to, anchor, within);
        if (there === undefined || back === undefined) continue;
        word = [...there.chars, double.char, ...back.chars];
        visited = [anchor, ...there.nodes, double.to, ...back.nodes];
        break;
      }
    }
    if (word === undefined) continue;
    const [at] = nodes(anchor);
    return {
      at,
      pump: String.fromCodePoint(...word),
      edges: transitions(
        visited.map((product) =>
          nodes(product).map((node) => Math.floor(node / looks)),
        ),
      ),
    };
  }
  return undefined;
}

/**
 * Polynomial ambiguity between loops, and its degree: the longest chain of IDA
 * links, each from a loop to one it reaches, in the order the automaton can
 * pass through them.
 *
 * A link from `C₁` to `C₂` needs `p ∈ C₁`, `q ∈ C₂`, and one word on which `p →
 * p`, `p → q`, and `q → q`: a path in the product of three copies from `(p, p,
 * q)` to `(p, q, q)`. The first copy stays in `C₁`, the third in `C₂`, and the
 * second passes through nodes between them, so the search is confined to those.
 * `order` is the graph's components, and `loops[c]` the `char` nodes of
 * component `c` if it has a cycle.
 */
function polynomial(
  order: readonly (readonly number[])[],
  loops: readonly (readonly number[])[],
  component: ReadonlyMap<number, number>,
  space: Space,
): (Pump & { readonly links: number }) | undefined {
  /**
   * `best[c]`: the most links in a chain starting at component `c` or after it,
   * with the pump of its first link. Components are in reverse topological
   * order, so every successor is resolved first.
   */
  const best: { links: number; first: Pump | undefined }[] = [];

  for (let c = 0; c < order.length; c += 1) {
    const members = order[c] ?? [];
    let links = 0;
    let first: Pump | undefined;
    for (const member of members)
      for (const target of space.edges(member)) {
        const result = best[component.get(target) ?? c];
        if (result !== undefined && result.links > links) {
          links = result.links;
          first = result.first;
        }
      }
    const loop = loops[c] ?? [];
    if (loop.length > 0) {
      const forward = new Set(explore(members, (at) => space.edges(at)));
      for (let d = 0; d < c; d += 1) {
        const result = best[d];
        const target = loops[d] ?? [];
        if (target.length === 0 || result === undefined) continue;
        if (result.links + 1 <= links) continue;
        if (!target.some((at) => forward.has(at))) continue;
        const link = idaLink(loop, target, forward, space);
        if (link === undefined) continue;
        links = result.links + 1;
        first = link;
      }
    }
    best.push({ links, first });
  }

  let top: { links: number; first: Pump | undefined } | undefined;
  for (const result of best) if (result.links > (top?.links ?? 0)) top = result;
  if (top?.first === undefined) return undefined;
  return { ...top.first, links: top.links };
}

/**
 * Search for an IDA link from loop `from` to loop `to`, given the nodes
 * reachable from `from`.
 */
function idaLink(
  from: readonly number[],
  to: readonly number[],
  forward: ReadonlySet<number>,
  space: Space,
): Pump | undefined {
  const { automaton, looks } = space;
  const backward = new Set(explore(to, (at) => space.reverse(at)));
  const between = [...forward].filter(
    (at) => backward.has(at) && space.isChar(at),
  );
  const first = new Map(from.map((node, at) => [node, at]));
  const second = new Map(between.map((node, at) => [node, at]));
  const third = new Map(to.map((node, at) => [node, at]));
  const packed = tuples(from.length, between.length, to.length);
  const nodes = (product: number): [number, number, number] => [
    from[packed.first(product)] ?? 0,
    between[packed.second(product)] ?? 0,
    to[packed.third(product)] ?? 0,
  ];
  const steps = (
    product: number,
  ): { readonly to: number; readonly char: number }[] => {
    space.spend();
    const [u, v, w] = nodes(product);
    const x = Math.floor(u / looks);
    const y = Math.floor(v / looks);
    const z = Math.floor(w / looks);
    const all = intersect(
      intersect(automaton.set(x), automaton.set(y)),
      automaton.set(z),
    );
    if (all.length === 0) return [];
    const out = [];
    for (const move of space.moves(u % looks, all))
      for (const x2 of space.next(x, move.look).keys()) {
        const i = first.get(x2 * looks + move.look);
        if (i === undefined) continue;
        for (const y2 of space.next(y, move.look).keys()) {
          const j = second.get(y2 * looks + move.look);
          if (j === undefined) continue;
          for (const z2 of space.next(z, move.look).keys()) {
            const k = third.get(z2 * looks + move.look);
            if (k !== undefined)
              out.push({ to: packed.key(i, j, k), char: move.char });
          }
        }
      }
    return out;
  };

  /**
   * Only a start where the first two copies part on the first step needs
   * trying: rotate any witness to begin where they part, and it is still a
   * witness, from that node, with the third copy wherever it was then. All
   * three copies read one input, so the first and third start with one
   * look-ahead.
   */
  const parts = (p: number): boolean => {
    for (const move of space.moves(
      p % looks,
      automaton.set(Math.floor(p / looks)),
    )) {
      let stay: number | undefined;
      let leave: number | undefined;
      for (const target of space
        .next(Math.floor(p / looks), move.look)
        .keys()) {
        const at = target * looks + move.look;
        if (first.has(at)) stay ??= at;
        if (second.has(at)) {
          if (leave === undefined || leave === stay) leave = at;
        }
      }
      if (stay !== undefined && leave !== undefined && stay !== leave)
        return true;
    }
    return false;
  };
  for (const p of from.filter(parts))
    for (const q of to) {
      if (q % looks !== p % looks) continue;
      const i = first.get(p);
      const j = second.get(p);
      const jq = second.get(q);
      const k = third.get(q);
      if (
        i === undefined
        || j === undefined
        || jq === undefined
        || k === undefined
      )
        continue;
      const start = packed.key(i, j, k);
      const found = route(start, packed.key(i, jq, k), steps);
      if (found === undefined) continue;
      return {
        at: p,
        pump: String.fromCodePoint(...found.chars),
        edges: transitions(
          [start, ...found.nodes].map((product) =>
            nodes(product).map((node) => Math.floor(node / looks)),
          ),
        ),
      };
    }
  return undefined;
}

/**
 * Every node reachable from `starts`, breadth first.
 */
function explore<$Node>(
  starts: Iterable<$Node>,
  successors: (node: $Node) => Iterable<$Node>,
): $Node[] {
  const seen = new Set<$Node>(starts);
  const queue = [...seen];
  for (let at = 0; at < queue.length; at += 1) {
    const node = queue[at];
    if (node === undefined) break;
    for (const next of successors(node))
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
  }
  return queue;
}

/**
 * A shortest non-empty path from `from` to `to`, breadth first, with the code
 * point each step consumes and every node it reaches.
 */
function route(
  from: number,
  to: number,
  steps: (
    node: number,
  ) => readonly { readonly to: number; readonly char: number }[],
): { readonly chars: number[]; readonly nodes: number[] } | undefined {
  const parent = new Map<
    number,
    { readonly node: number; readonly char: number }
  >();
  const queue = [from];
  for (let at = 0; at < queue.length; at += 1) {
    const node = queue[at] ?? from;
    for (const step of steps(node)) {
      if (parent.has(step.to)) continue;
      parent.set(step.to, { node, char: step.char });
      if (step.to === to) {
        /**
         * Walk the parent links back to `from`. `from` has no parent until a
         * step reaches it, so for a cycle this stops after going all the way
         * round, and the path is never empty.
         */
        const chars: number[] = [];
        const nodes: number[] = [];
        let cursor = to;
        do {
          const link = parent.get(cursor);
          if (link === undefined) throw new Error("a broken path");
          chars.push(link.char);
          nodes.push(cursor);
          cursor = link.node;
        } while (cursor !== from);
        return { chars: chars.reverse(), nodes: nodes.reverse() };
      }
      queue.push(step.to);
    }
  }
  return undefined;
}

/**
 * A code point from a set to put in an attack string: a printable ASCII one
 * where the set has one, so attacks are readable, and otherwise its first.
 */
function representative(points: CodePointSet): number {
  for (const [from, to] of points)
    if (to >= 0x21 && from <= 0x7e) return Math.max(from, 0x21);
  return points[0]?.[0] ?? 0;
}

/**
 * An input that drives the ambiguity: a shortest prefix to the state where the
 * pump starts, the pump, and a suffix no state accepts, so every path fails and
 * a backtracking engine has to try them all. Where every code point is accepted
 * somewhere, there is no such character and the suffix is empty: the finding
 * stands, since the analysis is about paths, but that attack may match
 * quickly.
 *
 * The prefix is found on the ε-NFA by a 0-1 breadth-first search, where an
 * ε-move costs nothing and a `char` state costs one code point, so it needs no
 * ε-closures.
 */
function attack(automaton: Automaton, at: number, pump: string): Attack {
  const parent = new Map<number, number>();
  const deque: number[] = [automaton.start];
  const seen = new Set<number>([automaton.start]);
  while (deque.length > 0) {
    const node = deque.shift() ?? automaton.start;
    if (node === at) break;
    for (const next of automaton.edges(node)) {
      if (seen.has(next)) continue;
      seen.add(next);
      parent.set(next, node);
      if (automaton.isChar(node)) deque.push(next);
      else deque.unshift(next);
    }
  }
  const chars: number[] = [];
  for (let node = parent.get(at); node !== undefined; node = parent.get(node))
    if (automaton.isChar(node)) chars.push(representative(automaton.set(node)));
  const used = merge(
    [...automaton.states.keys()]
      .filter((state) => automaton.rules(state) !== null)
      .flatMap((state) => [...automaton.set(state)]),
  );
  return {
    prefix: String.fromCodePoint(...chars.reverse()),
    pump,
    suffix: unused(used),
  };
}

/**
 * The first code point no range of `used` contains, as a string, or `""` if
 * every code point is used.
 */
function unused(used: CodePointSet): string {
  let candidate = 0;
  for (const [from, to] of used) {
    if (from > candidate) break;
    candidate = Math.max(candidate, to + 1);
  }
  return candidate > 0x10ffff ? "" : String.fromCodePoint(candidate);
}

/**
 * The transitions a product path takes, one per copy per step: consecutive
 * tuples of states, read column by column.
 */
function transitions(
  path: readonly (readonly number[])[],
): (readonly [number, number])[] {
  const edges: (readonly [number, number])[] = [];
  for (let step = 1; step < path.length; step += 1) {
    const before = path[step - 1] ?? [];
    const after = path[step] ?? [];
    before.forEach((from, copy) => edges.push([from, after[copy] ?? from]));
  }
  return edges;
}

/**
 * The innermost named rule enclosing every transition a finding's paths take,
 * ε-paths included: where the ambiguity lives, and so where to rewrite.
 */
function enclosing(
  edges: readonly (readonly [number, number])[],
  automaton: Automaton,
  root: string,
): string {
  let common: Rules | null | undefined;
  for (const [from, to] of edges) {
    const scope = automaton.scope(from, to);
    if (scope === null) continue;
    common = common === undefined ? scope : ancestor(common, scope);
  }
  return common?.name ?? root;
}

/**
 * The innermost rule enclosing both, where `null` (outside every rule, which
 * only the search loop of an unanchored pattern is) constrains nothing.
 */
function ancestor(left: Rules | null, right: Rules | null): Rules | null {
  if (left === null) return right;
  if (right === null) return left;
  let a: Rules | null = left;
  let b: Rules | null = right;
  while (a !== null && b !== null && a.depth > b.depth) a = a.parent;
  while (a !== null && b !== null && b.depth > a.depth) b = b.parent;
  while (a !== null && b !== null && a !== b) {
    a = a.parent;
    b = b.parent;
  }
  return a;
}
