import {
  AsterError,
  either,
  grammar,
  literal,
  oneOrMore,
  optional,
  range,
  sequence,
  toParser,
  toRegExp,
  zeroOrMore,
  type AstOf,
  type Grammar,
  type Node,
  type ParseResult,
  type RuleNames,
} from "@ghostry/aster";
import { attest, describe, expect, test } from ".";
import { deep } from "./fixtures/deep";
import { nearMisses } from "./fixtures/inputs";
import { realistic } from "./stress/Realistic";

type Realistic = RuleNames<typeof realistic>;
type AnyNode = Node<string, unknown>;

function parsed<$Node>(result: ParseResult<$Node>): $Node {
  if (!result.ok) throw new Error(`failed at ${result.offset}`);
  return result.node;
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && "rule" in value;
}

/**
 * Every node under `root`, root first, found with an explicit stack: through
 * tuples, arrays, `either`'s `{ alternative, value }`, and nested nodes.
 */
function nodes(root: AnyNode): AnyNode[] {
  const found: AnyNode[] = [];
  const pending: unknown[] = [root];
  for (let value = pending.pop(); ; value = pending.pop()) {
    if (Array.isArray(value)) pending.push(...[...value].reverse());
    else if (isNode(value)) {
      found.push(value);
      pending.push(value.children);
    } else if (typeof value === "object" && value !== null)
      pending.push(...Object.values(value));
    if (pending.length === 0) return found;
  }
}

/**
 * The node with its spans and text written out, and nothing else, for comparing
 * whole trees.
 */
function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, inner: unknown) =>
      isNode(inner)
        ? {
            rule: inner.rule,
            at: [inner.span.start, inner.span.end],
            children: inner.children,
          }
        : inner,
    ),
  );
}

const date = grammar()
  .define("digit", () => range("0", "9"))
  .define("year", ({ digit }) => sequence([digit, digit, digit, digit]))
  .define("month", ({ digit }) => sequence([digit, digit]))
  .define("date", ({ year, month }) => sequence([year, literal("-"), month]))
  .compose();

describe("nodes", () => {
  const parse = toParser(date, "date");

  test("every named rule is a node with its span and text", () => {
    const node = parsed(parse("2026-11"));
    const typed: AstOf<typeof date, "date"> = node;
    const [year, dash, month] = typed.children;
    expect([year.rule, year.text, year.span.start, year.span.end]).toEqual([
      "year",
      "2026",
      0,
      4,
    ]);
    expect(dash).toBe("-");
    expect([month.rule, month.text]).toEqual(["month", "11"]);
    expect(month.children.map((digit) => digit.text)).toEqual(["1", "1"]);
    expect(node.text).toBe("2026-11");
  });

  test("a node's own properties are its rule, span, and children", () => {
    const node = parsed(parse("2026-11"));
    expect(Object.keys(node)).toEqual(["rule", "span", "children"]);
    expect(Object.keys(node.span)).toEqual(["start", "end"]);
  });

  test("a non-matching input is a failure result, not an exception", () => {
    expect(parse("2026-1x")).toEqual({ ok: false, offset: 6 });
    expect(parse("2026-110")).toEqual({ ok: false, offset: 7 });
    expect(parse("")).toEqual({ ok: false, offset: 0 });
  });

  test("a parser is reusable", () => {
    expect(parsed(parse("2026-11")).text).toBe("2026-11");
    expect(parsed(parse("1999-01")).text).toBe("1999-01");
  });
});

