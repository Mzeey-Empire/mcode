import { defineRule, type ESTree } from "@oxlint/plugins";

type Options = { baseline?: Record<string, number> };

const ROOT_NAMES = new Set(["Tooltip", "PreviewCard", "HoverCard"]);
const PRIMITIVE_NAMESPACES = new Set([
  "Tooltip",
  "TooltipPrimitive",
  "PreviewCard",
  "PreviewCardPrimitive",
  "HoverCard",
  "HoverCardPrimitive",
]);

function overlayRootName(name: ESTree.JSXElementName): string | null {
  if (name.type === "JSXIdentifier") {
    return ROOT_NAMES.has(name.name) ? name.name : null;
  }
  if (
    name.type === "JSXMemberExpression"
    && name.object.type === "JSXIdentifier"
    && PRIMITIVE_NAMESPACES.has(name.object.name)
    && name.property.name === "Root"
  ) {
    return `${name.object.name}.Root`;
  }
  return null;
}

function hasHandle(node: ESTree.JSXOpeningElement): boolean {
  return node.attributes.some(
    (attribute) => attribute.type === "JSXAttribute" && attribute.name.type === "JSXIdentifier" && attribute.name.name === "handle",
  );
}

function isSharedTooltipRoot(rootName: string, node: ESTree.JSXOpeningElement): boolean {
  return rootName.startsWith("Tooltip") && hasHandle(node);
}

function allowedCount(filename: string, baseline: Record<string, number>): number {
  const normalized = filename.replaceAll("\\", "/");
  for (const [path, count] of Object.entries(baseline)) {
    if (normalized === path || normalized.endsWith(`/${path}`)) return count;
  }
  return 0;
}

/**
 * Reports hover-opened overlay roots in list row components. A root per row makes every
 * hover build and position its own popup before the row can paint, so a list mounts one
 * shared root and rows point at it. Existing files are ratcheted by a per-file baseline.
 */
export const noRowOverlayRoot = defineRule({
  meta: {
    type: "problem",
    schema: [{
      type: "object",
      properties: {
        baseline: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
      },
      additionalProperties: false,
    }],
    messages: {
      rowOverlayRoot:
        "{{name}} in a list row mounts one overlay per row ({{count}} in this file, baseline {{allowed}}). Mount one <Tooltip handle={...}> in the list, create the handle with createTooltipHandle from @/components/ui/tooltip, and render <TooltipTrigger handle={...} payload={...}> in the row. See the sidebar's shared thread preview (SidebarThreadPreview.tsx).",
    },
  },
  create(context) {
    const options = context.options[0] as Options | undefined;
    const allowed = allowedCount(context.filename, options?.baseline ?? {});
    const found: { node: ESTree.JSXOpeningElement; name: string }[] = [];
    return {
      JSXOpeningElement(node) {
        const name = overlayRootName(node.name);
        if (name && !isSharedTooltipRoot(name, node)) found.push({ node, name });
      },
      "Program:exit"() {
        if (found.length <= allowed) return;
        for (const { node, name } of found) {
          context.report({
            node,
            messageId: "rowOverlayRoot",
            data: { name, count: String(found.length), allowed: String(allowed) },
          });
        }
      },
    };
  },
});
