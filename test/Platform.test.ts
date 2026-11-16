import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { attest, expect, test } from ".";

const DIST = new URL("../dist/esm/", import.meta.url).pathname;

/**
 * Every `.js` file under `root`, walked with an explicit stack like every other
 * traversal in this repository.
 */
function walk(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) pending.push(full);
      else if (full.endsWith(".js")) files.push(full);
    }
  }
  return files;
}

/**
 * Every module specifier in the emitted output that is neither relative nor a
 * `#` subpath import — i.e. everything the package expects the host to
 * provide.
 *
 * Anchored to statements: `import … from "x"`, `export … from "x"`, `import
 * "x"`, and `import("x")`. A bare `from "x"` match is not enough, because
 * compiled code can put a variable named `from` right before a string literal.
 */
const SPECIFIER =
  /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

function externalImports(source: string): string[] {
  return [...source.matchAll(SPECIFIER)]
    .map((match) =>
      attest.definitely(match[1] ?? match[2] ?? match[3], "import specifier"),
    )
    .filter(
      (specifier) => !specifier.startsWith(".") && !specifier.startsWith("#"),
    );
}

/**
 * The package has zero runtime dependencies and needs nothing from the host.
 * Asserted against built output rather than source because that is what ships.
 */
test("the build imports nothing the host has to provide", () => {
  const files = walk(DIST);
  expect(files.length).toBeGreaterThan(0);

  const offenders = files
    .map(
      (file) =>
        [
          file.slice(DIST.length),
          externalImports(readFileSync(file, "utf8")),
        ] as const,
    )
    .filter(([, imports]) => imports.length > 0);

  expect(Object.fromEntries(offenders)).toEqual({});
});
