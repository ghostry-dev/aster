import { join } from "node:path";
import { attest, expect, test } from "./index.ts";

const ROOT = join(import.meta.dir, "..");

/**
 * About twice what `test/stress/Realistic.ts` measured when the budget was set
 * (23,356 on TypeScript 5.9), so ordinary growth passes and a regression in how
 * `.define()` accumulates, or in how AST types are inferred, fails. Raise it
 * deliberately, with the new measurement, never to make a red run go green.
 */
const BUDGET = 50_000;

/**
 * Checked under TypeScript 5, not 7: most consumers are on 5.x, and its
 * 5,000,000-instantiation limit is the one a grammar can actually hit.
 */
test("the realistic stress grammar stays inside its instantiation budget", () => {
  const result = Bun.spawnSync(
    [
      "bun",
      "--bun",
      join(ROOT, "node_modules/typescript-5/lib/tsc.js"),
      "-p",
      join(ROOT, "tsconfig.stress.json"),
      "--extendedDiagnostics",
    ],
    { cwd: ROOT },
  );
  const output = result.stdout.toString() + result.stderr.toString();

  expect(
    output.split("\n").filter((line) => line.includes("error TS")),
  ).toEqual([]);

  const match = attest.definitely(
    output.match(/^Instantiations:\s+(\d+)/m),
    "Instantiations line",
  );
  const instantiations = Number(match[1]);
  expect(instantiations).toBeGreaterThan(0);
  expect(instantiations).toBeLessThan(BUDGET);
});
