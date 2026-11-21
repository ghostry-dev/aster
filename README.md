<div align="center">

<picture><img src="https://docs.ghostry.dev/logo.png" alt="ghostry" width="96" height="96"></picture>

# @ghostry/aster

**One grammar, two outputs: a `RegExp` for validation and a parser that returns a typed AST.**

Define a grammar once. Use the regex where you need a fast yes or no in any engine that reads ECMA-262, such as a JSON Schema `pattern`. Use the parser where you need the structure: every rule as a typed node with source spans, and every loop iteration kept. Both accept exactly the same strings.

[![npm](https://img.shields.io/badge/npm-ffffff.svg?style=for-the-badge&color=000000&logo=npm&logoColor=CB3837)](https://www.npmjs.com/package/@ghostry/aster)
[![npmx](https://img.shields.io/badge/npmx-ffffff.svg?style=for-the-badge&color=000000&logo=data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNTMiIGhlaWdodD0iMTUzIiB2ZXJzaW9uPSIxLjEiIHZpZXdCb3g9IjAgMCAxNTMgMTUzIj4KICA8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNi43MDQgOS45ODI3KSI+CiAgICA8cGF0aCBkPSJtMC45MzQ3NiA5Ny4yMDVoMjQuMDgxdjIzLjY5M2gtMjQuMDgxeiIgZmlsbD0iI2ZmZiI+PC9wYXRoPgogICAgPHBhdGggZD0ibTEwMy4xMi05LjIzMDctMy42MjExIDEwLjI0Ni00Ni4zMDkgMTMxLTMuNjIxMSAxMC4yNDZoMTUuNTM3bDMuNjIxMS0xMC4yNDYgMTEuNzE3LTMzLjE0OCAzOC4yMTEtMTA4LjF6IiBmaWxsPSIjNTFjOGZjIj48L3BhdGg+CiAgPC9nPgo8L3N2Zz4K&logoColor=51C8FC)](https://npmx.dev/package/@ghostry/aster)
[![jsr](https://img.shields.io/badge/jsr-ffffff?style=for-the-badge&color=000000&logo=jsr&logoColor=F7DF1E)](https://jsr.io/@ghostry/aster)
[![github](https://img.shields.io/badge/github-ffffff?style=for-the-badge&color=000000&logo=github&logoColor=ffffff)](https://github.com/ghostry-dev/aster)
<picture><img alt="typescript" src="https://img.shields.io/badge/typescript-ffffff?style=for-the-badge&color=000000&logo=typescript&logoColor=3178C6"></picture>
<picture><img alt="bun" src="https://img.shields.io/badge/bun-ffffff?style=for-the-badge&color=000000&logo=bun&logoColor=FBF0DF"></picture>
<picture><img alt="node" src="https://img.shields.io/badge/node-ffffff?style=for-the-badge&color=000000&logo=nodedotjs&logoColor=5FA04E"></picture>

[**Documentation**](https://docs.ghostry.dev/aster) &nbsp;·&nbsp; [**Guides**](https://docs.ghostry.dev/aster/guides/grammars) &nbsp;·&nbsp; [**API Reference**](https://docs.ghostry.dev/aster/reference/api)

</div>

> [!WARNING]
> v0 is in active development, and breaking changes occur frequently. Read the [changelog](https://docs.ghostry.dev/aster/changelog/aster) before every update.

## Install

```bash
npm install @ghostry/aster
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

The parser accepts exactly the strings the regex accepts, and where an input could be read more than one way, it returns the reading the regex would pick. Every loop iteration is kept, unlike a regex capture inside a loop. See the [docs site](https://docs.ghostry.dev/aster) for the full guide.

## Safe by default

A backtracking regex engine can take exponential time on a pattern that matches the same input in many ways, such as `(?:\w+| )*`. `toPattern` and `toRegExp` analyze every pattern and throw rather than return one that can take superlinear time:

```ts
const words = grammar()
  .define("word", () => oneOrMore(range("a", "z")))
  .define("text", ({ word }) => zeroOrMore(either(word, literal(" "))))
  .compose();

toRegExp(words, "text"); // throws VulnerablePatternError: exponential time, in rule "text"
analyze(words, "text");
// { complexity: "exponential", rule: "text", attack: { prefix: "a", pump: "aa", suffix: "!" }, exact: true }
```

The parser runs in linear time for every grammar, so it is the safe way to read untrusted input whatever the analysis says. See [Safe by default](https://docs.ghostry.dev/aster/guides/safety).

## Ready for JSON Schema

Patterns are anchored, have no capturing groups, and mean the same under the `u` flag as under `v`, so a pattern works as a JSON Schema `pattern` exactly as `toPattern` returns it. See [Regex output](https://docs.ghostry.dev/aster/guides/regex).

## Errors that say where

A failed parse is a result, not an exception. It reports the furthest point any reading of the input reached, what could have come next there, and the line and column, as in `Expected month at 1:6, found "x".` See [Parsing](https://docs.ghostry.dev/aster/guides/parsing).

## License

[MIT](LICENSE) © Patrick Rebsch
