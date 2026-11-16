import { contains, merge } from "#internal/CodePoints";
import type { Program } from "#internal/NFA";
import type { Event } from "#internal/VM";
import type { Expectation } from "@ghostry/aster";

export type { Event };

interface Trace {
  readonly event: Event;
  readonly previous: Trace | null;
}

interface Frame {
  readonly state: number;
  readonly offset: number;
  readonly trace: Trace | null;
}

/**
 * The test oracle for the NFA: a backtracking matcher that explores the program
 * depth-first in priority order, `split.first` before `split.second`, exactly
 * as JS regex backtracking explores alternatives and greedy quantifiers. The
 * first accepting path is therefore the derivation the parser has to pick, and
 * its marks are returned. `undefined` means no path accepts the whole input.
 *
 * Deliberately simple and exponential in the worst case, like the regex engine
 * it imitates; inputs in tests stay short. Uses an explicit stack, like
 * everything else in this repository. `budget` caps the number of states
 * visited so an accidentally pathological test fails instead of hanging.
 */
export function backtrack(
  program: Program,
  input: string,
  budget = 10_000_000,
): readonly Event[] | undefined {
  const stack: Frame[] = [{ state: program.start, offset: 0, trace: null }];
  let steps = 0;

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    let { state, offset, trace } = frame;
    for (;;) {
      steps += 1;
      if (steps > budget) throw new Error("backtracking budget exceeded");
      const instruction = program.instructions[state];
      if (instruction === undefined) throw new Error(`no state ${state}`);

      if (instruction.op === "match") {
        if (offset === input.length) return events(trace);
        break;
      }
      if (instruction.op === "split") {
        stack.push({ state: instruction.second, offset, trace });
        state = instruction.first;
        continue;
      }
      if (instruction.op === "jump") {
        state = instruction.next;
        continue;
      }
      if (instruction.op === "mark") {
        trace = { event: { mark: instruction.mark, offset }, previous: trace };
        state = instruction.next;
        continue;
      }
      const point = input.codePointAt(offset);
      if (point === undefined || !contains(instruction.set, point)) break;
      offset += point > 0xffff ? 2 : 1;
      state = instruction.next;
    }
  }
  return undefined;
}

function events(trace: Trace | null): readonly Event[] {
  const reversed: Event[] = [];
  for (let node = trace; node !== null; node = node.previous)
    reversed.push(node.event);
  return reversed.reverse();
}

/**
 * Just the marks, written compactly for assertions: `+rule`, `-rule`, and
 * `node:branch` for a choice.
 */
export function marks(
  trace: readonly Event[] | undefined,
): readonly string[] | undefined {
  return trace?.map(({ mark }) => {
    switch (mark.kind) {
      case "enter":
        return `+${mark.rule}`;
      case "exit":
        return `-${mark.rule}`;
      case "choice":
        return `${mark.node}:${mark.branch}`;
    }
  });
}

/**
 * Where a rejected input fails, found by exploring every path: the furthest
 * offset any path reached, and what the paths parked there expected, in the
 * shape the VM reports. `undefined` if the input is accepted.
 *
 * Paths are explored in priority order, so the first visit to each state at the
 * furthest offset is the thread the VM keeps there: a lower-priority path to
 * the same state was dropped by the VM and is visited later here. Open rules
 * are found by replaying the path's events forward with a stack, not the VM's
 * backward count. The rule being parsed is never reported, as in the VM.
 */
export function furthest(
  program: Program,
  input: string,
  budget = 10_000_000,
):
  | { readonly offset: number; readonly expected: readonly Expectation[] }
  | undefined {
  const stack: Frame[] = [{ state: program.start, offset: 0, trace: null }];
  let steps = 0;
  let far = -1;
  let parked: { state: number; trace: Trace | null }[] = [];
  const visited = new Set<number>();

  const park = (state: number, offset: number, trace: Trace | null): void => {
    if (offset > far) {
      far = offset;
      parked = [];
      visited.clear();
    }
    if (offset === far && !visited.has(state)) {
      visited.add(state);
      parked.push({ state, trace });
    }
  };

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    let { state, offset, trace } = frame;
    for (;;) {
      steps += 1;
      if (steps > budget) throw new Error("backtracking budget exceeded");
      const instruction = program.instructions[state];
      if (instruction === undefined) throw new Error(`no state ${state}`);
      if (instruction.op === "match") {
        if (offset === input.length) return undefined;
        park(state, offset, trace);
        break;
      }
      if (instruction.op === "split") {
        stack.push({ state: instruction.second, offset, trace });
        state = instruction.first;
        continue;
      }
      if (instruction.op === "jump") {
        state = instruction.next;
        continue;
      }
      if (instruction.op === "mark") {
        trace = { event: { mark: instruction.mark, offset }, previous: trace };
        state = instruction.next;
        continue;
      }
      park(state, offset, trace);
      const point = input.codePointAt(offset);
      if (point === undefined || !contains(instruction.set, point)) break;
      offset += point > 0xffff ? 2 : 1;
      state = instruction.next;
    }
  }

  const expected: (Expectation | "characters")[] = [];
  const rules = new Set<string>();
  const characters: (readonly [number, number])[] = [];
  let end = false;
  for (const { state, trace } of parked) {
    const instruction = program.instructions[state];
    if (instruction?.op === "match") {
      if (!end) expected.push({ kind: "end" });
      end = true;
      continue;
    }
    if (instruction?.op !== "char") continue;
    const open: Event[] = [];
    for (const event of events(trace)) {
      if (event.mark.kind === "enter") open.push(event);
      if (event.mark.kind === "exit") open.pop();
    }
    const outer = open.find(
      ({ mark, offset }) =>
        offset === far && mark.kind === "enter" && mark.rule !== program.rule,
    );
    if (outer?.mark.kind === "enter") {
      if (!rules.has(outer.mark.rule))
        expected.push({ kind: "rule", rule: outer.mark.rule });
      rules.add(outer.mark.rule);
    } else {
      if (characters.length === 0) expected.push("characters");
      characters.push(...instruction.set);
    }
  }
  const ranges = merge(characters).map(
    ([from, to]) =>
      [String.fromCodePoint(from), String.fromCodePoint(to)] as const,
  );
  return {
    offset: far,
    expected: expected.map((entry) =>
      entry === "characters" ? { kind: "characters", ranges } : entry,
    ),
  };
}
