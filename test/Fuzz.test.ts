import { AsterError, initialize, type Grammar } from "@ghostry/aster";
import { compile, type Program } from "#internal/NFA";
import { checkSync } from "recheck";
import { expect, test } from ".";
import { furthest } from "./fixtures/backtrack";
import {
  capturing,
  captured,
  derived,
  randomGrammar,
  sample,
} from "./fixtures/fuzz";
import { nearMisses, strings } from "./fixtures/inputs";
import { Random } from "./fixtures/random";

const { analyze, toPattern, toRegExp, toParser } = initialize({
  redos: "never",
});

/**
 * Differential fuzzing: random grammars, random inputs, and the regex and the
 * parser must agree on both questions.
 *
 * - **Membership.** `toRegExp` (the `v` flag), the same pattern under `u`, and
 *   the parser accept exactly the same inputs.
 * - **Failure.** Where they reject, the parser fails where the backtracking
 *   oracle's furthest path ended, expecting what the oracle expects there.
 * - **Derivation.** Where they accept, the parser's AST and JS's own captures
 *   describe the same derivation. {@link capturing} builds a regex with a group
 *   around every subexpression, independently of the emitter, and JS's match
 *   indices are compared with the spans read off the AST, including inside
 *   repetitions, where JS keeps the last iteration.
 *
 * The oracle here is the JS engine itself, not the NFA, so a bug shared by the
 * NFA and the parser still shows. `FUZZ_RUNS` and `FUZZ_SEED` widen a run: `bun
 * run fuzz` runs many more seeds than CI does. A failure prints its seed,
 * grammar, rule, and input, and `FUZZ_SEED=<seed> FUZZ_RUNS=1` replays it.
 */
const RUNS = Number(process.env["FUZZ_RUNS"] ?? 300);
const SEED = Number(process.env["FUZZ_SEED"] ?? 1);

/**
 * The oracle's failure report, unless it would take too long: it explores every
 * path, which on a random ambiguous grammar can be exponential. Those inputs
 * still get the membership and derivation checks.
 */
function furthestWithin(
  program: Program,
  input: string,
): ReturnType<typeof furthest> | "too slow" {
  try {
    return furthest(program, input, 200_000);
  } catch {
    return "too slow";
  }
}