describe("children follow the rule's shape", () => {
  const digit = range("0", "9");

  test("a greedy loop gives back one iteration: [12][3]", () => {
    const composed = grammar()
      .define("number", () => sequence([zeroOrMore(digit), digit]))
      .compose();
    const node = parsed(toParser(composed, "number")("123"));
    expect(node.children).toEqual([["1", "2"], "3"]);
  });

  test("either records the alternative that matched: [ab][c]", () => {
    const composed = grammar()
      .define("rule", () =>
        sequence([either(literal("a"), literal("ab")), literal("c")]),
      )
      .compose();
    const node = parsed(toParser(composed, "rule")("abc"));
    expect(node.children).toEqual([{ alternative: 1, value: "ab" }, "c"]);
  });

  test("a longer alternative is abandoned when it must be: [a][bc]", () => {
    const composed = grammar()
      .define("rule", () =>
        sequence([either(literal("ab"), literal("a")), literal("bc")]),
      )
      .compose();
    const node = parsed(toParser(composed, "rule")("abc"));
    expect(node.children).toEqual([{ alternative: 1, value: "a" }, "bc"]);
  });

  test("two alternatives with the same text are told apart", () => {
    const composed = grammar()
      .define("rule", () =>
        sequence([either(literal("a"), literal("a")), literal("b")]),
      )
      .compose();
    const node = parsed(toParser(composed, "rule")("ab"));
    expect(node.children[0]).toEqual({ alternative: 0, value: "a" });
  });

  test("optional is the value or undefined", () => {
    const composed = grammar()
      .define("rule", () => sequence([optional(literal("-")), digit]))
      .compose();
    const parse = toParser(composed, "rule");
    expect(parsed(parse("-1")).children).toEqual(["-", "1"]);
    expect(parsed(parse("1")).children).toEqual([undefined, "1"]);
  });

  test("a repetition keeps every iteration, unlike a regex capture", () => {
    const composed = grammar()
      .define("word", () => either(literal("cat"), literal("dog")))
      .define("words", ({ word }) => oneOrMore(word))
      .compose();
    const node = parsed(toParser(composed, "words")("catdogcat"));
    expect(plain(node)).toEqual({
      rule: "words",
      at: [0, 9],
      children: [
        {
          rule: "word",
          at: [0, 3],
          children: { alternative: 0, value: "cat" },
        },
        {
          rule: "word",
          at: [3, 6],
          children: { alternative: 1, value: "dog" },
        },
        {
          rule: "word",
          at: [6, 9],
          children: { alternative: 0, value: "cat" },
        },
      ],
    });
    expect(/^(cat|dog)+$/.exec("catdogcat")?.[1]).toBe("cat");
  });

  test("an empty match has an empty span", () => {
    const composed = grammar()
      .define("blank", () => literal(""))
      .define("rule", ({ blank }) => sequence([literal("a"), blank]))
      .compose();
    const node = parsed(toParser(composed, "rule")("a"));
    expect(plain(node)).toEqual({
      rule: "rule",
      at: [0, 1],
      children: ["a", { rule: "blank", at: [1, 1], children: "" }],
    });
  });

  test("a range matches an astral character as one code point", () => {
    const composed = grammar()
      .define("face", () => range("😀", "😿"))
      .define("faces", ({ face }) => oneOrMore(face))
      .compose();
    const node = parsed(toParser(composed, "faces")("😀😺"));
    expect(plain(node)).toEqual({
      rule: "faces",
      at: [0, 4],
      children: [
        { rule: "face", at: [0, 2], children: "😀" },
        { rule: "face", at: [2, 4], children: "😺" },
      ],
    });
  });
});

describe("positions", () => {
  const composed = grammar()
    .define("char", () => either(range("a", "z"), range("😀", "😿")))
    .define("word", ({ char }) => oneOrMore(char))
    .define("break", () =>
      either(literal("\n"), literal("\r\n"), literal("\r")),
    )
    .define("lines", ({ word, break: newline }) =>
      sequence([word, zeroOrMore(sequence([newline, word]))]),
    )
    .compose();
  const parse = toParser(composed, "lines");

  test("are 1-based, and columns count code points", () => {
    const node = parsed(parse("ab\n😀cd\r\nef\rg"));
    const words = nodes(node)
      .filter(({ rule }) => rule === "word")
      .map(({ text, span }) => [text, span.position()]);
    expect(words).toEqual([
      ["ab", { line: 1, column: 1 }],
      ["😀cd", { line: 2, column: 1 }],
      ["ef", { line: 3, column: 1 }],
      ["g", { line: 4, column: 1 }],
    ]);
    const chars = nodes(node)
      .filter(({ rule }) => rule === "char")
      .map(
        ({ text, span }) =>
          `${text}@${Object.values(span.position()).join(":")}`,
      );
    expect(chars.slice(2, 5)).toEqual(["😀@2:1", "c@2:2", "d@2:3"]);
  });
});

