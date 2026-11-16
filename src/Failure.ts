import { Source, SourceSpan } from "./Source";
import type { Expectation, ParseFailure } from "./Types";

/**
 * The result for an input that did not match, failing at `offset` with what the
 * parse could have continued with there.
 *
 * The span covers the code point found, so `input.slice(span.start, span.end)`
 * is it, and is empty at the end of the input. The message is built now rather
 * than on demand: it costs one pass over the input for the line index, which
 * the parse that failed has already paid for many times over.
 */
export function failure(
  source: Source,
  offset: number,
  expected: readonly Expectation[],
): ParseFailure {
  const point = source.input.codePointAt(offset);
  const width = point === undefined ? 0 : point > 0xffff ? 2 : 1;
  const span = new SourceSpan(source, offset, offset + width);
  const { line, column } = source.position(offset);
  const found =
    point === undefined ? "end of input" : quote(String.fromCodePoint(point));
  const message = `Expected ${list(expected.map(describe))} at ${line}:${column}, found ${found}.`;
  return { ok: false, span, expected, message };
}

/**
 * An expectation as a person reads it: a rule by name, characters as a quoted
 * character or a class, and the end of the input in words.
 */
function describe(expectation: Expectation): string {
  switch (expectation.kind) {
    case "rule":
      return expectation.rule;
    case "end":
      return "end of input";
    case "characters": {
      const [only] = expectation.ranges;
      if (
        expectation.ranges.length === 1
        && only !== undefined
        && only[0] === only[1]
      )
        return quote(only[0]);
      const members = expectation.ranges.map(([from, to]) =>
        from === to ? escape(from) : `${escape(from)}-${escape(to)}`,
      );
      return `[${members.join("")}]`;
    }
  }
}

/**
 * JSON's escaping, which makes control characters, quotes, and lone surrogates
 * visible.
 */
function escape(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

function quote(text: string): string {
  return `"${escape(text)}"`;
}

function list(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" or ");
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}
