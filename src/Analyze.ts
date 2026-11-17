import { intersect, merge, type CodePointSet } from "./CodePoints";
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
 * The analysis is **sound and conservative**. It ignores match priority and the
 * possibility that a higher-priority path succeeds first, so it never misses a
 * vulnerable pattern but may flag one that a real engine always matches
 * quickly. It reads the structure the emitter wrote (`Regex`), after class
 * collapsing, since that is what the engine runs: `[a-c]|[b-d]` in a loop is
 * ambiguous, `[a-d]` is not.
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
 * A Thompson ε-NFA state. `split` may have any number of targets: their order
 * is a priority the analysis does not use.
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
 */
export function analyze(
  regex: Regex,
  root: string,
  anchored: boolean,
): Analysis {
  const automaton = new Automaton(...thompson(regex, anchored));
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

  /**
   * Report the loop nearest the start first: Tarjan emits components in reverse
   * topological order.
   */
  for (let c = loops.length - 1; c >= 0; c -= 1) {
    const members = loops[c] ?? [];
    if (members.length === 0) continue;
    const found = exponential(members, automaton);
    if (found !== undefined)
      return {
        complexity: "exponential",
        rule: enclosing(found.edges, automaton, root),
        attack: attack(automaton, found.at, found.pump),
      };
  }

  const found = polynomial(order, loops, component, automaton);
  if (found === undefined) return { complexity: "linear" };
  return {
    complexity: "polynomial",
    degree: found.links + 1,
    rule: enclosing(found.edges, automaton, root),
    attack: attack(automaton, found.at, found.pump),
  };
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
 * A pump found by a product search: the word, the state it starts and ends at,
 * and every automaton transition its paths take.
 */
interface Pump {
  readonly at: number;
  readonly pump: string;
  readonly edges: readonly (readonly [number, number])[];
}

/**
 * Exponential ambiguity inside one loop. In the product of the loop with
 * itself, two distinct paths `q → q` on one word are a cycle through a diagonal
 * state `(q, q)` that either leaves the diagonal or takes a step two ε-paths
 * make (a parallel pair of edges). Both cycles stay inside the loop, so the
 * product never needs more of the automaton.
 */
function exponential(
  members: readonly number[],
  automaton: Automaton,
): Pump | undefined {
  const inside = new Set(members);
  const width = automaton.states.length;
  const key = (a: number, b: number): number => a * width + b;
  const pair = (product: number): [number, number] => [
    Math.floor(product / width),
    product % width,
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
    const [a, b] = pair(product);
    const both = intersect(automaton.set(a), automaton.set(b));
    if (both.length === 0) return [];
    const char = representative(both);
    const out = [];
    for (const [t1, m1] of automaton.successors(a))
      if (inside.has(t1))
        for (const t2 of automaton.successors(b).keys())
          if (inside.has(t2))
            out.push({
              to: key(t1, t2),
              char,
              double: a === b && t1 === t2 && m1 > 1,
            });
    return out;
  };

  const diagonal = members.map((q) => key(q, q));
  const reachable = explore(diagonal, (product) =>
    steps(product).map(({ to }) => to),
  );
  const { order } = components(reachable, (product) =>
    steps(product).map(({ to }) => to),
  );

  for (const group of order) {
    const here = new Set(group);
    const anchor = group.find((product) => {
      const [a, b] = pair(product);
      return a === b;
    });
    if (anchor === undefined) continue;
    const within = (product: number) =>
      steps(product).filter(({ to }) => here.has(to));

    /**
     * The off-diagonal state nearest the anchor, so the pump is short.
     */
    const away = explore([anchor], (product) =>
      within(product).map(({ to }) => to),
    ).find((product) => {
      const [a, b] = pair(product);
      return a !== b;
    });
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
    const [q] = pair(anchor);
    return {
      at: q,
      pump: String.fromCodePoint(...word),
      edges: transitions(visited.map(pair)),
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
 * second passes through states between them, so the search is confined to
 * those. `order` is the ε-NFA's components, and `loops[c]` the `char` states of
 * component `c` if it has a cycle.
 */
function polynomial(
  order: readonly (readonly number[])[],
  loops: readonly (readonly number[])[],
  component: ReadonlyMap<number, number>,
  automaton: Automaton,
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
      for (const target of automaton.edges(member)) {
        const result = best[component.get(target) ?? c];
        if (result !== undefined && result.links > links) {
          links = result.links;
          first = result.first;
        }
      }
    const loop = loops[c] ?? [];
    if (loop.length > 0) {
      const forward = new Set(explore(members, (at) => automaton.edges(at)));
      for (let d = 0; d < c; d += 1) {
        const result = best[d];
        const target = loops[d] ?? [];
        if (target.length === 0 || result === undefined) continue;
        if (result.links + 1 <= links) continue;
        if (!target.some((at) => forward.has(at))) continue;
        const link = idaLink(loop, target, forward, automaton);
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
 * Search for an IDA link from loop `from` to loop `to`, given the ε-NFA states
 * reachable from `from`.
 */
function idaLink(
  from: readonly number[],
  to: readonly number[],
  forward: ReadonlySet<number>,
  automaton: Automaton,
): Pump | undefined {
  const first = new Set(from);
  const third = new Set(to);
  const backward = new Set(explore(to, (at) => automaton.reverse(at)));
  const between = new Set(
    [...forward].filter((at) => backward.has(at) && automaton.isChar(at)),
  );
  const width = automaton.states.length;
  const key = (x: number, y: number, z: number): number =>
    (x * width + y) * width + z;
  const triple = (product: number): [number, number, number] => [
    Math.floor(product / (width * width)),
    Math.floor(product / width) % width,
    product % width,
  ];
  const steps = (
    product: number,
  ): { readonly to: number; readonly char: number }[] => {
    const [x, y, z] = triple(product);
    const all = intersect(
      intersect(automaton.set(x), automaton.set(y)),
      automaton.set(z),
    );
    if (all.length === 0) return [];
    const char = representative(all);
    const out = [];
    for (const x2 of automaton.successors(x).keys())
      if (first.has(x2))
        for (const y2 of automaton.successors(y).keys())
          if (between.has(y2))
            for (const z2 of automaton.successors(z).keys())
              if (third.has(z2)) out.push({ to: key(x2, y2, z2), char });
    return out;
  };

  for (const p of from)
    for (const q of to) {
      const found = route(key(p, p, q), key(p, q, q), steps);
      if (found === undefined) continue;
      return {
        at: p,
        pump: String.fromCodePoint(...found.chars),
        edges: transitions([key(p, p, q), ...found.nodes].map(triple)),
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
