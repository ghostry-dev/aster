<div align="center">

# @ghostry/aster

**One grammar, two outputs: a `RegExp` for validation and a parser that returns a typed AST.**

Define a grammar once. Use the regex where you need a fast yes or no in any engine that reads ECMA-262, such as a JSON Schema `pattern`. Use the parser where you need the structure: every rule as a typed node with source spans, and every loop iteration kept. Both accept exactly the same strings.

[![github](https://img.shields.io/badge/github-ffffff?style=for-the-badge&color=000000&logo=github&logoColor=ffffff)](https://github.com/ghostry-dev/aster)
[![typescript](https://img.shields.io/badge/typescript-ffffff?style=for-the-badge&color=000000&logo=typescript&logoColor=3178C6)](#)
[![bun](https://img.shields.io/badge/bun-ffffff?style=for-the-badge&color=000000&logo=bun&logoColor=FBF0DF)](#)
[![node](https://img.shields.io/badge/node-ffffff?style=for-the-badge&color=000000&logo=nodedotjs&logoColor=5FA04E)](#)

</div>

> [!WARNING]
> Pre-release. Breaking changes can land in any 0.x version.

## Install

```sh
bun add @ghostry/aster
npm install @ghostry/aster
deno add jsr:@ghostry/aster
```

## Example

```ts
import {
  either,
  grammar,
  initialize,
  literal,
  oneOrMore,
  range,
  sequence,
  zeroOrMore,
  type AstOf,
} from "@ghostry/aster";

const { toPattern, toRegExp, toParser, analyze } = initialize();

const date = grammar()
  .define("digit", () => range("0", "9"))
  .define("year", ({ digit }) => sequence([digit, digit, digit, digit]))
  .define("month", ({ digit }) => sequence([digit, digit]))
  .define("date", ({ year, month }) => sequence([year, literal("-"), month]))
  .compose();

toPattern(date, "date"); // "^[0-9][0-9][0-9][0-9]-[0-9][0-9]$"
toRegExp(date, "date").test("2026-11"); // true

type DateNode = AstOf<typeof date, "date">;
// Node<"date", readonly [Node<"year", …>, string, Node<"month", …>]>

const parse = toParser(date, "date");
const result = parse("2026-11");
if (result.ok) {
  const [year, , month] = result.node.children;
  year.text; // "2026"
  month.span; // { start: 5, end: 7 }
}
const failed = parse("2026-x1");
if (!failed.ok) {
  failed.message; // 'Expected month at 1:6, found "x".'
  failed.expected; // [{ kind: "rule", rule: "month" }]
  failed.span; // { start: 5, end: 6 }
}
```

The parser accepts exactly the strings the regex accepts. Where an input could be split more than one way, it returns the split the regex would make. Every loop iteration is kept, unlike a regex capture inside a loop. It runs in time linear in the input for every grammar, so it is safe on input that would make a backtracking regex hang. When an input does not match, the parser reports the furthest point any reading of it reached, what could have come next there, and the line and column.

## Defining a grammar

`grammar()` starts a builder. Each `.define(name, builder)` adds a rule, and the builder function receives references to the rules defined before it, by name. `.compose()` finishes the grammar. Builders are immutable, so two grammars can branch from a shared prefix.

A rule body is built from these combinators. Each one also decides what its part of the rule's AST node looks like:

| combinator                                                       | matches                                                    | contributes                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| `literal("-")`                                                   | exactly that text                                          | the text, `string`                                             |
| `range("a", "z")`                                                | one code point in the inclusive range                      | the code point, `string`                                       |
| `sequence([a, b])`                                               | `a` then `b`                                               | a tuple, `readonly [A, B]`                                     |
| `either(a, b)`                                                   | `a` or `b`, preferring `a`                                 | `{ alternative: 0, value: A } \| { alternative: 1, value: B }` |
| `optional(a)`                                                    | `a` or nothing, preferring `a`                             | `A \| undefined`                                               |
| `zeroOrMore(a)`, `oneOrMore(a)`, `repeat(a, { min: 2, max: 4 })` | `a` repeated, greedily; leave out `max` for no upper bound | `readonly A[]`, every iteration                                |
| a reference, such as `digit`                                     | the referenced rule                                        | that rule's node, `Node<"digit", …>`                           |

Each rule's node is a `Node<Name, Children>`, whose `children` are what its body contributes:

```ts
const list = grammar()
  .define("letter", () => range("a", "z"))
  .define("name", ({ letter }) => oneOrMore(letter))
  .define("number", () => oneOrMore(range("0", "9")))
  .define("value", ({ name, number }) => either(name, number))
  .define("list", ({ value }) =>
    sequence([value, zeroOrMore(sequence([literal(","), value]))]),
  )
  .compose();

toPattern(list, "list"); // "^(?:[a-z]+|[0-9]+)(?:,(?:[a-z]+|[0-9]+))*$"

const parsed = toParser(list, "list")("ab,12,c");
if (parsed.ok) {
  const [first, rest] = parsed.node.children;
  first.children; // { alternative: 0, value: Node<"name", …> }, whose text is "ab"
  rest.map(([, value]) => value.text); // ["12", "c"]
}
```

A string matches a grammar when some way of reading it through the rules works, as with an anchored regex. `either` does not commit to the first alternative that matches: `sequence([either(literal("a"), literal("ab")), literal("c")])` accepts `abc`. Preference decides only which reading the parser returns when there is more than one, and it is the one the regex engine would pick.

Each builder sees only earlier rules, so a rule cannot refer to itself, and every grammar is regular and has a regex form. Nested formats (JSON, arithmetic expressions) are out of scope for now.

`.define()` checks each rule as it is added and throws an error that names the rule: a duplicate name, a reference to a rule that is not defined yet, a range whose endpoints are not single code points or are reversed, repetition bounds that are not whole numbers with `min ≤ max`, an `either` with no alternatives, and a repetition or `optional` whose body can match the empty string. That last one is ambiguous about how many times an empty match repeats, and JS regex resolves it in a way a linear-time parser cannot reproduce; move the `optional` outside the loop instead.

## Parsing

`toParser(grammar, rule)` compiles the rule once and returns a function from a string to a `ParseResult`. Reuse that function across inputs. A failed parse is a result, never an exception.

- `{ ok: true, node }`: `node` is the rule's `Node`, with `rule` (its name), `span`, `text` (the matched text), and `children`.
- `{ ok: false, span, expected, message }`: the parse failed at `span.start`, the furthest offset any reading of the input reached. `span` covers the code point found there, so it is empty at the end of the input.

`expected` lists what could have come next at that offset, in the order the grammar prefers them:

- `{ kind: "rule", rule }`: a named rule that would have started there. Where several start at once, one inside another, the outermost is reported: `month`, not the `digit` that begins it. The rule being parsed is never reported, since it starts at offset 0 of every input.
- `{ kind: "characters", ranges }`: characters that could have come next where no named rule starts, as inclusive `[from, to]` ranges.
- `{ kind: "end" }`: a complete match was found, but the input continues.

```ts
const failure = toParser(list, "list")("ab;12");
if (!failure.ok) {
  failure.message; // 'Expected letter, ",", or end of input at 1:3, found ";".'
  failure.expected;
  // [{ kind: "rule", rule: "letter" }, { kind: "characters", ranges: [[",", ","]] }, { kind: "end" }]
}
```

Span offsets are UTF-16 offsets, so `input.slice(span.start, span.end)` is the matched text. `span.position()` gives both ends as `{ start: { line, column }, end: { line, column } }`: 1-based lines, ending at `\n`, `\r\n`, or `\r`, and 1-based columns counted in code points. Like the offset, `end` is just past the last code point, so a span that ends with a line break ends at column 1 of the next line. Positions are computed only when asked for.

The parser matches whole inputs only. To find matches inside a longer string, use the regex with `anchored: false`.

## Regex output

`toPattern(grammar, rule, options)` returns pattern source, and `toRegExp` compiles it with the `v` flag. Patterns:

- are anchored, `^…$`, unless `{ anchored: false }`. Anchoring makes the pattern accept what the parser accepts, and it is what a JSON Schema `pattern` needs, since JSON Schema does not anchor `pattern` itself.
- mean the same under the `u` flag as under `v`, so validators that compile with `u` read them correctly.
- have no capturing groups. Extracting structure is the parser's job.

References are inlined, because JS regex cannot call a subpattern, so a rule referenced many times is written out each time. That keeps realistic grammars small (an IPv4 address is 216 characters, a full log line about 1,200), but a pattern grows with how often rules are reused.

## Safe by default

A backtracking regex engine can take exponential time on a pattern that can match the same input in many ways, such as `(?:\w+| )*`. That is a denial-of-service risk (ReDoS) wherever the input is untrusted. `toPattern` and `toRegExp` analyze every pattern and throw `VulnerablePatternError` rather than return one that can take superlinear time:

```ts
const words = grammar()
  .define("word", () => oneOrMore(range("a", "z")))
  .define("text", ({ word }) => zeroOrMore(either(word, literal(" "))))
  .compose();

toRegExp(words, "text"); // throws VulnerablePatternError: exponential time, in rule "text"
analyze(words, "text");
// { complexity: "exponential", rule: "text", attack: { prefix: "a", pump: "aa", suffix: "!" }, exact: true }
```

`analyze` reports how slow a pattern can be, and an input that shows it, without throwing. The parser runs in linear time for every grammar, so it is the safe way to read untrusted input whatever the analysis says. To accept slower patterns, configure the instance: `initialize({ allowedComplexity: "polynomial" })` allows polynomial ones, and `initialize({ allowedComplexity: "exponential" })` allows everything. The analysis accounts for match priority, so it is exact for a backtracking engine: a search (`anchored: false`) stops at its first match, so `text` above is linear as a search. For a pattern too large to analyze exactly within `analysisBudget`, it falls back to an answer that ignores priority and says so with `exact: false`. That answer never misses a slow pattern, but it can flag one a real engine finishes quickly.

## Configuration

`initialize(config)` builds `toPattern`, `toRegExp`, `toParser`, and `analyze` from a config. Every field is optional, and an unknown value throws `InvalidConfigError` rather than falling back to a default, so a typo cannot turn the check off.

| field               | default     | meaning                                                                                                                             |
| ------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `allowedComplexity` | `"linear"`  | The slowest pattern `toPattern` and `toRegExp` return: `"linear"`, `"polynomial"`, or `"exponential"`, which allows everything.     |
| `analysisBudget`    | `1_000_000` | Steps the analysis may spend on match priority before falling back to `exact: false`. `0` always falls back; `Infinity` never does. |

## Errors

Everything the library throws is an `AsterError`, and each subclass is on its namespace, such as `AsterError.VulnerablePatternError`. Each one's `name` is `"@ghostry/aster:<Class>"`, so it can be told apart where `instanceof` cannot, such as across two installed copies of the package. Context is on readonly fields, such as `rule`.

| error                     | thrown by                                      | when                                                       |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `DuplicateRuleError`      | `.define()`                                    | the name is already defined                                |
| `UnknownReferenceError`   | `.define()`                                    | the body refers to a rule not defined before it            |
| `InvalidRangeError`       | `.define()`                                    | an endpoint is not one code point, or they are reversed    |
| `InvalidRepetitionError`  | `.define()`                                    | `min` or `max` is not a valid bound                        |
| `EmptyEitherError`        | `.define()`                                    | an `either` has no alternatives                            |
| `NullableQuantifierError` | `.define()`                                    | a repetition or `optional` body can match the empty string |
| `InvalidExpressionError`  | `.define()`                                    | a body contains something that is not an expression        |
| `InvalidConfigError`      | `initialize()`                                 | a config field has a value it does not accept              |
| `VulnerablePatternError`  | `toPattern`, `toRegExp`                        | the pattern is slower than `allowedComplexity`             |
| `UnknownRuleError`        | `toPattern`, `toRegExp`, `toParser`, `analyze` | the grammar has no rule by that name                       |

## Grammars as data

A composed grammar is plain, frozen data: `{ rules: [{ name, body }, …] }`, in definition order, with references held by name. It survives a JSON round trip, and `toPattern`, `toRegExp`, `toParser`, and `analyze` accept a grammar that arrived that way, checking it as `.define()` would.

The node types and a walking helper are exported from `@ghostry/aster/unstable-ir`, for tools that read a grammar's structure. As the name says, any of it can change in any release until it is settled.

## License

MIT
