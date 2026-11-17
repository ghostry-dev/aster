/**
 * Every error this library throws is a named subclass of {@link AsterError},
 * kept in one module with no runtime imports: `instanceof AsterError` catches
 * everything the library raises.
 *
 * Context is `public readonly` constructor parameters, but the message still
 * stands on its own: a consumer reading only `.message` should not need a field
 * to understand the failure. Fields are for programmatic access.
 *
 * A `name` is the package and the class, `"@ghostry/aster:DuplicateRuleError"`,
 * so it identifies an error where `instanceof` cannot: across two installed
 * copies of this package, or after the error is serialized. `:`, not `/`, which
 * would read as a subpath export. This is the convention every `@ghostry`
 * package follows.
 *
 * @module
 */

import type { Vulnerability } from "./Types";

/**
 * Base error class from which more specific errors inherit.
 */
export abstract class AsterError extends Error {
  constructor() {
    super();
    this.name = "@ghostry/aster:AsterError";
  }
}

export namespace AsterError {
  /**
   * Thrown by `.define()` when a grammar already has a rule by that name. The
   * type of `.define()` rejects a literal duplicate first; this covers names
   * that only exist at runtime and callers without type checking.
   */
  export class DuplicateRuleError extends AsterError {
    constructor(
      /**
       * The rule name defined twice.
       */
      public readonly rule: string,
    ) {
      super();
      this.name = "@ghostry/aster:DuplicateRuleError";
      this.message =
        `Rule "${rule}" is already defined in this grammar. Rule names are `
        + `unique, and a rule cannot be redefined.`;
    }
  }
  /**
   * Thrown by `toPattern()` or `toRegExp()` when the grammar has no rule by the
   * name asked for. The types reject a literal unknown name; this covers names
   * that only exist at runtime and grammars that arrived as data.
   */
  export class UnknownRuleError extends AsterError {
    constructor(
      /**
       * The rule name asked for.
       */
      public readonly rule: string,
    ) {
      super();
      this.name = "@ghostry/aster:UnknownRuleError";
      this.message = `The grammar has no rule named "${rule}".`;
    }
  }

  /**
   * Thrown by `.define()` when a rule body references a rule that is not
   * defined before it. The builder's typed vocabulary makes this impossible
   * through the API; it covers bodies assembled by hand, including a rule
   * referring to itself, which would make the grammar recursive.
   */
  export class UnknownReferenceError extends AsterError {
    constructor(
      /**
       * The rule whose body holds the reference.
       */
      public readonly rule: string,
      /**
       * The name referenced.
       */
      public readonly reference: string,
    ) {
      super();
      this.name = "@ghostry/aster:UnknownReferenceError";
      this.message =
        `Rule "${rule}" references "${reference}", which is not defined `
        + `before it. A rule can only reference rules defined earlier in the `
        + `same grammar, which keeps every grammar regular.`;
    }
  }

  /**
   * Thrown by `.define()` when a `range` endpoint is not exactly one code
   * point, or when `from` comes after `to`.
   */
  export class InvalidRangeError extends AsterError {
    constructor(
      /**
       * The rule whose body holds the range.
       */
      public readonly rule: string,
      /**
       * The range's lower endpoint, as given.
       */
      public readonly from: string,
      /**
       * The range's upper endpoint, as given.
       */
      public readonly to: string,
      /**
       * `"endpoint"` when an endpoint is not one code point, `"order"` when
       * `from` is after `to`.
       */
      public readonly reason: "endpoint" | "order",
    ) {
      super();
      this.name = "@ghostry/aster:InvalidRangeError";
      this.message =
        reason === "endpoint"
          ? `Rule "${rule}" has range(${JSON.stringify(from)}, `
            + `${JSON.stringify(to)}), but each endpoint must be exactly one `
            + `code point.`
          : `Rule "${rule}" has range(${JSON.stringify(from)}, `
            + `${JSON.stringify(to)}), but its first endpoint comes after its `
            + `second.`;
    }
  }

  /**
   * Thrown by `.define()` when a repetition's bounds are not usable: `min` must
   * be a non-negative safe integer, and `max`, when present, a safe integer of
   * at least 1 and at least `min`.
   */
  export class InvalidRepetitionError extends AsterError {
    constructor(
      /**
       * The rule whose body holds the repetition.
       */
      public readonly rule: string,
      /**
       * The lower bound, as given.
       */
      public readonly min: number,
      /**
       * The upper bound, as given; `undefined` for unbounded.
       */
      public readonly max: number | undefined,
    ) {
      super();
      this.name = "@ghostry/aster:InvalidRepetitionError";
      this.message =
        `Rule "${rule}" repeats between ${String(min)} and `
        + `${max === undefined ? "unbounded" : String(max)} times. The `
        + `minimum must be a non-negative integer, and a maximum must be an `
        + `integer of at least 1 and at least the minimum.`;
    }
  }

