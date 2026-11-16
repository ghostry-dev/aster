import { subexpressions } from "./IR";
import type { Expr } from "./Types";

/**
 * One node on the explicit walk stack, with the index of the next subexpression
 * to visit.
 */
interface Frame {
  readonly expr: Expr;
  readonly subexpressions: readonly Expr[];
  next: number;
}

/**
 * Fold one rule body bottom-up, with an explicit stack and never by recursion,
 * so nesting depth is bounded by memory rather than the call stack. Every
 * analysis of a body is one of these, which is what keeps the "loops, not
 * recursion" rule in one place.
 *
 * `enter` runs when a node is first reached, before its subexpressions are
 * read, so it can reject a malformed node before the walk descends into it.
 * `exit` runs once all of a node's subexpressions have exited, and receives
 * their results in order.
 */
export function fold<$Result>(
  root: Expr,
  enter: (expr: Expr) => void,
  exit: (expr: Expr, results: readonly $Result[]) => $Result,
): $Result {
  const open = (expr: Expr): Frame => {
    enter(expr);
    return { expr, subexpressions: subexpressions(expr), next: 0 };
  };

  const frames: Frame[] = [open(root)];
  const results: $Result[] = [];

  for (let top = frames.pop(); top !== undefined; top = frames.pop()) {
    const next = top.subexpressions[top.next];
    if (next !== undefined) {
      top.next += 1;
      frames.push(top, open(next));
      continue;
    }
    const count = top.subexpressions.length;
    const own = results.splice(results.length - count, count);
    results.push(exit(top.expr, own));
  }

  const [result] = results;
  return result as $Result;
}