interface Failure {
  readonly seed: number;
  readonly grammar: string;
  readonly rule: string;
  readonly input: string;
  readonly problem: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * Draw grammars until one passes the definition-time checks. Most rejections
 * are a repetition of a nullable body, which the generator does not avoid.
 */
function draw(random: Random): ReturnType<typeof randomGrammar> {
  for (;;) {
    const drawn = randomGrammar(random);
    const last = drawn.grammar.rules[drawn.grammar.rules.length - 1];
    try {
      if (last !== undefined) toPattern(drawn.grammar, last.name);
      return drawn;
    } catch (error) {
      if (!(error instanceof AsterError)) throw error;
    }
  }
}

/**
 * Likely members (random derivations written out), their near misses, and every
 * short string over the grammar's alphabet.
 */
function inputs(
  grammar: Grammar,
  rule: string,
  alphabet: readonly string[],
  random: Random,
): { readonly samples: ReadonlySet<string>; readonly all: readonly string[] } {
  const samples = new Set(
    Array.from({ length: 8 }, () => sample(grammar, rule, random)),
  );
  const misses = [...samples].slice(0, 2).flatMap(nearMisses);
  const shorts = strings(alphabet, 3);
  return { samples, all: [...new Set([...samples, ...misses, ...shorts])] };
}

test(
  `regex and parser agree on ${RUNS} random grammars`,
  () => {
    const failures: Failure[] = [];
    let samples = 0;
    let accepted = 0;

    for (let run = 0; run < RUNS && failures.length < 5; run += 1) {
      const seed = SEED + run;
      const random = new Random(seed);
      const { grammar, alphabet } = draw(random);

      for (const { name: rule } of grammar.rules) {
        const v = toRegExp(grammar, rule);
        const u = new RegExp(toPattern(grammar, rule), "u");
        const parse = toParser(grammar, rule);
        const program = compile(grammar, rule);
        const oracle = capturing(grammar, rule);
        const fail = (
          input: string,
          problem: string,
          expected: unknown,
          actual: unknown,
        ): void => {
          failures.push({
            seed,
            grammar: JSON.stringify(grammar),
            rule,
            input: JSON.stringify(input),
            problem,
            expected,
            actual,
          });
        };

        const drawn = inputs(grammar, rule, alphabet, random);
        samples += drawn.samples.size;
        for (const input of drawn.all) {
          const result = parse(input);
          const matches = v.test(input);
          if (u.test(input) !== matches)
            fail(input, "the u and v regexes disagree", matches, !matches);
          if (result.ok !== matches) {
            fail(input, "regex and parser disagree", matches, result.ok);
            continue;
          }
          if (!result.ok) {
            const reached = furthestWithin(program, input);
            const reported = {
              offset: result.span.start,
              expected: result.expected,
            };
            if (
              reached !== "too slow"
              && JSON.stringify(reported) !== JSON.stringify(reached)
            )
              fail(input, "a different failure", reached, reported);
          }
          const spans = captured(oracle, input);
          if ((spans !== undefined) !== matches) {
            fail(input, "the capturing regex disagrees", matches, !matches);
            continue;
          }
          if (!result.ok || spans === undefined) continue;
          if (drawn.samples.has(input)) accepted += 1;
          const parsed = derived(grammar, rule, result.node);
          const at = parsed.findIndex(
            (span, index) =>
              JSON.stringify(span) !== JSON.stringify(spans[index]),
          );
          if (at !== -1)
            fail(
              input,
              `different derivations at occurrence ${at}`,
              spans[at] ?? null,
              parsed[at] ?? null,
            );
        }
      }
    }

    expect(failures).toEqual([]);
    /**
     * Guards the generator: if its samples stopped being members, agreement
     * would hold trivially and test nothing about derivations. A sample can
     * miss when adjacent lone surrogates join into one astral character.
     */
    expect(accepted).toBeGreaterThan(samples * 0.8);
  },
  Math.max(60_000, RUNS * 100),
);

/**
 * The ReDoS analysis is sound: on random grammars, anchored and as a search, it
 * never calls a pattern less severe than recheck's automaton checker does.
 * Anchored, it must also agree exactly. It did on all 5,005 random patterns
 * measured, so a difference is either an over-report the analysis should not
 * make or a change in recheck, and both are worth a look. As a search it may
 * report more, since it ignores match priority (see `Analyze.test.ts`). recheck
 * is slower than everything else here, so this covers a third of the seeds, and
 * skips a pattern recheck cannot decide.
 */
test(
  `the analysis is never less severe than recheck on ${Math.ceil(RUNS / 3)} random grammars`,
  () => {
    const rank = (complexity: string, degree: number): number =>
      complexity === "exponential"
        ? 1_000
        : complexity === "polynomial"
          ? degree
          : 0;
    const unsound: unknown[] = [];
    let decided = 0;
    for (
      let run = 0;
      run < Math.ceil(RUNS / 3) && unsound.length < 5;
      run += 1
    ) {
      const seed = SEED + run;
      const { grammar } = draw(new Random(seed));
      for (const { name: rule } of grammar.rules)
        for (const anchored of [true, false]) {
          const ours = analyze(grammar, rule, { anchored });
          const pattern = toPattern(grammar, rule, { anchored });
          const theirs = checkSync(pattern, "u", { checker: "automaton" });
          if (theirs.status === "unknown") continue;
          decided += 1;
          const mine = rank(
            ours.complexity,
            ours.complexity === "polynomial" ? ours.degree : 1,
          );
          const reference = rank(
            theirs.complexity.type,
            theirs.complexity.type === "polynomial"
              ? theirs.complexity.degree
              : 1,
          );
          if (mine < reference || (anchored && mine !== reference))
            unsound.push({
              seed,
              rule,
              pattern,
              ours,
              theirs: theirs.complexity,
            });
        }
    }
    expect(unsound).toEqual([]);
    expect(decided).toBeGreaterThan(0);
  },
  Math.max(60_000, RUNS * 300),
);
