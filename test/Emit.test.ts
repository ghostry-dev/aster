import {
  AsterError,
  either,
  grammar,
  literal,
  oneOrMore,
  optional,
  range,
  repeat,
  sequence,
  toPattern,
  toRegExp,
  zeroOrMore,
  type Grammar,
  type RuleNames,
} from "@ghostry/aster";
import type { Expr } from "@ghostry/aster/unstable-ir";
import { attest, describe, expect, test } from ".";
import { realistic } from "./stress/Realistic";

const shapes = grammar()
  .define("digit", () => range("0", "9"))
  .define("hex", ({ digit }) => either(digit, range("a", "f"), range("A", "F")))
  .define("sign", () => either(literal("+"), literal("-")))
  .define("word", () => either(literal("cat"), literal("dog")))
  .define("dotted", ({ word, digit }) => sequence([word, literal("."), digit]))
  .define("words", ({ word }) => oneOrMore(word))
  .define("maybeRun", () => optional(oneOrMore(literal("a"))))
  .define("pairs", () => repeat(literal("ab"), { min: 2, max: 4 }))
  .define("atLeast", ({ hex }) => repeat(hex, { min: 3 }))
  .define("exactly", ({ digit }) => repeat(digit, { min: 4, max: 4 }))
  .define("once", ({ word }) => repeat(word, { min: 1, max: 1 }))
  .define("upToOne", () => repeat(literal("x"), { min: 0, max: 1 }))
  .define("tail", () =>
    zeroOrMore(sequence([literal("x"), optional(literal("y"))])),
  )
  .define("single", () => either(literal("a")))
  .define("adjacent", () => either(literal("a"), literal("b"), range("c", "e")))
  .define("blank", () => sequence([literal(""), sequence([])]))
  .define("orBlank", () => either(literal("ab"), literal("")))
  .compose();

type Shape = RuleNames<typeof shapes>;
type Realistic = RuleNames<typeof realistic>;

describe("pattern shape", () => {
  const cases: readonly (readonly [Shape, string])[] = [
    ["digit", "^[0-9]$"],
    ["hex", "^[0-9A-Fa-f]$"],
    ["sign", "^[+\\-]$"],
    ["word", "^(?:cat|dog)$"],
    ["dotted", "^(?:cat|dog)\\.[0-9]$"],
    ["words", "^(?:cat|dog)+$"],
    ["maybeRun", "^(?:a+)?$"],
    ["pairs", "^(?:ab){2,4}$"],
    ["atLeast", "^[0-9A-Fa-f]{3,}$"],
    ["exactly", "^[0-9]{4}$"],
    ["once", "^(?:cat|dog)$"],
    ["upToOne", "^x?$"],
    ["tail", "^(?:xy?)*$"],
    ["single", "^a$"],
    ["adjacent", "^[a-e]$"],
    ["blank", "^$"],
    ["orBlank", "^(?:ab|)$"],
  ];

  test.each(cases)("%s → %s", ({ row: [rule, expected] }) => {
    expect(toPattern(shapes, rule)).toBe(expected);
  });

  test("anchored: false leaves the pattern bare", () => {
    expect(toPattern(shapes, "word", { anchored: false })).toBe("cat|dog");
    expect(toPattern(shapes, "digit", { anchored: false })).toBe("[0-9]");
    expect(toPattern(shapes, "blank", { anchored: false })).toBe("");
  });

  test("an unanchored regex finds a match inside a longer string", () => {
    const regex = toRegExp(shapes, "dotted", { anchored: false });
    expect(regex.exec("a dog.7 here")?.[0]).toBe("dog.7");
    expect(toRegExp(shapes, "dotted").test("a dog.7 here")).toBe(false);
  });

  test("toRegExp compiles the same source with the v flag", () => {
    const regex = toRegExp(shapes, "hex");
    expect(regex.flags).toBe("v");
    expect(regex.source).toBe(toPattern(shapes, "hex"));
  });
});

