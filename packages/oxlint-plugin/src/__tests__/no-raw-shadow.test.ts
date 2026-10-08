import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noRawShadow } from "../rules/no-raw-shadow.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });

ruleTester.run("no-raw-shadow", noRawShadow, {
  valid: [
    'const x = "shadow-popover shadow-floating shadow-dialog shadow-none";',
    'const x = "hover:shadow-popover dark:shadow-dialog data-[x]:shadow-none";',
    'const x = "shadow-[inset_2px_0_0_var(--diff-add-gutter)]";',
    'const x = "[&:hover]:shadow-[inset_2px_0_0_var(--diff-add-gutter)]";',
    'const x = "transition-shadow box-shadow-custom";',
    '// shadow-lg\nconst x = "shadow-none";',
    'const x = `shadow-floating ${active ? "bg-panel" : "bg-hover"}`;',
  ],
  invalid: [
    ...[
      "shadow", "shadow-xs", "shadow-sm", "shadow-md", "shadow-lg", "shadow-xl", "shadow-2xl",
      "hover:shadow-lg", "dark:shadow-sm", "data-[x]:shadow-xl", "[&:hover]:!shadow-lg",
      "shadow-black/25", "shadow-[0_0_0_1px_rgba(0,0,0,0.65)]", "shadow-[-1px_0_2px_var(--ink)]",
      "drop-shadow-lg",
    ].map((value) => ({ code: `const x = ${JSON.stringify(value)};`, errors: [{ messageId: "rawShadow" }] })),
    { code: 'const x = <div className="hover:shadow-lg" />;', errors: [{ messageId: "rawShadow" }] },
    { code: 'const x = `shadow-lg ${active ? "bg-panel" : "bg-hover"}`;', errors: [{ messageId: "rawShadow" }] },
  ],
});
