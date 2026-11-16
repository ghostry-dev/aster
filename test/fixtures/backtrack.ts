import { contains } from "#internal/CodePoints";
import type { Program } from "#internal/NFA";
import type { Event } from "#internal/VM";

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
