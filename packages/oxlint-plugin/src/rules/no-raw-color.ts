import { defineRule, type ESTree } from "@oxlint/plugins";
import { baseUtility } from "../base-utility.ts";

const PALETTE_CLASS = /^(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|fill|stroke|from|to|via|outline|divide|decoration|placeholder|caret|accent|shadow)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|sage|clay)-\d{2,3}|white|black)(?:\/.*)?$/;
const HEX_VALUE = /^\s*#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})\s*$/i;
const HEX_IN_CSS = /(?:-\[|\b[\w-]+\([^)]*)#[\da-f]{3,8}\b/i;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i;
const NAMED_ARBITRARY_COLOR = /^(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide|decoration|placeholder|caret|accent)-\[(?:black|white|red|orange|yellow|green|blue|purple|pink|gray|grey)\](?:\/.*)?$/;

function hasRawColor(text: string): boolean {
  return HEX_VALUE.test(text)
    || HEX_IN_CSS.test(text)
    || COLOR_FUNCTION.test(text)
    || text.split(/\s+/).some((token) => {
      const utility = baseUtility(token);
      return PALETTE_CLASS.test(utility) || NAMED_ARBITRARY_COLOR.test(utility);
    });
}

/** Keeps UI paint on semantic roles while leaving prose issue references alone. */
export const noRawColor = defineRule({
  meta: {
    type: "suggestion",
    messages: { rawColor: "Use a semantic colour role instead of a raw palette, hex or CSS colour value." },
  },
  create(context) {
    const check = (node: ESTree.Node, text: string) => {
      if (hasRawColor(text)) context.report({ node, messageId: "rawColor" });
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
