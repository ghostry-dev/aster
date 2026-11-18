import { analyze } from "./Analyze.ts";
import { anchor, emit, type Fragment } from "./Emit.ts";
import { AsterError } from "./Error.ts";
import { toParser } from "./Parse.ts";
import type { Analysis, Config, Grammar, Initialized } from "./Types.ts";

/**
 * How severe each complexity is. A pattern is rejected when it is more severe
 * than `allowedComplexity`, so allowing `"exponential"`, the worst there is,
 * turns the check off.
 */
/**
 * The default `analysisBudget`, from measurements on the realistic grammar and
 * the fuzzer's random grammars (see AGENTS.md).
 */
const DEFAULT_BUDGET = 1_000_000;

const SEVERITY: Readonly<Record<Analysis["complexity"], number>> = {
  linear: 0,
  polynomial: 1,
  exponential: 2,
};

/**
 * Build the functions that consume a grammar, configured by `config`. With no
 * config, `toPattern` and `toRegExp` refuse any pattern a backtracking engine
 * can take superlinear time on, so the safe choice is the default.
 *
 * Defining a grammar does not depend on configuration, so `grammar()` and the
 * combinators are top-level exports rather than members of the result.
 */
export function initialize(config: Config = {}): Initialized {
  const allowed = config.allowedComplexity ?? "linear";
  if (!Object.prototype.hasOwnProperty.call(SEVERITY, allowed))
    throw new AsterError.InvalidConfigError("allowedComplexity", allowed);
  const limit = SEVERITY[allowed];
  const budget = config.analysisBudget ?? DEFAULT_BUDGET;
  if (
    typeof budget !== "number"
    || !(budget === Infinity || (Number.isSafeInteger(budget) && budget >= 0))
  )
    throw new AsterError.InvalidConfigError("analysisBudget", budget);

  /**
   * Analyses of grammars from `.compose()`, which are deeply frozen, so a
   * result can never go stale. A grammar that arrived as data may be mutated
   * later and is analyzed every time.
   */
  const cache = new WeakMap<Grammar, Map<string, Analysis>>();
  const analysisOf = (
    grammar: Grammar,
    rule: string,
    fragment: Fragment,
    anchored: boolean,
  ): Analysis => {
    const frozen = Object.isFrozen(grammar) && Object.isFrozen(grammar.rules);
    const key = `${anchored ? "^" : ""}${rule}`;
    const known = frozen ? cache.get(grammar)?.get(key) : undefined;
    if (known !== undefined) return known;
    const found = analyze(fragment.node, rule, anchored, budget);
    if (frozen) {
      const entries = cache.get(grammar) ?? new Map<string, Analysis>();
      cache.set(grammar, entries.set(key, found));
    }
    return found;
  };

  const instance: Initialized = {
    toPattern(grammar, rule, options = {}) {
      const fragment = emit(grammar, rule);
      if (limit < SEVERITY.exponential) {
        const found = analysisOf(
          grammar,
          rule,
          fragment,
          options.anchored !== false,
        );
        if (found.complexity !== "linear" && SEVERITY[found.complexity] > limit)
          throw new AsterError.VulnerablePatternError(rule, found);
      }
      return anchor(fragment, options);
    },
    toRegExp(grammar, rule, options) {
      return new RegExp(instance.toPattern(grammar, rule, options), "v");
    },
    toParser,
    analyze(grammar, rule, options = {}) {
      return analysisOf(
        grammar,
        rule,
        emit(grammar, rule),
        options.anchored !== false,
      );
    },
  };
  return instance;
}
