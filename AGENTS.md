# aster — architecture notes

Context for working on this codebase across sessions. Not user-facing: this is how the machine works and where the traps are. The design rationale lives in the design doc ("Grammar Library Design (working name: aster)"); this file records what is true of the code.

**While this library is 0.x, do not avoid breaking changes.** Semver-0 is the window for getting the shape right; compatibility with existing call sites is not a reason to keep a worse API, name, or invariant. Tests still pin behavior — this is not a license to break things accidentally.

## Mental model

One grammar definition is meant to produce two outputs that accept exactly the same strings: a `RegExp` for validation and a parser that returns a typed AST with source spans. So far there is the definition side (`grammar().define(…)…compose()` and the combinators), the introspection IR on `./unstable-ir`, the definition-time checks, the regex emitter (`toPattern`/`toRegExp`), and the NFA the parser will run (internal). The parser and ReDoS analysis come later, in the design doc's order.

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

The rule is about runtime code. Type-level inference (`Children` over nested combinator types) is a recursive conditional type by necessity; its cost is measured by the type budget below. `subexpressions` (on `./unstable-ir`) is the primitive that keeps a walker a loop: push a node's direct children, never recurse into them. `fold` in `Walk.ts` is the one explicit-stack walk over a body, and both the checks and the emitter are folds. A new analysis of a body should be a fold too, not a new loop. `Check.test.ts` defines bodies nested 10⁵ levels deep, far past any call stack, and every new walk over a body or an input gets a test of the same kind. Tests and scripts follow the rule too: `test/Platform.test.ts` walks `dist/` with a stack, and the frozen-data and IR tests walk grammars with one.

## Definition-time checks

`.define()` validates a body before adding the rule, so a grammar that composes is one every later stage can compile. Every check's error names the rule. Checks live in `Check.ts`, not in the combinators: a combinator does not know which rule it belongs to, and a body assembled by hand never passes through one.

The walk is one post-order pass with an explicit stack. A node's own fields are checked when it is pushed, so the walk only descends into well-formed nodes:

- a kind outside the closed union → `InvalidExpressionError`
- a `range` endpoint that is not exactly one code point, or reversed endpoints → `InvalidRangeError`, with `reason` saying which. A lone surrogate counts as one code point, as it does under the `v` flag.
- repetition bounds where `min` is not a non-negative safe integer, or `max` is present but not a safe integer ≥ 1 and ≥ `min` → `InvalidRepetitionError`
- an `either` with no alternatives → `EmptyEitherError`
- a reference to a name not defined earlier, including the rule itself → `UnknownReferenceError`. This is the runtime half of "regular by construction"; the typed vocabulary is the compile-time half.

A node's nullability (whether it can match the empty string) is computed when it is popped, from its subexpressions' results. A repetition whose body is nullable throws `NullableRepetitionError`. JS regex has special rules for empty loop iterations, and the parser does not reproduce them, so the construction is rejected instead. `optional` of a nullable body is fine, because it is not a loop.

A reference's nullability comes from a map of every earlier rule's answer, which the builder carries forward. Because a rule only references earlier rules, definition order is the analysis order: there is no fixpoint and no graph search. A rejected definition leaves the builder unchanged, since builders are immutable.

## Regex emission

`toPattern(grammar, rule, { anchored })` returns pattern source and `toRegExp` compiles it with `v`. They are free functions, not methods, so a `Grammar` stays plain data. Decisions that answer the design doc's open questions:

- **Anchored by default:** `^…$`, wrapped as `^(?:…)$` when the top level is an alternation. That matches the parser's full-match semantics. It is also what a JSON Schema `pattern` needs, because `pattern` is unanchored: without anchors it would accept any string that merely contains a match. `anchored: false` is for searching.
- **Capture-free:** only `(?:…)` groups. Extraction is the parser's job, and a named group inside a loop would keep only its last iteration, which is exactly the confusion this library exists to avoid. `Emit.test.ts` asserts no realistic rule's pattern has a capturing group.
- **Valid under `u` as well as `v`**, with the same meaning, because JSON Schema validators commonly compile `pattern` with `u`. `Escape.ts` explains which escapes that rules out. The escaper tests compile every pattern under both flags.

