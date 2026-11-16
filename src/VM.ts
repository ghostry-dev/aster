import { contains } from "./CodePoints";
import type { Mark, Program } from "./NFA";

/**
 * A mark on the winning path, with the UTF-16 offset where it was passed.
 */
export interface Event {
  readonly mark: Mark;
  readonly offset: number;
}

/**
 * The outcome of running a program over an input. On success, `events` is the
 * winning thread's trace in forward order. On failure, `offset` is where the
 * last thread died: the start of the first code point no live thread could
 * consume, or the end of the input if threads reached it but none accepted.
 */
export type Run =
  | { readonly ok: true; readonly events: readonly Event[] }
  | { readonly ok: false; readonly offset: number };

/**
 * A thread's trace: a persistent list from newest event to oldest. Threads that
 * fork share their common prefix, so memory is bounded by the live threads, not
 * by the number of derivations.
 */
interface Trace {
  readonly mark: Mark;
  readonly offset: number;
  readonly previous: Trace | null;
}

/**
 * A thread parked on a `char` or `match` state. ε-states are passed through
 * during the closure and never stored.
 */
interface Thread {
  readonly state: number;
  readonly trace: Trace | null;
}

/**
 * Run a program over `input` as a Pike VM: every live thread advances one code
 * point at a time, so the run is O(n × m) for an input of n code points and a
 * program of m states, however ambiguous the grammar is.
 *
 * Each list of threads is kept in priority order, the order backtracking would
 * try them in. When two threads reach the same state at the same offset, the
 * earlier one keeps it and the later one is dropped: from there on both have
 * the same future, and backtracking would have explored the earlier one's
 * first. The first thread to reach `match` at the end of the input is therefore
 * on the path JS regex backtracking would accept, and its trace is the
 * derivation.
 */
export function run(program: Program, input: string): Run {
  const { instructions } = program;
  /**
   * The step at which each state was last added. Stamping with a step counter
   * clears the set in O(1) between steps.
   */
  const seen = new Int32Array(instructions.length).fill(-1);
  const states: number[] = [];
  const traces: (Trace | null)[] = [];

  /**
   * Add the threads reachable from `start` by ε-moves to `into`, in priority
   * order. Pike's `addthread` recurses; this is the same depth-first order with
   * an explicit stack, which is why a `split` pushes `second` before `first`:
   * `first` pops next, and its whole closure is added before `second`'s.
   */
  const close = (
    into: Thread[],
    start: number,
    trace: Trace | null,
    offset: number,
    step: number,
  ): void => {
    states.push(start);
    traces.push(trace);
    for (let state = states.pop(); state !== undefined; state = states.pop()) {
      let current = traces.pop() ?? null;
      if (seen[state] === step) continue;
      seen[state] = step;
      const instruction = instructions[state];
      switch (instruction?.op) {
        case "jump":
          states.push(instruction.next);
          traces.push(current);
          break;
        case "mark":
          current = { mark: instruction.mark, offset, previous: current };
          states.push(instruction.next);
          traces.push(current);
          break;
        case "split":
          states.push(instruction.second, instruction.first);
          traces.push(current, current);
          break;
        case "char":
        case "match":
          into.push({ state, trace: current });
          break;
        case undefined:
          throw new Error(`no state ${state}`);
      }
    }
  };

  let current: Thread[] = [];
  let next: Thread[] = [];
  let offset = 0;
  let step = 0;
  close(current, program.start, null, offset, step);

  while (offset < input.length) {
    const point = input.codePointAt(offset) ?? 0;
    const width = point > 0xffff ? 2 : 1;
    step += 1;
    for (const thread of current) {
      const instruction = instructions[thread.state];
      if (instruction?.op === "char" && contains(instruction.set, point))
        close(next, instruction.next, thread.trace, offset + width, step);
    }
    if (next.length === 0) return { ok: false, offset };
    [current, next] = [next, current];
    next.length = 0;
    offset += width;
  }

  for (const thread of current) {
    if (instructions[thread.state]?.op === "match")
      return { ok: true, events: events(thread.trace) };
  }
  return { ok: false, offset };
}

/**
 * The trace in forward order. It is linked newest first, so it is read into an
 * array and reversed rather than walked recursively.
 */
function events(trace: Trace | null): readonly Event[] {
  const reversed: Event[] = [];
  for (let node = trace; node !== null; node = node.previous)
    reversed.push({ mark: node.mark, offset: node.offset });
  return reversed.reverse();
}
