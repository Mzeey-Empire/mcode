import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noRowOverlayRoot } from "../rules/no-row-overlay-root.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
});

const filename = "apps/web/src/features/projects/sidebar/SidebarThreadRow.tsx";
const baselineOne = [{ baseline: { "apps/web/src/features/projects/sidebar/SidebarThreadRow.tsx": 1 } }];

ruleTester.run("no-row-overlay-root", noRowOverlayRoot, {
  valid: [
    {
      name: "a row trigger that points at the list's shared tooltip",
      filename,
      code: "const row = <TooltipTrigger handle={previewHandle} payload={thread} render={<div />} />;",
    },
    {
      name: "a shared Tooltip root with a handle",
      filename,
      code: "const list = <Tooltip handle={previewHandle}>{() => null}</Tooltip>;",
    },
    {
      name: "a primitive Tooltip.Root with a handle",
      filename,
      code: "const list = <TooltipPrimitive.Root handle={previewHandle} />;",
    },
    {
      name: "existing roots up to the file's baseline",
      filename,
      options: baselineOne,
      code: "const row = <Tooltip><TooltipTrigger /><TooltipContent /></Tooltip>;",
    },
    {
      name: "a non-overlay Root member",
      filename,
      code: "const row = <Collapsible.Root />;",
    },
  ],
  invalid: [
    {
      name: "a per-row Tooltip in a file with no baseline",
      filename,
      code: "const row = <Tooltip><TooltipTrigger /><TooltipContent /></Tooltip>;",
      errors: [{ messageId: "rowOverlayRoot" }],
    },
    {
      name: "one root more than the baseline reports every root",
      filename,
      options: baselineOne,
      code: "const row = <><Tooltip><TooltipTrigger /></Tooltip><Tooltip><TooltipTrigger /></Tooltip></>;",
      errors: [{ messageId: "rowOverlayRoot" }, { messageId: "rowOverlayRoot" }],
    },
    {
      name: "a baseline for another file allows nothing here",
      filename: "apps/web/src/features/projects/ProjectRow.tsx",
      options: baselineOne,
      code: "const row = <Tooltip><TooltipTrigger /></Tooltip>;",
      errors: [{ messageId: "rowOverlayRoot" }],
    },
    {
      name: "a PreviewCard root, even with a handle",
      filename,
      code: "const row = <PreviewCard handle={handle} />;",
      errors: [{ messageId: "rowOverlayRoot" }],
    },
    {
      name: "a HoverCard root",
      filename,
      code: "const row = <HoverCard />;",
      errors: [{ messageId: "rowOverlayRoot" }],
    },
    {
      name: "primitive Root forms",
      filename,
      code: "const row = <><TooltipPrimitive.Root /><PreviewCardPrimitive.Root /></>;",
      errors: [{ messageId: "rowOverlayRoot" }, { messageId: "rowOverlayRoot" }],
    },
  ],
});
