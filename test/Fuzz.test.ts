import {
  AsterError,
  toParser,
  toPattern,
  toRegExp,
  type Grammar,
} from "@ghostry/aster";
import { compile, type Program } from "#internal/NFA";
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
