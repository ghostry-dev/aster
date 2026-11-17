import {
  either,
  grammar,
  literal,
  oneOrMore,
  optional,
  range,
  sequence,
  zeroOrMore,
  type AstOf,
  type RuleNames,
} from "@ghostry/aster";

/**
 * The type-budget stress grammar: about fifty rules spanning RFC 3339
 * timestamps, semver, IPv4, a URI subset and a log line that composes all of
 * them. It mixes deep reference chains (`logLine` → `timestamp` → `fullTime` →
 * `partialTime` → `hour` → `digit`) with wide sequences and alternations, which
 * is what a real grammar looks like. `TypeBudget.test.ts` checks this file in
 * isolation and caps its instantiation count.
 */
export const realistic = grammar()
  /** Characters. */
  .define("digit", () => range("0", "9"))
  .define("nonZero", () => range("1", "9"))
  .define("lower", () => range("a", "z"))
  .define("upper", () => range("A", "Z"))
  .define("alpha", ({ lower, upper }) => either(lower, upper))
  .define("hexDigit", ({ digit }) =>
    either(digit, range("a", "f"), range("A", "F")),
  )
  .define("dot", () => literal("."))
  .define("dash", () => literal("-"))
  .define("plus", () => literal("+"))
  .define("colon", () => literal(":"))
  .define("slash", () => literal("/"))
  .define("space", () => literal(" "))
  .define("underscore", () => literal("_"))
  /** RFC 3339. */
  .define("year", ({ digit }) => sequence([digit, digit, digit, digit]))
  .define("month", ({ digit }) => sequence([digit, digit]))
  .define("day", ({ digit }) => sequence([digit, digit]))
  .define("hour", ({ digit }) => sequence([digit, digit]))
  .define("minute", ({ digit }) => sequence([digit, digit]))
  .define("second", ({ digit }) => sequence([digit, digit]))
  .define("fraction", ({ dot, digit }) => sequence([dot, oneOrMore(digit)]))
  .define("fullDate", ({ year, dash, month, day }) =>
    sequence([year, dash, month, dash, day]),
  )
  .define("partialTime", ({ hour, colon, minute, second, fraction }) =>
    sequence([hour, colon, minute, colon, second, optional(fraction)]),
  )
  .define("numOffset", ({ plus, dash, hour, colon, minute }) =>
    sequence([either(plus, dash), hour, colon, minute]),
  )
  .define("offset", ({ numOffset }) => either(literal("Z"), numOffset))
  .define("fullTime", ({ partialTime, offset }) =>
    sequence([partialTime, offset]),
  )
  .define("timestamp", ({ fullDate, fullTime }) =>
    sequence([fullDate, literal("T"), fullTime]),
  )
  /** Semver. */
  .define("numericId", ({ nonZero, digit }) =>
    either(literal("0"), sequence([nonZero, zeroOrMore(digit)])),
  )
  .define("alnumId", ({ alpha, digit, dash }) =>
    oneOrMore(either(alpha, digit, dash)),
  )
  /**
   * At least one non-digit, so no identifier is both numeric and alphanumeric.
   * Overlapping alternatives inside the `(?:\.id)*` loop would let a
   * backtracking engine split `.1.1.1…` exponentially many ways.
   */
  .define("alphanumericId", ({ digit, alpha, dash }) =>
    sequence([
      zeroOrMore(digit),
      either(alpha, dash),
      zeroOrMore(either(alpha, digit, dash)),
    ]),
  )
  .define("preId", ({ numericId, alphanumericId }) =>
    either(numericId, alphanumericId),
  )
  .define("prerelease", ({ dash, preId, dot }) =>
    sequence([dash, preId, zeroOrMore(sequence([dot, preId]))]),
  )
  .define("build", ({ plus, alnumId, dot }) =>
    sequence([plus, alnumId, zeroOrMore(sequence([dot, alnumId]))]),
  )
  .define("core", ({ numericId, dot }) =>
    sequence([numericId, dot, numericId, dot, numericId]),
  )
  .define("semver", ({ core, prerelease, build }) =>
    sequence([core, optional(prerelease), optional(build)]),
  )
  /** IPv4. */
  .define("decOctet", ({ digit, nonZero }) =>
    either(
      sequence([literal("25"), range("0", "5")]),
      sequence([literal("2"), range("0", "4"), digit]),
      sequence([literal("1"), digit, digit]),
      sequence([nonZero, digit]),
      digit,
    ),
  )
  .define("ipv4", ({ decOctet, dot }) =>
    sequence([decOctet, dot, decOctet, dot, decOctet, dot, decOctet]),
  )
  /** A URI subset: scheme, authority, path, query, fragment. */
  .define("scheme", ({ alpha, digit, plus, dash, dot }) =>
    sequence([alpha, zeroOrMore(either(alpha, digit, plus, dash, dot))]),
  )
  .define("unreserved", ({ alpha, digit, dash, dot, underscore }) =>
    either(alpha, digit, dash, dot, underscore, literal("~")),
  )
  .define("pctEncoded", ({ hexDigit }) =>
    sequence([literal("%"), hexDigit, hexDigit]),
  )
  .define("subDelim", () =>
    either(
      literal("!"),
      literal("$"),
      literal("&"),
      literal("'"),
      literal("("),
      literal(")"),
      literal("*"),
      literal("+"),
      literal(","),
      literal(";"),
      literal("="),
    ),
  )
  .define("pchar", ({ unreserved, pctEncoded, subDelim, colon }) =>
    either(unreserved, pctEncoded, subDelim, colon, literal("@")),
  )
  .define("regName", ({ unreserved, pctEncoded, subDelim }) =>
    zeroOrMore(either(unreserved, pctEncoded, subDelim)),
  )
  .define("host", ({ ipv4, regName }) => either(ipv4, regName))
  .define("port", ({ digit }) => zeroOrMore(digit))
  .define("authority", ({ host, colon, port }) =>
    sequence([host, optional(sequence([colon, port]))]),
  )
  .define("segment", ({ pchar }) => zeroOrMore(pchar))
  .define("path", ({ slash, segment }) =>
    zeroOrMore(sequence([slash, segment])),
  )
  .define("query", ({ pchar, slash }) =>
    zeroOrMore(either(pchar, slash, literal("?"))),
  )
  .define("fragment", ({ pchar, slash }) =>
    zeroOrMore(either(pchar, slash, literal("?"))),
  )
  .define("uri", ({ scheme, colon, authority, path, query, fragment }) =>
    sequence([
      scheme,
      colon,
      literal("//"),
      authority,
      path,
      optional(sequence([literal("?"), query])),
      optional(sequence([literal("#"), fragment])),
    ]),
  )
  /** A structured log line composed from everything above. */
  .define("level", () =>
    either(
      literal("DEBUG"),
      literal("INFO"),
      literal("WARN"),
      literal("ERROR"),
    ),
  )
  .define("word", ({ alpha, digit, underscore }) =>
    oneOrMore(either(alpha, digit, underscore)),
  )
  .define("field", ({ word }) => sequence([word, literal("="), word]))
  .define("fields", ({ space, field }) => zeroOrMore(sequence([space, field])))
  /**
   * Words separated by single spaces. `(?:word| )*` would be `(?:\w+| )*`,
   * which a backtracking engine splits exponentially many ways.
   */
  .define("message", ({ word, space }) =>
    optional(sequence([word, zeroOrMore(sequence([space, word]))])),
  )
  .define(
    "logLine",
    ({ timestamp, space, level, ipv4, uri, semver, fields, message }) =>
      sequence([
        timestamp,
        space,
        level,
        space,
        ipv4,
        space,
        uri,
        space,
        semver,
        fields,
        literal(" -- "),
        message,
      ]),
  )
  .compose();

type Realistic = typeof realistic;

/**
 * Forces AST inference for every rule. Indexing the mapped type by the union of
 * all names resolves each property, so the budget measures what a consumer who
 * uses every rule's AST would pay.
 */
type Every = { [K in RuleNames<Realistic>]: AstOf<Realistic, K>["children"] };
export type AllChildren = Every[RuleNames<Realistic>];

/**
 * What a consumer actually writes: reading deep into one node. Each access
 * makes the checker resolve the children at that level.
 */
export function deepRead(line: AstOf<Realistic, "logLine">): string {
  const [timestamp, , level, , ipv4, , uri, , semver] = line.children;
  const hour = timestamp.children[2].children[0].children[0].children[0];
  const octet = ipv4.children[0].children;
  const host = uri.children[3].children[0].children;
  const prerelease = semver.children[1]?.children[1].children;
  return [
    hour.text,
    level.children.alternative,
    octet.alternative,
    host.alternative,
    prerelease?.alternative,
  ].join();
}
