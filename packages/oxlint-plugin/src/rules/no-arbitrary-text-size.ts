import { defineRule, type ESTree } from "@oxlint/plugins";
import { baseUtility } from "../base-utility.ts";

/** Require named typography roles instead of arbitrary numeric font sizes. */
export const noArbitraryTextSize = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      textSize: "Replace `{{token}}` with a type role: caption, body-small, label, body, or code.",
    },
  },
  create(context) {
    const reportClass = (node: ESTree.Node, text: string) => {
      for (const token of text.split(/\s+/)) {
        if (/^text-\[(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)\]$/.test(baseUtility(token))) {
          context.report({ node, messageId: "textSize", data: { token } });
        }
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") reportClass(node, node.value);
      },
      TemplateElement(node) {
        reportClass(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
});
