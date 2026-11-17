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
> Pre-release. Grammar definition, validation, the regex emitter with ReDoS analysis, and the parser with its failure reports work, and are fuzzed against each other and against recheck. Nothing is published.

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

## Safe by default

A backtracking regex engine can take exponential time on a pattern that can match the same input in many ways, such as `(?:\w+| )*`. That is a denial-of-service risk (ReDoS) wherever the input is untrusted. `toPattern` and `toRegExp` analyze every pattern and throw `VulnerablePatternError` rather than return one that can take superlinear time:

```ts
const words = grammar()
  .define("word", () => oneOrMore(range("a", "z")))
  .define("text", ({ word }) => zeroOrMore(either(word, literal(" "))))
  .compose();

toRegExp(words, "text"); // throws VulnerablePatternError: exponential time, in rule "text"
analyze(words, "text");
// { complexity: "exponential", rule: "text", attack: { prefix: "a", pump: "aa", suffix: "\u0000" } }
```

`analyze` reports how slow a pattern can be, and an input that shows it, without throwing. The parser runs in linear time for every grammar, so it is the safe way to read untrusted input whatever the analysis says. To accept slower patterns, configure the instance: `initialize({ allowedComplexity: "polynomial" })` allows polynomial ones, and `initialize({ allowedComplexity: "exponential" })` allows everything. The analysis is conservative. It never misses a slow pattern, but for a search (`anchored: false`) it can flag one that a real engine finishes quickly, because a search stops at its first match.

Patterns are anchored by default, have no capturing groups, and are valid under both the `v` flag and the `u` flag, so they work as a JSON Schema `pattern`.

Each builder receives only the rules defined before it, so every grammar is regular and always has a regex form. Nested formats (JSON, expressions) are out of scope for now.

`.define()` validates each rule as it is added: range endpoints, repetition bounds, references, and loops or `optional()`s whose body could match the empty string are all rejected, with an error that names the rule.

## License

MIT