Lowering is one `fold` per rule, in definition order. A reference is inlined as the fragment already emitted for its rule, since JS regex has no subroutine calls. Each fragment carries its precedence (`EMPTY` < `ATOM` < `QUANTIFIED` < `CONCAT` < `ALTERNATION`), and a context wraps a fragment in `(?:…)` only when it needs something tighter. That is how `(?:cat|dog)+`, `(?:a+)?`, and `(?:ab){2,4}` come out with no redundant groups. `QUANTIFIED` is its own level because quantifying a quantified atom needs a group: `a??` and `a+?` are lazy quantifiers, not nested ones.

An `either` whose alternatives each match exactly one code point (literals of one code point, ranges, references to such rules, or nested such `either`s) collapses into one class. Its ranges are sorted and merged, so the class is canonical and never writes a character twice in a row, which `v` would otherwise read as a reserved double punctuator like `&&`. Collapsing is all or nothing: a partial collapse would reorder alternatives.

`toPattern` re-runs the definition-time checks over the rules up to the one asked for (`checkThrough` in `Check.ts`), so a grammar that arrived as data, such as a JSON round trip, is validated before it compiles. Rules after the requested one are never read. An unknown rule name is `UnknownRuleError`.

Measured on `test/stress/Realistic.ts`: timestamp 122 characters, semver 176, IPv4 216, URI 526, the full log line 1,120, with about 70µs to emit the log line. Inlining duplicates a reused rule's text at every reference (IPv4's octet appears four times), so pattern size grows with reference fan-out. There is no size threshold or warning yet; set one with measurements from real grammars. Repeated adjacent atoms (`[0-9][0-9][0-9][0-9]`) are not run-length folded into `{4}`; that is an optional size optimization.

## NFA

`NFA.ts` compiles a rule to a Thompson NFA in program form, an array of states with transitions as indices, the way RE2 and Rust's `regex` do. It is internal: the design doc keeps compiled forms out of the public IR. States:

- `char` consumes one code point from a `CodePointSet`.
- `split` is an ε-fork whose `first` target is **preferred** over `second`. That is how JS regex priority is encoded: alternatives left to right, greedy quantifiers trying one more iteration. A Pike VM that keeps the highest-priority thread per state therefore picks the derivation backtracking would.
- `jump` is a plain ε-move.
- `mark` is an ε-move that records a `Mark` on the thread's trace.
- `match` accepts if the input is exhausted.

Marks are the trace the AST fold will replay. `enter`/`exit` bracket every occurrence of a named rule. `choice` records each decision taken at a split, tagged with the deciding combinator's **post-order index within its rule's body** (`node`): an `either`'s alternative, an `optional`'s take (`1`) or skip (`0`), and for a repetition `1` before every iteration and `0` when it stops. Literals and ranges need no marks, since given the choices each consumes a known number of code points. The design doc sketched the trace as enter/exit only; choices are what make anonymous combinators' children (tuples, arrays, `{ alternative, value }`) recoverable.

Construction is one `fold` per rule, in definition order, and linear. Every fragment has **exactly one hole**: where several paths leave a fragment, they meet at a `jump` that becomes the hole. Patching is a single assignment, never a walk over a list of dangling exits. Holes only ever sit in `next` fields; a `split` is always built with both targets known. A subtree's states are contiguous in the array, because the fold emits children before their parent's glue. Copying a subtree is therefore a range copy with relocation.

- **References are inlined:** the referenced rule's compiled fragment is copied in, enter and exit marks included. The NFA is still _built_ per rule, as the design doc requires for `.recursive()`: a recursive reference would become a call into another rule's fragment instead of a copy.
- **Repetition is unrolled**, as in RE2: `min` required copies, then a loop, or `max − min` nested optional copies. A bound of n costs n copies of the body. All copies are cloned from the body **before** anything is patched, because a clone taken after patching would carry a target outside its own range.
- **No class collapsing**, unlike the emitter: an `either` of single characters keeps one branch per alternative, because the AST records which alternative matched.

`compile` re-checks a grammar that arrived as data, as `toPattern` does. Measured on `test/stress/Realistic.ts`: timestamp 134 states, semver 360, IPv4 156, URI 768, and the log line 1,651, which compiles in about 140µs. About 58% of states are marks, mostly the enter/exit pairs of one-character rules like `digit`. Every mark is an ε-step in the parser's closure, so that is the first place to look if the Pike VM's per-character cost matters.

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
| mixed | 2,287    | 7,327 | 20,227 | 62,902 | 0.08s                |

