import { defineRule, type ESTree } from "@oxlint/plugins";

const USER_ACTIONS: ReadonlySet<string> = new Set([
  "click",
  "dblClick",
  "tripleClick",
  "hover",
  "unhover",
  "keyboard",
  "type",
  "clear",
  "tab",
  "pointer",
  "paste",
  "selectOptions",
  "deselectOptions",
]);

// Roles of floating surfaces. Base UI mounts these after the interaction that opens them,
// sometimes a tick after the awaited user event returns.
const POPUP_ROLES: ReadonlySet<string> = new Set([
  "menu",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "dialog",
  "alertdialog",
  "listbox",
  "tooltip",
]);

const SYNC_QUERIES: ReadonlySet<string> = new Set(["getByRole", "getAllByRole"]);

function calleeName(callee: ESTree.Expression): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return null;
}

function isAwaited(node: ESTree.CallExpression): boolean {
  return node.parent.type === "AwaitExpression";
}

function isUserAction(node: ESTree.CallExpression): boolean {
  return node.callee.type === "MemberExpression" && USER_ACTIONS.has(calleeName(node.callee) ?? "");
}

function isSettlingWait(name: string): boolean {
  return name === "waitFor" || name.startsWith("findBy") || name.startsWith("findAllBy");
}

function popupRole(node: ESTree.CallExpression): string | null {
  const [role] = node.arguments;
  if (role?.type !== "Literal" || typeof role.value !== "string") return null;
  return POPUP_ROLES.has(role.value) ? role.value : null;
}

/**
 * Flag a synchronous popup query made after an awaited user action with no awaited
 * `findBy*` or `waitFor` between them. The popup may not be mounted yet, so the test
 * passes or fails on timing.
 */
export const noSyncPopupQuery = defineRule({
  meta: {
    type: "problem",
    messages: {
      syncPopupQuery:
        "The {{role}} may not be mounted yet after the user action above. Use `await findByRole(\"{{role}}\", ...)` or wrap the query in `await waitFor(...)`.",
    },
  },
  create(context) {
    // One flag per function body: a query inside a waitFor callback runs in its own scope.
    const unsettled: boolean[] = [false];
    const enter = () => {
      unsettled.push(false);
    };
    const exit = () => {
      unsettled.pop();
    };
    return {
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      // Exit order is evaluation order, so a query passed as an action's argument runs first.
      "CallExpression:exit"(node: ESTree.CallExpression) {
        const name = calleeName(node.callee);
        if (name === null) return;
        const top = unsettled.length - 1;
        if (isAwaited(node) && isUserAction(node)) {
          unsettled[top] = true;
          return;
        }
        if (isAwaited(node) && isSettlingWait(name)) {
          unsettled[top] = false;
          return;
        }
        const role = SYNC_QUERIES.has(name) ? popupRole(node) : null;
        if (role !== null && unsettled[top]) {
          context.report({ node, messageId: "syncPopupQuery", data: { role } });
        }
      },
    };
  },
});
