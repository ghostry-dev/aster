import type { Position, Span } from "./Types";

/**
 * One parse's input, shared by every node and span of that parse. The index of
 * line starts is built the first time a position is asked for, so a parse that
 * never asks pays nothing for it.
 */
export class Source {
  #lines: readonly number[] | undefined;

  constructor(readonly input: string) {}

  /**
   * The 1-based line and column of a UTF-16 offset. Lines end at `\n`, `\r\n`,
   * or a lone `\r`. Columns count code points, which is how a person reads a
   * line, so an astral character is one column.
   */
  position(offset: number): Position {
    this.#lines ??= lineStarts(this.input);
    const lines = this.#lines;
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if ((lines[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    let column = 1;
    for (let at = lines[low] ?? 0; at < offset; column += 1) {
      const point = this.input.codePointAt(at) ?? 0;
      at += point > 0xffff ? 2 : 1;
    }
    return { line: low + 1, column };
  }
}

function lineStarts(input: string): readonly number[] {
  const starts = [0];
  for (let at = 0; at < input.length; at += 1) {
    const unit = input.charCodeAt(at);
    if (unit === 0x0a) starts.push(at + 1);
    else if (unit === 0x0d) {
      if (input.charCodeAt(at + 1) === 0x0a) at += 1;
      starts.push(at + 1);
    }
  }
  return starts;
}

/**
 * A {@link Span} over a {@link Source}. The source is a private field, so a
 * span's own properties are just its offsets.
 */
export class SourceSpan implements Span {
  readonly #source: Source;

  constructor(
    source: Source,
    readonly start: number,
    readonly end: number,
  ) {
    this.#source = source;
  }

  position(): { readonly start: Position; readonly end: Position } {
    return {
      start: this.#source.position(this.start),
      end: this.#source.position(this.end),
    };
  }
}