describe("the realistic grammar", () => {
  const accepts: readonly (readonly [Realistic, string])[] = [
    ["timestamp", "2026-11-15T09:30:00Z"],
    ["timestamp", "2026-11-15T09:30:00.123+05:30"],
    ["semver", "1.0.0"],
    ["semver", "10.20.30-alpha.1+build.5"],
    ["semver", "0.0.0-0"],
    ["ipv4", "192.168.0.1"],
    ["ipv4", "255.255.255.255"],
    ["ipv4", "0.0.0.0"],
    ["uri", "https://example.com/a/b?q=1#top"],
    ["uri", "s3+x://10.0.0.1:9000/bucket"],
    ["uri", "file:///"],
    [
      "logLine",
      "2026-11-15T09:30:00Z INFO 10.0.0.1 https://example.com/x 1.2.3 user=ada -- signed in",
    ],
  ];
  const rejects: readonly (readonly [Realistic, string])[] = [
    ["timestamp", "2026-11-15 09:30:00Z"],
    ["timestamp", "2026-11-15T09:30:00"],
    ["semver", "1.0"],
    ["semver", "01.0.0"],
    ["semver", "1.0.0-"],
    ["ipv4", "256.0.0.1"],
    ["ipv4", "1.2.3"],
    ["ipv4", "01.2.3.4"],
    ["uri", "https:/example.com"],
    ["uri", "1http://x"],
    ["logLine", "2026-11-15T09:30:00Z TRACE 10.0.0.1 https://x 1.2.3 -- hi"],
  ];

  test.each(accepts)("%s accepts %p", ({ row: [rule, input] }) => {
    expect(toRegExp(realistic, rule).test(input)).toBe(true);
    expect(new RegExp(toPattern(realistic, rule), "u").test(input)).toBe(true);
  });

  test.each(rejects)("%s rejects %p", ({ row: [rule, input] }) => {
    expect(toRegExp(realistic, rule).test(input)).toBe(false);
    expect(new RegExp(toPattern(realistic, rule), "u").test(input)).toBe(false);
  });

  test("no emitted pattern has a capturing group", () => {
    for (const { name } of realistic.rules) {
      const match = new RegExp(`${toPattern(realistic, name)}|`, "v").exec("");
      expect([name, attest.definitely(match, name).length]).toEqual([name, 1]);
    }
  });
});

describe("grammars that arrive as data", () => {
  test("a JSON round trip emits the same pattern", () => {
    const parsed = JSON.parse(JSON.stringify(realistic)) as Grammar;
    expect(toPattern(parsed, "logLine")).toBe(toPattern(realistic, "logLine"));
  });

  test("an unknown rule name throws UnknownRuleError", () => {
    const error = attest.throws(AsterError.UnknownRuleError, () =>
      // @ts-expect-error `nope` is not a rule of this grammar
      toPattern(shapes, "nope"),
    );
    expect(error.name).toBe("@ghostry/aster:UnknownRuleError");
    expect(error.rule).toBe("nope");
  });

  test("an invalid rule is rejected as .define() would reject it", () => {
    const broken: Grammar = {
      rules: [
        { name: "a", body: { kind: "literal", value: "a" } },
        {
          name: "loop",
          body: {
            kind: "repeat",
            min: 0,
            body: { kind: "optional", body: { kind: "reference", name: "a" } },
          },
        },
      ],
    };
    const error = attest.throws(AsterError.NullableRepetitionError, () =>
      toPattern(broken, "loop"),
    );
    expect(error.rule).toBe("loop");
  });

  test("a duplicate name is rejected", () => {
    const duplicated: Grammar = {
      rules: [
        { name: "a", body: { kind: "literal", value: "a" } },
        { name: "a", body: { kind: "literal", value: "b" } },
        { name: "b", body: { kind: "reference", name: "a" } },
      ],
    };
    attest.throws(AsterError.DuplicateRuleError, () =>
      toPattern(duplicated, "b"),
    );
  });

  test("rules after the one asked for are not read", () => {
    const later: Grammar = {
      rules: [
        { name: "a", body: { kind: "literal", value: "a" } },
        { name: "bad", body: { kind: "range", from: "z", to: "a" } },
      ],
    };
    expect(toPattern(later, "a")).toBe("^a$");
  });
});

/**
 * Lowering uses the same explicit-stack fold as the checks, so a body nested
 * far past any call stack still emits. The pattern is not compiled here: a
 * regex engine's own parser is not this library's to bound.
 */
test("a body nested a hundred thousand levels deep emits", () => {
  const DEPTH = 100_000;
  let body: Expr = literal("ab");
  for (let level = 0; level < DEPTH; level += 1) body = optional(body);
  const composed = grammar()
    .define("deep", () => body)
    .compose();

  const pattern = toPattern(composed, "deep", { anchored: false });
  expect(pattern.startsWith("(?:".repeat(DEPTH))).toBe(true);
  expect(pattern.endsWith(")?".repeat(DEPTH))).toBe(true);
});
