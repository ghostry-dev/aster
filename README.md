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
> Pre-release. Only grammar definition and AST type inference exist so far; the regex emitter and the parser are not built yet. Nothing is published.

## Example

```ts
import { grammar, literal, range, sequence, type AstOf } from "@ghostry/aster";

const date = grammar()
  .define("digit", () => range("0", "9"))
  .define("year", ({ digit }) => sequence([digit, digit, digit, digit]))
  .define("month", ({ digit }) => sequence([digit, digit]))
  .define("date", ({ year, month }) => sequence([year, literal("-"), month]))
  .compose();

type DateNode = AstOf<typeof date, "date">;
// Node<"date", readonly [Node<"year", …>, string, Node<"month", …>]>
```

Each builder receives only the rules defined before it, so every grammar is regular and always has a regex form. Nested formats (JSON, expressions) are out of scope for now.

## License

MIT
