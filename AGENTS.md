# aster — architecture notes

Context for working on this codebase across sessions. Not user-facing: this is how the machine works and where the traps are. The design rationale lives in the design doc ("Grammar Library Design (working name: aster)"); this file records what is true of the code.

**While this library is 0.x, do not avoid breaking changes.** Semver-0 is the window for getting the shape right; compatibility with existing call sites is not a reason to keep a worse API, name, or invariant. Tests still pin behavior — this is not a license to break things accidentally.

## Mental model

One grammar definition is meant to produce two outputs that accept exactly the same strings: a `RegExp` for validation and a parser that returns a typed AST with source spans. Only the definition side exists so far: `grammar().define(…)…compose()` and the combinators. The IR subpath, regex emitter, NFA, parser, and ReDoS analysis come later, in the design doc's order.

Grammars are **regular by construction**. A `.define()` builder receives references to the rules defined before it and nothing else, so the reference graph is a DAG and every grammar has a regex target. There is no `.recursive()`. Matching uses language semantics (membership in the set of strings, as in an anchored JS regex), never PEG's committed choice; see the design doc.

A finished `Grammar` is `{ rules }`: frozen `RuleDefinition`s (`{ name, body }`) in definition order. Rule bodies are frozen plain data with a closed `kind` union. A reference is `{ kind: "reference", name }`, never an inlined copy. Builders are immutable: `.define()` returns a new builder, so chains can branch from a shared prefix. A duplicate name is rejected by `.define()`'s type and, for names only known at runtime, by `AsterError.DuplicateRuleError`. The vocabulary object handed to a builder is built with `defineProperty`, so a rule named `__proto__` is an own key rather than a prototype swap.

## Traversal: loops, not recursion

**No runtime function in `src/` calls itself, directly or through another function.** Every walk is a loop over an explicit worklist. Input size must never be bounded by the call stack: a grammar is user data, a parser input is user data, and a stack overflow is not an error message.

How this applies, now and in the steps ahead:

- **Across rules.** `grammar.rules` is in definition order, which is already a topological order because each builder only sees earlier rules. A per-rule pass (nullability, NFA per rule, regex inlining) is one forward loop that reads results already computed for the rules it references. No graph search, no memoized recursion.
- **Inside one rule body.** Combinator nesting is a tree. Walk it post-order with an explicit stack of `{ node, nextChild }` frames. This covers the emitter, the nullability check, and Thompson's construction.
- **Pike VM ε-closure.** Pike's original `addthread` recurses. Use an explicit stack instead, pushing alternatives in **reverse** priority order so they pop in backtracking order. Getting this order wrong changes which derivation wins, not whether the input matches, so only the differential span tests would catch it.
- **Trace → AST fold.** The winning thread's trace is a linked list from newest to oldest. Iterate it into an array, then replay forward with an explicit stack of open nodes.
- **Later `.recursive()`.** Earley and GLL are worklist algorithms already, so this rule still holds.

The rule is about runtime code. Type-level inference (`Children` over nested combinator types) is a recursive conditional type by necessity; its cost is measured by the type budget below. Tests and scripts follow the rule too: `test/Platform.test.ts` walks `dist/` with a stack, and the frozen-data test walks a grammar with one. Once the NFA lands, a deep-nesting test (on the order of 10⁵ nested `optional`s) pins it.

## Type accumulation

A grammar's type is a **flat union of `RuleDefinition<Name, Body>`**. `.define()` returns `GrammarBuilder<$Rules | RuleDefinition<$Name, $Body>>`, and no AST type is computed at any link. Three shapes were measured and rejected, and each one is a trap that is easy to walk back into:

- **Object accumulation, `{ [K in keyof Previous | Name]: … }`.** It looks flat when printed, but it is represented as a chain of deferred mapped types, one per link. Reading the keys of the last one walks every link, and at about 50 rules any use of the finished grammar's type fails with TS2589 (instantiation excessively deep), even though only about 20k instantiations happened. `.define()` itself kept compiling, because it resolves one link at a time. `Vocabulary<$Rules>`, the object a builder sees, is instead one key-remapped mapped type over the union, `{ [R in $Rules as R["name"]]: RuleRef<R["name"]> }`, which is one level deep at any size.
- **References that carry their body, `RuleRef<Name, Body>`.** A reference's type then contains the bodies of everything it reaches. When rules reference two earlier rules each, the types grow like the reference DAG unfolded into a tree. A 100-rule grammar of that shape took 56s to check on TS5 (18s on TS7) for under 80k instantiations: the time goes into relating those types, not creating them, so the instantiation count does not show it. Removing the phantom property was not enough; the type argument alone causes it. `RuleRef<Name>` is now the name alone, at the type level as at runtime, and AST inference looks bodies up by name through a per-grammar mapped type (`Bodies`/`BodyOf` in `Types.ts`).
- **Naming the `Ast` alias inside `Children`/`AstOf`.** The checker prints a type through the alias it was reached by, and `Ast`'s first argument is the whole definition union, so hovers and emitted declarations showed 55 definitions instead of a node. `Children` and `AstOf` spell out `Node<…>`, which prints as the resolved tree.

A lazy `interface … extends Node<…>` for reference nodes was also tried, as a guard against depth limits on long chains. It turned out unnecessary: the eager alias resolves a 300-rule chain read 299 levels deep at the same cost. It was dropped because it printed worse.

`bun run bench:types` measures growth. Measured with TypeScript 5.9.3 and 7.0, which report identical counts (baseline import subtracted):

