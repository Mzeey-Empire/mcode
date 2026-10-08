import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noEllipsisTruncation } from "../rules/no-ellipsis-truncation.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
});

ruleTester.run("no-ellipsis-truncation", noEllipsisTruncation, {
  valid: [
    {
      name: "the fade utilities",
      code: 'const element = <span className="min-w-0 text-fade text-xs" />; const clamp = "text-fade-lines-2";',
    },
    {
      name: "a provider error union member that contains overflow",
      code: 'type Reason = "quota" | "context-overflow"; const reason: Reason = "context-overflow";',
    },
    {
      name: "identifiers and prose that mention truncation",
      code: 'function truncatePath(path: string) { return path; } const note = "middle-truncate long refs"; const flag = "truncated";',
    },
    {
      name: "class tokens that only contain a banned word",
      code: 'const element = <div className="truncate-none my-line-clamp-2 text-ellipsis-wide" />;',
    },
    {
      name: "a placeholder that ends in an ellipsis without concatenation",
      code: 'const placeholder = "Search…"; const label = `Search ${scope}…`;',
    },
    {
      name: "concatenation that ends in a different string",
      code: 'const label = name + " (copy)";',
    },
  ],
  invalid: [
    {
      name: "truncate in a className",
      code: 'const element = <span className="min-w-0 truncate text-xs" />;',
      errors: [
        {
          message:
            "Replace `truncate` with text-fade, or text-fade-lines-N for a vertical clamp. Overflowing text fades its last 24px instead of ending in an ellipsis.",
        },
      ],
    },
    {
      name: "text-ellipsis in a cn call",
      code: 'const className = cn("overflow-hidden text-ellipsis", active && "font-medium");',
      errors: [{ messageId: "ellipsisClass", data: { token: "text-ellipsis" } }],
    },
    {
      name: "line-clamp with a variant prefix",
      code: 'const className = "md:line-clamp-3 text-sm";',
      errors: [{ messageId: "ellipsisClass", data: { token: "md:line-clamp-3" } }],
    },
    {
      name: "truncate behind an arbitrary variant and the important modifier",
      code: 'const className = "*:data-[slot=select-value]:!truncate";',
      errors: [{ messageId: "ellipsisClass", data: { token: "*:data-[slot=select-value]:!truncate" } }],
    },
    {
      name: "the trailing important modifier",
      code: 'const className = "md:text-ellipsis! truncate!";',
      errors: [
        { messageId: "ellipsisClass", data: { token: "md:text-ellipsis!" } },
      ],
    },
    {
      name: "an arbitrary text-overflow property",
      code: 'const className = "[text-overflow:ellipsis] overflow-hidden";',
      errors: [{ messageId: "ellipsisClass", data: { token: "[text-overflow:ellipsis]" } }],
    },
    {
      name: "truncate in a template literal",
      code: "const className = `flex ${tone} truncate`;",
      errors: [{ messageId: "ellipsisClass", data: { token: "truncate" } }],
    },
    {
      name: "a line clamp built from a template expression",
      code: "const className = `line-clamp-${lines}`;",
      errors: [{ messageId: "ellipsisClass", data: { token: "line-clamp-" } }],
    },
    {
      name: "string concatenation ending in an ellipsis",
      code: 'const label = text.slice(0, 40) + "…";',
      errors: [{ messageId: "ellipsisConcat" }],
    },
  ],
});