Per-rule cost rises gently, from about 240 to about 630 instantiations, because each builder's vocabulary has as many keys as the grammar so far. That quadratic term is inherent to letting every builder see every earlier rule, and it is small: fitted to these numbers, 500 rules would land near 1.2M, still under TS5's 5,000,000 limit. `test/stress/Realistic.ts` (55 rules: RFC 3339, semver, IPv4, a URI subset, a log line) costs **23,356** instantiations. `test/TypeBudget.test.ts` fails above 50,000. Raise that budget deliberately, with a new measurement, never to make a red run green.

## Package layout

One package at the repository root, like `@ghostry/harness`. The IR is the subpath export `./unstable-ir` (`src/IR/index.ts`), not a sibling package. It moves to a stable path when the fabricator integration freezes it, and until then any kind or field may change in any release.

| module           | holds                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Types.ts`       | type-only: expression types, `RuleRef`, `RuleDefinition`, `Vocabulary`, `GrammarBuilder`, `Grammar`, `Node`, `Span`, and AST inference     |
| `Combinators.ts` | `literal`, `range`, `sequence`, `either`, `optional`, `zeroOrMore`, `oneOrMore`, `repeat`, each returning frozen plain data; no validation |
| `IR/index.ts`    | the `./unstable-ir` subpath: the IR's types, `Kind`, and `subexpressions`                                                                  |
| `Walk.ts`        | `fold`, the one explicit-stack post-order walk over a body                                                                                 |
| `CodePoints.ts`  | `CodePointSet`, `codePoint`/`codePoints`, `merge`, and `contains`, shared by the emitter and the NFA                                       |
| `NFA.ts`         | internal: `compile` to a Thompson NFA program with priority-ordered splits and trace marks                                                 |
| `Check.ts`       | the definition-time checks and nullability, as a fold; `checkThrough` re-checks a grammar that arrived as data                             |
| `Escape.ts`      | the two escapers, for outside and inside a character class; the only way text reaches a pattern                                            |
| `Emit.ts`        | `toPattern`/`toRegExp`: precedence-aware lowering and class collapsing, as a fold per rule                                                 |
| `Grammar.ts`     | `grammar()` and the immutable builder, which carries each rule's nullability forward for `Check.ts`                                        |
| `Error.ts`       | `AsterError` and its namespace of subclasses; dependency-free                                                                              |

`Types.ts` is type-only. A value export there is a module-kind change, not a local addition. The package root also exports the expression types, because a consumer's inferred grammar types have to be nameable in its emitted declarations. The introspection contract, and its documentation, is `./unstable-ir`.

Repetition is one `repeat` kind with `min` and an optional `max`. `zeroOrMore`, `oneOrMore`, and `repeat(body, { min, max })` all produce it, so a consumer handles every quantifier in one branch. An unbounded `max` is **omitted**, not `undefined`, so a node survives a JSON round trip unchanged (`IR.test.ts` uses `toStrictEqual`). `optional` stays its own kind, because its children (`A | undefined`) differ from a repetition's (`A[]`).

Tests import via the package specifier `@ghostry/aster`, never a relative `../src/...` path. That resolves by self-reference through `exports` to the built `dist/`, so `bun test` always exercises the actual build, and so does `test/stress/Realistic.ts`. A module that is deliberately not public, like `NFA.ts`, is reached through the **private import** `#internal/<Module>` (`package.json` `imports`, mapping to `dist/types` and `dist/esm`). A package's `#` imports resolve only inside that package, so tests get the built module without it becoming API. Never add an internal module to `exports` just to test it.

**`check`/`test` deliberately do not build; `verify` does.** `.github/workflows/test.yml` downloads the `dist` artifact built by `build.yml` and runs `bun run test`, so a build inside `test` would overwrite the artifact under test. Locally, `bun run verify` is `build` then `test`. Running `bun run test` against a missing or stale `dist/` fails, or checks stale types: build first.

`main.yml` and `publish.yml` are not in `.github/workflows` yet. In harness, any push to `main` with an unreleased version publishes, and the name is not confirmed. Copy them from harness when it is.

## Tooling / conventions