  /**
   * Thrown by `.define()` when an `either` has no alternatives. The type of
   * `either()` requires one; this covers untyped callers and hand-built
   * bodies.
   */
  export class EmptyEitherError extends AsterError {
    constructor(
      /**
       * The rule whose body holds the empty `either`.
       */
      public readonly rule: string,
    ) {
      super();
      this.name = "@ghostry/aster:EmptyEitherError";
      this.message =
        `Rule "${rule}" has an either() with no alternatives, which can `
        + `never match. Give it at least one alternative.`;
    }
  }

  /**
   * Thrown by `.define()` when the body of an `optional` or a repetition can
   * match the empty string, directly or through a referenced rule.
   *
   * Both are quantifiers in the emitted regex (`?` is `{0,1}`), and JS rejects
   * an iteration of a minimum-zero quantifier that matches nothing, then
   * backtracks into another derivation. The parser cannot reproduce that check:
   * it depends on where each iteration started, which a Pike VM's threads
   * cannot carry without losing their linear bound. Rejecting the construction
   * costs nothing in expressiveness, since such an `optional` accepts the same
   * strings as its body alone, and such a repetition can be rewritten with the
   * empty case moved outside it.
   */
  export class NullableQuantifierError extends AsterError {
    constructor(
      /**
       * The rule whose body holds the quantifier.
       */
      public readonly rule: string,
      /**
       * Which combinator's body can match the empty string.
       */
      public readonly combinator: "optional" | "repeat",
    ) {
      super();
      this.name = "@ghostry/aster:NullableQuantifierError";
      this.message =
        combinator === "optional"
          ? `Rule "${rule}" has an optional() whose body can already match `
            + `the empty string. Remove the optional(): the body accepts the `
            + `same strings without it.`
          : `Rule "${rule}" repeats an expression that can match the empty `
            + `string. Make the repeated expression always consume at least `
            + `one character, for example by moving an optional() outside the `
            + `repetition.`;
    }
  }

  /**
   * Thrown by `toPattern` and `toRegExp` when the analysis finds the rule's
   * pattern can take superlinear time in a backtracking regex engine, slower
   * than `initialize({ allowedComplexity })` allows (only linear patterns, by
   * default).
   */
  export class VulnerablePatternError extends AsterError {
    constructor(
      /**
       * The rule whose pattern was asked for.
       */
      public readonly rule: string,
      /**
       * What the analysis found, with an input that shows it.
       */
      public readonly analysis: Vulnerability,
    ) {
      super();
      this.name = "@ghostry/aster:VulnerablePatternError";
      const growth =
        analysis.complexity === "exponential"
          ? "exponential time"
          : `time proportional to the input length to the power ${analysis.degree}`;
      const where =
        analysis.rule === rule
          ? ""
          : ` The ambiguity is in rule "${analysis.rule}".`;
      this.message =
        `The pattern for rule "${rule}" can take ${growth} in a backtracking `
        + `regex engine: input can match it in many ways, and the engine tries `
        + `them all before failing, as on ${JSON.stringify(analysis.attack.prefix)} `
        + `+ ${JSON.stringify(analysis.attack.pump)} repeated + `
        + `${JSON.stringify(analysis.attack.suffix)}.${where} Parse untrusted `
        + `input with toParser(), which is linear for every grammar; or rewrite `
        + `the rule so no input matches it more than one way; or pass a `
        + `higher \`allowedComplexity\` to initialize() to allow it.`
        + (analysis.exact
          ? ""
          : ` The pattern was too large to analyze exactly within `
            + `\`analysisBudget\`, so this ignores match priority and may `
            + `report a pattern a real engine matches quickly; a larger `
            + `budget gives an exact answer.`);
    }
  }

  /**
   * Thrown by `initialize` when an option has a value it does not accept. A
   * misspelled setting is an error rather than a fallback to the default, or to
   * no setting at all, so a typo cannot silently turn a check off.
   */
  export class InvalidConfigError extends AsterError {
    constructor(
      /**
       * The option.
       */
      public readonly option: string,
      /**
       * The value it was given.
       */
      public readonly value: unknown,
    ) {
      super();
      this.name = "@ghostry/aster:InvalidConfigError";
      this.message = `initialize() does not accept ${typeof value === "number" ? String(value) : (JSON.stringify(value) ?? String(value))} for "${option}".`;
    }
  }

  /**
   * Thrown by `.define()` when a rule body holds a value that is not an
   * expression of a known kind. Only reachable from a hand-built body.
   */
  export class InvalidExpressionError extends AsterError {
    constructor(
      /**
       * The rule whose body holds the value.
       */
      public readonly rule: string,
      /**
       * The value found where an expression was expected.
       */
      public readonly value: unknown,
    ) {
      super();
      this.name = "@ghostry/aster:InvalidExpressionError";
      this.message =
        `Rule "${rule}" contains a value that is not an expression: `
        + `${describe(value)}. Build rule bodies with the combinators.`;
    }
  }

  function describe(value: unknown): string {
    if (typeof value === "object" && value !== null && "kind" in value) {
      return `an object of unknown kind ${JSON.stringify(String(value.kind))}`;
    }
    return value === null ? "null" : typeof value;
  }
}