describe("the realistic grammar", () => {
  const accepted: readonly (readonly [Realistic, string])[] = [
    ["timestamp", "2026-11-15T09:30:00Z"],
    ["timestamp", "2026-11-15T09:30:00.123+05:30"],
    ["semver", "10.20.30-alpha.1+build.5"],
    ["semver", "0.0.0-0"],
    ["ipv4", "192.168.0.1"],
    ["ipv4", "255.255.255.255"],
    ["uri", "https://example.com/a/b?q=1#top"],
    ["uri", "s3+x://10.0.0.1:9000/bucket"],
    [
      "logLine",
      "2026-11-15T09:30:00Z INFO 10.0.0.1 https://example.com/x 1.2.3 user=ada -- signed in",
    ],
  ];

  test.each(accepted)(
    "%s parses %p, and its near misses agree with the regex",
    ({ row: [rule, input] }) => {
      const parse = toParser(realistic, rule);
      const regex = toRegExp(realistic, rule);
      const root = parsed(parse(input));
      expect([root.span.start, root.span.end]).toEqual([0, input.length]);
      for (const node of nodes(root))
        expect(node.text).toBe(input.slice(node.span.start, node.span.end));
      for (const candidate of nearMisses(input))
        expect([candidate, parse(candidate).ok]).toEqual([
          candidate,
          regex.test(candidate),
        ]);
    },
  );

  test("an IPv4 octet picks the alternative regex would", () => {
    const root = parsed(toParser(realistic, "ipv4")("255.25.2.0"));
    const octets = root.children
      .filter(
        (child): child is AstOf<typeof realistic, "decOctet"> =>
          child.rule === "decOctet",
      )
      .map(({ children }) => children.alternative);
    expect(octets).toEqual([0, 3, 4, 4]);
  });
});

describe("grammars that arrive as data", () => {
  test("a JSON round trip parses to the same tree", () => {
    const data = JSON.parse(JSON.stringify(realistic)) as Grammar;
    const input = "2026-11-15T09:30:00.5-08:00";
    expect(plain(parsed(toParser(data, "timestamp")(input)))).toEqual(
      plain(parsed(toParser(realistic, "timestamp")(input))),
    );
  });

  test("an unknown rule name throws UnknownRuleError", () => {
    const error = attest.throws(AsterError.UnknownRuleError, () =>
      // @ts-expect-error `nope` is not a rule of this grammar
      toParser(date, "nope"),
    );
    expect(error.rule).toBe("nope");
  });

  test("an invalid rule is rejected as .define() would reject it", () => {
    const broken: Grammar = {
      rules: [{ name: "bad", body: { kind: "range", from: "z", to: "a" } }],
    };
    attest.throws(AsterError.InvalidRangeError, () => toParser(broken, "bad"));
  });
});

/**
 * The VM, the trace, and the fold are all loops, so neither nesting depth nor
 * input length is bounded by the call stack.
 */
describe("size", () => {
  test("a body nested a hundred thousand levels deep parses", () => {
    const DEPTH = 100_000;
    const body = deep(DEPTH);
    const parse = toParser(
      grammar()
        .define("deep", () => body)
        .compose(),
      "deep",
    );

    /**
     * The children nest one `[x, inner]` tuple per level, down to `"ab"`.
     */
    const unwrap = (input: string): [number, unknown, unknown] => {
      const root: unknown = parsed(parse(input)).children;
      let value = root;
      let depth = 0;
      for (; Array.isArray(value); depth += 1) value = value[1];
      return [depth, value, Array.isArray(root) ? root[0] : root];
    };
    expect(unwrap("ab")).toEqual([DEPTH, "ab", undefined]);
    expect(unwrap("xab")).toEqual([DEPTH, "ab", "x"]);
    expect(parse("abx")).toEqual({ ok: false, offset: 2 });
  });

  test("a hundred thousand iterations of a named rule parse", () => {
    const COUNT = 100_000;
    const composed = grammar()
      .define("bit", () => either(literal("0"), literal("1")))
      .define("bits", ({ bit }) => oneOrMore(bit))
      .compose();
    const input = "01".repeat(COUNT / 2);
    const root = parsed(toParser(composed, "bits")(input));
    expect(root.children).toHaveLength(COUNT);
    expect(root.children[COUNT - 1]?.span).toMatchObject({
      start: COUNT - 1,
      end: COUNT,
    });
  });
});