- Bun only: `bun test`, `bun run check`, never `npm`/`npx`/`node`.
- **`check` runs TypeScript 7; `check:ts5` runs TypeScript 5, and both are required.** TS7's instantiation budget is far larger than TS5's 5,000,000, and most consumers are on 5.x. The type budget test runs under TS5 for the same reason.
- `verbatimModuleSyntax: true`: type-only imports must say `import type` (or `type` on individual specifiers).
- `exactOptionalPropertyTypes` is on project-wide.
- Comments: TypeDoc-style `/** */` only, explaining _why_ (a constraint, an invariant, a workaround), never restating _what_ the code already says.
- **This file describes present-state facts and invariants, never change history.** The "rejected shapes" above are traps, not history: they say what fails if reintroduced.
- Test files by concern. `Grammar.test.ts` covers the builder's runtime behavior, and `Check.test.ts` covers every definition-time check, including the deep-nesting cases. `IR.test.ts` covers the subpath (JSON round trip, `subexpressions`, definition order as topological order). `*.types.test.ts` files hold compile-time assertions using `Equal`/`Expect`: `Grammar.types.test.ts` for AST inference and the vocabulary, and `IR.types.test.ts` for the closed `kind` union, via an exhaustive `switch`. `bun test` also executes those files, so must-not-compile cases sit inside a function that never runs. `Escape.test.ts` compiles every ASCII code point, every ASCII pair as a class and as a range, and the special non-ASCII code points under both `u` and `v`. `Emit.test.ts` pins exact pattern shapes, accept and reject tables for the realistic grammar under both flags, grammars that arrive as data, and a 10⁵-deep body. `NFA.test.ts` checks the NFA against `test/fixtures/backtrack.ts`, a deliberately simple backtracker that explores a program depth-first in priority order, as JS regex does. Its first accepting path is the derivation the parser must pick, and it stays the oracle once the Pike VM exists. The tests cover membership against `toRegExp` over accepted inputs and all their single-edit near misses; the design doc's PEG-versus-regex cases, cross-checked against native capturing regexes; mark nesting and offsets; and a 10⁵-deep body. The oracle is exponential in the worst case, so keep its inputs short and never assert a rejection on a deeply nested program. `Platform.test.ts` asserts the build imports nothing from the host. It matches `import`/`export` statements, not a bare `from "…"`, because compiled code can put a variable named `from` before a string literal. `TypeBudget.test.ts` caps the stress grammar's instantiations.
- **Errors.** Every error is a subclass of `AsterError`, declared in `Error.ts`'s namespace. Its `name` is the package and the class, `"@ghostry/aster:DuplicateRuleError"` (the base is `"@ghostry/aster:AsterError"`), the same convention every `@ghostry` package follows. A name identifies an error where `instanceof` cannot: across two installed copies of the package, or after serialization. Use `:`, not `/`, which would read as a subpath export. Context goes in `public readonly` constructor parameters, and the message must still make sense without them. A test for a new error asserts its `name`.
- **Tests run on `@ghostry/harness`.** `test/index.ts` wraps `bun:test` with harness's `initialize` and exports `describe`/`expect`/`test` plus an annotated `attest`. Every test file imports from `"."`, never from `bun:test`. Use `attest` wherever a check should also narrow the type, rather than `!`, `?.`, or a cast: `attest.throws(Class, () => …)` instead of a `try`/`catch` with `caught as Error`, and `attest.definitely(value, "label")` instead of `?? ""` or `match?.[1]`. The binding must keep its explicit `Attest` annotation, because narrowing through a destructure is TS2775. To exercise a runtime check that the types already reject, put `// @ts-expect-error` on the call inside `attest.throws`, so the test pins the type rejection too. Harness's `.each` passes a table row as `row` on the test context, `({ row: [a, b] }) => …`, not as positional arguments the way `bun:test` does. Give each table an explicit tuple type so the destructured row is typed. `@ghostry/harness` is a devDependency only; `Platform.test.ts` keeps it out of the build.
- **`jsr.json` uses `publish.include`, an allowlist**, for the reason harness's AGENTS.md gives: `jsr publish` does not skip dotfiles, so a denylist leaks repo files. Verify with `bun run check:jsr`.
- Declaration emit does **not** go through Rslib (`dts: false`). `build:types` emits `dist/types` with the `typescript-5` devDependency; `build:verify` type-checks those `.d.ts` files with `skipLibCheck: false`.
- `.stress/` is the benchmark's scratch output and is gitignored.
