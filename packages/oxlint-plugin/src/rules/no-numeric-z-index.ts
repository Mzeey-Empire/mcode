import { defineRule, type ESTree } from "@oxlint/plugins";
import { baseUtility } from "../base-utility.ts";

function isZIndexProperty(computed: boolean, key: ESTree.PropertyKey): boolean {
  if (computed) return false;
  return key.type === "Identifier"
    ? key.name === "zIndex"
    : key.type === "Literal" && key.value === "zIndex";
}

/** Require layer tokens instead of numeric z-index utilities and style literals. */
export const noNumericZIndex = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      layerClass: "Replace `{{token}}` with a z-(--layer-*) token.",
      layerStyle: "Replace numeric zIndex with var(--layer-*); use z-(--layer-*) tokens in classes.",
    },
  },
  create(context) {
    const reportClass = (node: ESTree.Node, text: string) => {
      for (const token of text.split(/\s+/)) {
        if (/^z-(?:\d+|\[\d+\])$/.test(baseUtility(token))) {
          context.report({ node, messageId: "layerClass", data: { token } });
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
      Property(node) {
        if (!isZIndexProperty(node.computed, node.key) || node.value.type !== "Literal") return;
        const value = node.value.value;
        if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
          context.report({ node: node.value, messageId: "layerStyle" });
        }
      },
    };
  },
});
