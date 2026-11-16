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
> Pre-release. Grammar definition, validation, the regex emitter, and the parser work; failure details beyond an offset, and ReDoS analysis, are not built yet. Nothing is published.

## Example

```ts
import {
  grammar,
  literal,
  range,
  sequence,
  toParser,
  toPattern,
  toRegExp,
  type AstOf,
} from "@ghostry/aster";

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
parse("2026-1x"); // { ok: false, offset: 6 }
```

The parser accepts exactly the strings the regex accepts. Where an input could be split more than one way, it returns the split the regex would make. Every loop iteration is kept, unlike a regex capture inside a loop. It runs in time linear in the input for every grammar, so it is safe on input that would make a backtracking regex hang.

Patterns are anchored by default, have no capturing groups, and are valid under both the `v` flag and the `u` flag, so they work as a JSON Schema `pattern`.

Each builder receives only the rules defined before it, so every grammar is regular and always has a regex form. Nested formats (JSON, expressions) are out of scope for now.

`.define()` validates each rule as it is added: range endpoints, repetition bounds, references, and loops whose body could match the empty string are all rejected, with an error that names the rule.

## License

MIT
