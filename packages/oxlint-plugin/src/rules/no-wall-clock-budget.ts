import { defineRule, type ESTree } from "@oxlint/plugins";

const CLOCKS = new Set(["performance", "Date"]);
const UPPER_BOUND_MATCHERS = new Set(["toBeLessThan", "toBeLessThanOrEqual"]);

function isWallClockRead(node: ESTree.Expression | ESTree.PrivateIdentifier): boolean {
  if (node.type !== "CallExpression" || node.arguments.length !== 0) return false;
  const callee = node.callee;
  return (
    callee.type === "MemberExpression"
    && !callee.computed
    && callee.object.type === "Identifier"
    && CLOCKS.has(callee.object.name)
    && callee.property.type === "Identifier"
    && callee.property.name === "now"
  );
}

function isElapsed(node: ESTree.Expression): boolean {
  return node.type === "BinaryExpression" && node.operator === "-" && isWallClockRead(node.left);
}

function upperBoundSubject(node: ESTree.CallExpression): ESTree.Expression | null {
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return null;
  if (callee.property.type !== "Identifier" || !UPPER_BOUND_MATCHERS.has(callee.property.name)) return null;
  const expectCall = callee.object;
  if (expectCall.type !== "CallExpression" || expectCall.callee.type !== "Identifier") return null;
  const [subject] = expectCall.arguments;
  if (expectCall.callee.name !== "expect" || subject === undefined || subject.type === "SpreadElement") return null;
  return subject;
}

/** Ban upper bounds on elapsed wall-clock time in tests; a loaded CI runner fails them at random. */
export const noWallClockBudget = defineRule({
  meta: {
    type: "problem",
    messages: {
      wallClockBudget:
        "Do not assert an upper bound on elapsed wall-clock time in a test. A loaded CI runner fails it at random. Count the work instead (reads, calls, or collection sizes). In apps/web, a budget may live in a *.perf.test.ts file, which runs only under MCODE_PERF_GATE=1.",
    },
  },
  create(context) {
    const elapsedNames = new Set<string>();
    return {
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init && isElapsed(node.init)) elapsedNames.add(node.id.name);
      },
      CallExpression(node) {
        const subject = upperBoundSubject(node);
        if (subject === null) return;
        const flagged = subject.type === "Identifier" ? elapsedNames.has(subject.name) : isElapsed(subject);
        if (flagged) context.report({ node, messageId: "wallClockBudget" });
      },
    };
  },
});
