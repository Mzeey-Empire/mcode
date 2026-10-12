import { defineRule, type ESTree } from "@oxlint/plugins";

const MIN_FLAGGED_DELAY_MS = 50;

function isSetTimeout(callee: ESTree.Expression): boolean {
  if (callee.type === "Identifier") return callee.name === "setTimeout";
  return (
    callee.type === "MemberExpression"
    && !callee.computed
    && callee.property.type === "Identifier"
    && callee.property.name === "setTimeout"
  );
}

function soleExpression(block: ESTree.BlockStatement): ESTree.Expression | null {
  const [statement] = block.body;
  return block.body.length === 1 && statement?.type === "ExpressionStatement" ? statement.expression : null;
}

function singleCallInBody(fn: ESTree.Argument): ESTree.CallExpression | null {
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression") return null;
  const body = fn.body;
  const expression = body?.type === "BlockStatement" ? soleExpression(body) : body;
  return expression?.type === "CallExpression" ? expression : null;
}

function resolverName(executor: ESTree.Argument): string | null {
  if (executor.type !== "ArrowFunctionExpression" && executor.type !== "FunctionExpression") return null;
  const [resolver] = executor.params;
  return resolver?.type === "Identifier" ? resolver.name : null;
}

function callsResolver(node: ESTree.Argument, resolver: string): boolean {
  if (node.type === "Identifier") return node.name === resolver;
  const call = singleCallInBody(node);
  return call?.callee.type === "Identifier" && call.callee.name === resolver && call.arguments.length === 0;
}

// A timer passed to Promise.race is an upper bound that only costs time on failure,
// so only a promise that is awaited or returned from a sleep helper counts as a sleep.
function isSleepPosition(node: ESTree.NewExpression): boolean {
  const parent = node.parent;
  return (
    parent.type === "AwaitExpression"
    || parent.type === "ReturnStatement"
    || (parent.type === "ArrowFunctionExpression" && parent.body === node)
  );
}

// Tiny literal delays only yield to the macrotask queue; real sleeps are the slow, flaky case.
function isFlaggedDelay(delay: ESTree.Argument | undefined): boolean {
  if (delay === undefined) return false;
  if (delay.type === "Literal") return typeof delay.value === "number" && delay.value >= MIN_FLAGGED_DELAY_MS;
  return true;
}

function isRealTimerSleep(node: ESTree.NewExpression): boolean {
  const [executor] = node.arguments;
  if (node.callee.type !== "Identifier" || node.callee.name !== "Promise" || executor === undefined) return false;
  if (!isSleepPosition(node)) return false;
  const call = singleCallInBody(executor);
  const resolver = resolverName(executor);
  if (call === null || resolver === null || !isSetTimeout(call.callee)) return false;
  const [callback, delay] = call.arguments;
  return callback !== undefined && callsResolver(callback, resolver) && isFlaggedDelay(delay);
}

/** Ban real-time sleeps in tests; they slow the suite and race the code under test. */
export const noRealTimerSleep = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      realTimerSleep:
        "Do not sleep on a real timer in a test. Use vi.useFakeTimers() with vi.advanceTimersByTimeAsync(), or vi.waitFor() for an observable condition.",
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (isRealTimerSleep(node)) context.report({ node, messageId: "realTimerSleep" });
      },
    };
  },
});