| shape | 10 rules | 25    | 50     | 100    | TS5 check, 100 rules |
| ----- | -------- | ----- | ------ | ------ | -------------------- |
| chain | 2,377    | 7,477 | 20,477 | 63,352 | 0.08s                |
| fan   | 1,614    | 4,899 | 13,374 | 41,574 | 0.06s                |
| mixed | 2,270    | 7,280 | 20,130 | 62,705 | 0.08s                |

Per-rule cost rises gently, from about 240 to about 630 instantiations, because each builder's vocabulary has as many keys as the grammar so far. That quadratic term is inherent to letting every builder see every earlier rule, and it is small: fitted to these numbers, 500 rules would land near 1.2M, still under TS5's 5,000,000 limit. `test/stress/Realistic.ts` (55 rules: RFC 3339, semver, IPv4, a URI subset, a log line) costs **23,389** instantiations. `test/TypeBudget.test.ts` fails above 50,000. Raise that budget deliberately, with a new measurement, never to make a red run green.

## Package layout

One package at the repository root, like `@ghostry/harness`. The IR will be a subpath export (`./unstable-ir`) once it exists, not a sibling package. It moves to a stable path when the fabricator integration freezes it.

| module           | holds                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Types.ts`       | type-only: expression types, `RuleRef`, `RuleDefinition`, `Vocabulary`, `GrammarBuilder`, `Grammar`, `Node`, `Span`, and AST inference |
| `Combinators.ts` | `literal`, `range`, `sequence`, `either`, `optional`, `zeroOrMore`, `oneOrMore`, each returning frozen plain data                      |
| `Grammar.ts`     | `grammar()` and the immutable builder                                                                                                  |
| `Error.ts`       | `AsterError` and its namespace of subclasses; dependency-free                                                                          |

`Types.ts` is type-only. A value export there is a module-kind change, not a local addition. The expression types are exported so a consumer's inferred grammar types can be named in emitted declarations, but they are not yet a stable introspection contract.

Tests import via the package specifier `@ghostry/aster`, never a relative `../src/...` path. That resolves by self-reference through `exports` to the built `dist/`, so `bun test` always exercises the actual build, and so does `test/stress/Realistic.ts`.

**`check`/`test` deliberately do not build; `verify` does.** `.github/workflows/test.yml` downloads the `dist` artifact built by `build.yml` and runs `bun run test`, so a build inside `test` would overwrite the artifact under test. Locally, `bun run verify` is `build` then `test`. Running `bun run test` against a missing or stale `dist/` fails, or checks stale types: build first.

`main.yml` and `publish.yml` are not in `.github/workflows` yet. In harness, any push to `main` with an unreleased version publishes, and the name is not confirmed. Copy them from harness when it is.

## Tooling / conventions

- Bun only: `bun test`, `bun run check`, never `npm`/`npx`/`node`.
- **`check` runs TypeScript 7; `check:ts5` runs TypeScript 5, and both are required.** TS7's instantiation budget is far larger than TS5's 5,000,000, and most consumers are on 5.x. The type budget test runs under TS5 for the same reason.
- `verbatimModuleSyntax: true`: type-only imports must say `import type` (or `type` on individual specifiers).
- `exactOptionalPropertyTypes` is on project-wide.
- Comments: TypeDoc-style `/** */` only, explaining _why_ (a constraint, an invariant, a workaround), never restating _what_ the code already says.
- **This file describes present-state facts and invariants, never change history.** The "rejected shapes" above are traps, not history: they say what fails if reintroduced.
- Test files by concern. `Grammar.test.ts` covers runtime behavior. `Grammar.types.test.ts` holds compile-time assertions using `Equal`/`Expect`; `bun test` also executes that file, so its must-not-compile cases sit inside a function that never runs. `Platform.test.ts` asserts the build imports nothing from the host. `TypeBudget.test.ts` caps the stress grammar's instantiations.
- **Errors.** Every error is a subclass of `AsterError`, declared in `Error.ts`'s namespace. Its `name` is the package and the class, `"@ghostry/aster:DuplicateRuleError"` (the base is `"@ghostry/aster:AsterError"`), the same convention every `@ghostry` package follows. A name identifies an error where `instanceof` cannot: across two installed copies of the package, or after serialization. Use `:`, not `/`, which would read as a subpath export. Context goes in `public readonly` constructor parameters, and the message must still make sense without them. A test for a new error asserts its `name`.
- **Tests run on `@ghostry/harness`.** `test/index.ts` wraps `bun:test` with harness's `initialize` and exports `describe`/`expect`/`test` plus an annotated `attest`. Every test file imports from `"."`, never from `bun:test`. Use `attest` wherever a check should also narrow the type, rather than `!`, `?.`, or a cast: `attest.throws(Class, () => …)` instead of a `try`/`catch` with `caught as Error`, and `attest.definitely(value, "label")` instead of `?? ""` or `match?.[1]`. The binding must keep its explicit `Attest` annotation, because narrowing through a destructure is TS2775. To exercise a runtime check that the types already reject, put `// @ts-expect-error` on the call inside `attest.throws`, so the test pins the type rejection too. `@ghostry/harness` is a devDependency only; `Platform.test.ts` keeps it out of the build.
- **`jsr.json` uses `publish.include`, an allowlist**, for the reason harness's AGENTS.md gives: `jsr publish` does not skip dotfiles, so a denylist leaks repo files. Verify with `bun run check:jsr`.
- Declaration emit does **not** go through Rslib (`dts: false`). `build:types` emits `dist/types` with the `typescript-5` devDependency; `build:verify` type-checks those `.d.ts` files with `skipLibCheck: false`.
- `.stress/` is the benchmark's scratch output and is gitignored.
