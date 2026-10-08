import { defineRule, type ESTree } from "@oxlint/plugins";
import { baseUtility } from "./base-utility.ts";

function isRawShadow(token: string): boolean {
  const utility = baseUtility(token);
  return /^(?:shadow|drop-shadow)(?:-|$)/.test(utility)
    && !/^shadow-(?:popover|floating|dialog|none)$/.test(utility)
    && !utility.startsWith("shadow-[inset_");
}

/** Reserves elevation for the shared recipes; inset marks are not elevation. */
export const noRawShadow = defineRule({
  meta: {
    type: "suggestion",
    messages: { rawShadow: "Remove in-flow elevation or use shadow-popover, shadow-floating or shadow-dialog." },
  },
  create(context) {
    const check = (node: ESTree.Node, text: string) => {
      if (text.split(/\s+/).some(isRawShadow)) context.report({ node, messageId: "rawShadow" });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
});
