import { literal, optional, sequence } from "@ghostry/aster";
import type { Expr } from "@ghostry/aster/unstable-ir";

/**
 * A body nested `depth` levels deep, far past any call stack at 10⁵:
 * `sequence([optional(literal("x")), inner])` at every level, around
 * `literal("ab")`. It accepts `xᵏab` for `k ≤ depth`.
 *
 * A skipped level consumes nothing, so the short input `ab` crosses every
 * level. That keeps these tests about nesting depth: the parser is O(n × m) in
 * input length and program size, and a shape whose input had to grow with its
 * depth would cost depth² steps.
 */
export function deep(depth: number): Expr {
  let body: Expr = literal("ab");
  for (let level = 0; level < depth; level += 1)
    body = sequence([optional(literal("x")), body]);
  return body;
}
