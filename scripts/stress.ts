/**
 * `bun run bench:types`: measures how the type cost of a `.define()` chain
 * grows with the number of rules, under both TypeScript 5 and TypeScript 7.
 *
 * Each synthetic grammar is written to `.stress/` (gitignored) and checked on
 * its own with `--extendedDiagnostics`. A baseline file that only imports the
 * package is subtracted, so the table shows what the grammar itself costs.
 * Requires a current `dist/`, since the files import `@ghostry/aster` by
 * self-reference like the tests do.
 *
 * Shapes:
 *
 * - `chain`: each rule wraps the previous one, so the last rule's AST is N levels
 *   deep, and the file reads all the way down it.
 * - `fan`: N-1 leaf rules and one rule sequencing all of them.
 * - `mixed`: each rule chooses among the previous rule, the rule at half its
 *   index, and a literal.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, ".stress");
const SIZES = [10, 25, 50, 100] as const;
const SHAPES = ["chain", "fan", "mixed"] as const;

type Shape = (typeof SHAPES)[number];

const COMPILERS = {
  ts5: ["bun", "--bun", join(ROOT, "node_modules/typescript-5/lib/tsc.js")],
  ts7: [join(ROOT, "node_modules/.bin/tsc")],
} as const;

type Compiler = keyof typeof COMPILERS;

interface Measurement {
  readonly instantiations: number;
  readonly types: number;
  readonly checkSeconds: number;
  readonly errors: readonly string[];
}

const HEADER = `import {
  either,
  grammar,
  literal,
  sequence,
  type AstOf,
  type RuleNames,
} from "@ghostry/aster";
void either;
void sequence;
`;

function body(shape: Shape, index: number, size: number): string {
  if (index === 0) return `() => literal("x0")`;
  const previous = `r${index - 1}`;
  switch (shape) {
    case "chain":
      return `({ ${previous} }) => sequence([${previous}, literal("x")])`;
    case "fan": {
      if (index < size - 1) return `() => literal("x${index}")`;
      const all = Array.from({ length: index }, (_, i) => `r${i}`);
      return `(rules) => sequence([${all.map((name) => `rules.${name}`).join(", ")}])`;
    }
    case "mixed": {
      const half = `r${Math.floor(index / 2)}`;
      const names = half === previous ? [previous] : [previous, half];
      return `({ ${names.join(", ")} }) => either(${names.join(", ")}, literal("x"))`;
    }
  }
}

function source(shape: Shape, size: number): string {
  const lines = [HEADER, "export const g = grammar()"];
  for (let index = 0; index < size; index += 1) {
    lines.push(`  .define("r${index}", ${body(shape, index, size)})`);
  }
  lines.push("  .compose();", "type G = typeof g;");
  lines.push(
    'type Every = { [K in RuleNames<G>]: AstOf<G, K>["children"] };',
    "export type AllChildren = Every[RuleNames<G>];",
  );
  if (shape === "chain") {
    lines.push(
      `export type Deepest = AstOf<G, "r${size - 1}">${'["children"][0]'.repeat(size - 1)};`,
    );
  }
  return lines.join("\n") + "\n";
}

function measure(compiler: Compiler, file: string): Measurement {
  const config = join(OUT, `${file}.tsconfig.json`);
  writeFileSync(
    config,
    JSON.stringify({ extends: "../tsconfig.json", include: [`./${file}.ts`] }),
  );
  const result = Bun.spawnSync(
    [...COMPILERS[compiler], "-p", config, "--extendedDiagnostics"],
    { cwd: ROOT },
  );
  const output = result.stdout.toString() + result.stderr.toString();
  const read = (label: string): number => {
    const match = output.match(new RegExp(`^${label}:\\s+([\\d.]+)`, "m"));
    if (match?.[1] === undefined) {
      throw new Error(
        `no "${label}" in ${compiler} output for ${file}:\n${output}`,
      );
    }
    return Number(match[1]);
  };
  return {
    instantiations: read("Instantiations"),
    types: read("Types"),
    checkSeconds: read("Check time"),
    errors: output.split("\n").filter((line) => line.includes("error TS")),
  };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, "baseline.ts"),
  HEADER
    + "void grammar;\nvoid literal;\nexport type _ = [AstOf<never, never>, RuleNames<never>];\n",
);

const baseline = {
  ts5: measure("ts5", "baseline"),
  ts7: measure("ts7", "baseline"),
};

const rows: string[][] = [];
let failed = false;

for (const shape of SHAPES) {
  for (const size of SIZES) {
    const file = `${shape}-${size}`;
    writeFileSync(join(OUT, `${file}.ts`), source(shape, size));
    const row = [shape, String(size)];
    for (const compiler of ["ts5", "ts7"] as const) {
      const result = measure(compiler, file);
      const net = result.instantiations - baseline[compiler].instantiations;
      row.push(
        String(net),
        String(Math.round(net / size)),
        result.checkSeconds.toFixed(2),
      );
      if (result.errors.length > 0) {
        failed = true;
        console.error(`${compiler} ${file}:\n  ${result.errors.join("\n  ")}`);
      }
    }
    rows.push(row);
  }
}

const header = [
  "shape",
  "rules",
  "ts5 inst",
  "ts5 /rule",
  "ts5 check s",
  "ts7 inst",
  "ts7 /rule",
  "ts7 check s",
];
const widths = header.map((title, column) =>
  Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
);
const format = (row: readonly string[]): string =>
  `| ${row.map((cell, column) => cell.padStart(widths[column] ?? 0)).join(" | ")} |`;

console.log(
  `baseline instantiations (subtracted): ts5 ${baseline.ts5.instantiations}, ts7 ${baseline.ts7.instantiations}\n`,
);
console.log(format(header));
console.log(`| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`);
for (const row of rows) console.log(format(row));

if (failed) process.exit(1);
