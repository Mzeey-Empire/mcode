import { defineRule, type ESTree } from "@oxlint/plugins";

const ELLIPSIS = "…";

/** Drops variant prefixes (`md:`, `group-hover/ws:`, `*:data-[x=y]:`) and the leading or trailing `!` modifier, keeping brackets intact. */
function baseUtility(token: string): string {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === ":" && depth === 0) start = index + 1;
  }
  return token.slice(start).replace(/^!|!$/g, "");
}

function isEllipsisUtility(utility: string): boolean {
  return (
    utility === "truncate"
    || utility === "text-ellipsis"
    || utility.startsWith("line-clamp-")
    || utility.startsWith("[text-overflow:")
  );
}

function findEllipsisClass(text: string): string | undefined {
  return text.split(/\s+/).find((token) => token !== "" && isEllipsisUtility(baseUtility(token)));
}

function endsWithEllipsis(node: ESTree.Expression | ESTree.PrivateIdentifier): boolean {
  return node.type === "Literal" && typeof node.value === "string" && node.value.endsWith(ELLIPSIS);
}

/** Ban ellipsis truncation: text fades with `text-fade` instead of ending in "…". */
export const noEllipsisTruncation = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      ellipsisClass:
        "Replace `{{token}}` with text-fade, or text-fade-lines-N for a vertical clamp. Overflowing text fades its last 24px instead of ending in an ellipsis.",
      ellipsisConcat:
        "Do not append \"…\" to cut text. Render the full value in a text-fade element so it fades only when it overflows.",
    },
  },
  create(context) {
    const reportClass = (node: ESTree.Node, text: string) => {
      const token = findEllipsisClass(text);
      if (token) context.report({ node, messageId: "ellipsisClass", data: { token } });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") reportClass(node, node.value);
      },
      TemplateElement(node) {
        reportClass(node, node.value.cooked ?? node.value.raw);
      },
      BinaryExpression(node) {
        if (node.operator === "+" && endsWithEllipsis(node.right)) {
          context.report({ node, messageId: "ellipsisConcat" });
        }
      },
    };
  },
});
