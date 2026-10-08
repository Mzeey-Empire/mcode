import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noRawColor } from "../rules/no-raw-color.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });

ruleTester.run("no-raw-color", noRawColor, {
  valid: [
    'const x = "bg-panel text-muted border-border/60 shadow-popover shadow-none text-fade bg-hover";',
    'const x = "hover:bg-selected dark:text-ink data-[x]:ring-focus/50";',
    'const x = "backend #613 and owner/repo#123";',
    'const x = "See #123 for details";',
    'const x = "text-[14px] bg-[var(--panel)] shadow-[inset_2px_0_0_var(--diff-add-gutter)]";',
    'const x = "linear-gradient(var(--panel), transparent)";',
    '// bg-black #fff rgb(0,0,0)\nconst x = "text-ink";',
    'const x = `bg-panel ${active ? "text-ink" : "text-muted"}`;',
  ],
  invalid: [
    ...[
      "bg-black/20", "text-white", "border-neutral-500", "bg-sage-900", "text-clay-400",
      "hover:bg-red-500", "dark:text-amber-500", "data-[x]:border-white/[0.08]",
      "[&:hover]:!ring-sky-500/20", "focus:ring-offset-white", "border-t-blue-500!",
      "bg-[#2a2a2a]", "text-[oklch(0.48_0.14_145)]", "bg-[red]",
      "#abc", "#abcd", "#aabbcc", "#aabbccdd", "rgb(1, 2, 3)", "rgba(0,0,0,0.5)",
      "linear-gradient(to top, #000, transparent)", "color-mix(in oklch, #fff, transparent)",
    ].map((value) => ({ code: `const x = ${JSON.stringify(value)};`, errors: [{ messageId: "rawColor" }] })),
    { code: 'const x = <div className="hover:bg-black/20" />;', errors: [{ messageId: "rawColor" }] },
    { code: 'const x = `bg-black ${active ? "text-ink" : "text-muted"}`;', errors: [{ messageId: "rawColor" }] },
    { code: 'const x = `linear-gradient(#fff, ${color})`;', errors: [{ messageId: "rawColor" }] },
  ],
});
