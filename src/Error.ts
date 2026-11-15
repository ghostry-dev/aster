/**
 * Every error this library throws is a named subclass of {@link AsterError},
 * kept in one dependency-free module: `instanceof AsterError` catches
 * everything the library raises.
 *
 * Context is `public readonly` constructor parameters, but the message still
 * stands on its own: a consumer reading only `.message` should not need a field
 * to understand the failure. Fields are for programmatic access.
 *
 * @module
 */

/**
 * Base error class from which more specific errors inherit.
 */
export abstract class AsterError extends Error {
  constructor() {
    super();
    this.name = "AsterError";
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
      this.name = "AsterError.DuplicateRuleError";
      this.message = `Rule "${rule}" is already defined in this grammar. Rule names are unique, and a rule cannot be redefined.`;
    }
  }
}
