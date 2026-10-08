// One-off: scope the lint and test gates per Astra round 3 (B1). Kept for the audit trail.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const LINT = "`bun run --cwd packages/oxlint-plugin build`, then `bunx --no-install oxlint apps/web/src`";

function edit(rel, pairs) {
  const file = path.join(root, rel);
  let text = fs.readFileSync(file, "utf8");
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`${rel}: not found: ${from.slice(0, 80)}`);
    text = text.split(from).join(to);
  }
  fs.writeFileSync(file, text);
}

edit("sections/00-foundation.md", [
  ["| F-11a | `bun run lint` exits 0 with `mcode/no-raw-color` at `error` in `.oxlintrc.json`.", `| F-11a | ${LINT} exits 0 with \`mcode/no-raw-color\` at \`error\` in \`.oxlintrc.json\`.`],
  [
    "- **Verify:** `bun run --cwd apps/web test`, `bun run --cwd apps/web typecheck`, `bun run lint`; live screenshots compared with F-01a's.",
    `- **Verify:** \`bun run --cwd apps/web typecheck\`; ${LINT}; focused tests \`bun run --cwd apps/web test -- src/components/ui/__tests__/Button.test.tsx src/components/ui/__tests__/overlay-pointer-events.test.tsx src/__tests__/design-tokens.test.ts\` (CI runs the full suite); live screenshots compared with F-01a's.`,
  ],
  ["  - [ ] Both rules at error and `bun run lint` passes.", `  - [ ] Both rules at error, and ${LINT} passes.`],
]);

edit("README.md", [
  [
    "plus `bun run lint` (oxlint, fast, and the only place lint rules are configured) and `bun run --cwd <workspace> typecheck` for each workspace the ticket touches",
    "plus targeted lint (`bun run --cwd packages/oxlint-plugin build`, then `bunx --no-install oxlint <changed paths>`, which reads the root `.oxlintrc.json`) and `bun run --cwd <workspace> typecheck` for each workspace the ticket touches",
  ],
  [
    "It prints pass, fail, error and skip counts and exits non-zero on anything but a full pass.",
    "It prints pass, fail, error and skip counts. It exits 0 only when every selected proof ran and passed, 1 on any failure or error, and 2 when proofs were skipped.",
  ],
  ["`--rg-only` skips the test proofs and says so.", "`--rg-only` skips the test proofs, says so, and exits 2, so it never stands in for the full gate."],
]);
console.log("gates scoped");
