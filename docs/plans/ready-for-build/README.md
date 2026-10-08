# Ready for build: sections 01 to 12

This folder turns the approved Paper screens into work that fresh agents can build, one ticket at a time, from start to finish. It is working material. When the program ships, move what stays true into `docs/internals/`, ADRs, or the app docs, then delete this folder.

The designs live on the Paper page "05 · Ready for build". It holds 92 boards across twelve sections: empty workspace, add project, new thread, thread starting, running, approvals, plan mode, finished turns, notifications, Review, Browser, and the right panel tabs. Building them touches every client surface, all six provider adapters, the server, and the contracts. The plan has about 155 tickets in 12 epics; `tickets.md` has the exact count.

The plan was written by twelve section interviewers, then reviewed independently by GPT-6-Astra (Codex). The review, the agreed resolution per finding, and the fix brief are in `source/astra-review-round-*`.

## Start here

1. Read [spec.md](spec.md). It is the product spec: the problem, the solution, user stories, and the decisions that hold across sections.
2. Read [tickets.md](tickets.md). It lists every ticket by build wave, with its blockers and a link to its brief.
3. Pick a ticket whose blockers have all merged. Open its section file in [sections/](sections/) and read that section's Locked decisions, Backend architecture, and Retirement ledger before the ticket itself.
4. Check [decisions.md](decisions.md) for any open question your ticket touches. A default is listed for each one; build to the default unless the user has answered otherwise.

## Folder map

| Path | What it holds |
|---|---|
| `spec.md` | Product spec for the whole program (the epic body is a summary of it). |
| `tickets.md` | Generated ticket graph by wave. Do not edit by hand. |
| `decisions.md` | Open questions for the user, each with a recommended default. |
| `sections/00-foundation.md` | Design-system primitives (F tickets), the Paper style guide drift list, the Components page inventory, and the global retirement ledger. |
| `sections/01-…` to `sections/12b-…` | One build brief per section: boards, locked decisions, how the code works today, gap table, backend architecture, components and retirement ledger, tickets, tests, risks. |
| `source/` | The screen-pass todo, implementation notes, and the earlier interviews for 10, 11 and 12. These record the user's decisions with dates. |
| `tools/graph.json` | The single source of truth for ticket ids, blockers, merges, and reconciliation notes. |
| `tools/graph.mjs` | Checks the graph (unknown ids, cycles), rewrites each ticket's "Blocked by" line in the section docs, renders `tickets.md`, writes issue bodies, validates retirement ledgers, and runs a ticket's ledger proofs. |

To change a dependency, edit `tools/graph.json`, then run `node tools/graph.mjs check && node tools/graph.mjs sync-docs && node tools/graph.mjs render`.

Ledger commands, run from this folder:

- `node tools/graph.mjs ledger` fails when a ledger row lacks exactly one active owning ticket or a runnable proof command.
- `node tools/graph.mjs ledger-run <ticket>` runs every proof that ticket owns, without a shell: an `rg` proof passes when it prints nothing, a `bun`, `node` or `git` proof passes on exit 0. It prints pass, fail, error and skip counts. It exits 0 only when every selected proof ran and passed, 1 on any failure or error, and 2 when proofs were skipped. Before a ticket starts, it lists what the ticket must delete. After the ticket, it must pass. `--rg-only` skips the test proofs, says so, and exits 2, so it never stands in for the full gate.

## Paper

- File "Mcode" `01M3V9R04VVSFTYQ76BRHHA83K`.
- Page "05 · Ready for build" (`p-6-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0
- Page "01 · Style guide" (`p-1-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-1-0
- Page "04 · Components" (`p-5-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-5-0

Every ticket names its boards by name and node id, for example `05a · Running · Tools streaming · Dark` (`213P-2`). Open a board with the Paper MCP tools: `get_screenshot` to see it, `get_computed_styles` or `get_jsx` for exact values. Never take a value from a screenshot. Paper is the source of truth for visual values; DESIGN.md has been updated to match the style guide, and Paper wins where they still differ.

## Rules every ticket follows

**Leave nothing old behind.** Each section has a retirement ledger: every component, store, hook, setting, contract field, CSS class, and doc the new design replaces, with the one ticket that deletes it and a command that proves it is gone. The ticket that ships the replacement deletes the old code in the same PR. No feature flags that keep both. A PR is not done until `node tools/graph.mjs ledger-run <ticket>` passes; paste its output in the PR. F-99 runs every ticket's proofs again at the end and adds a dead-code check to CI.

**Keep old records readable.** Retire old writers and components, not the ability to read data already on disk. Historic messages with old plan fences or v1 design-note payloads must still render.

**Decide per provider.** Any provider-shaped behavior needs a decision for each adapter: Claude, Codex, Cursor, Copilot, Devin, and OpenCode. "No change" is a valid decision, but it has to be written down. Provider quirks stay in the adapter; orchestration stays pure, and the UI stays dumb.

**Add the way out.** Every new state has a visible exit and a visible marker (PRODUCT.md principle 11).

**Use the primitives.** Build from the F tickets (tokens, fade truncation, buttons, menus, pickers, overlays, toasts, provider icons, status marks). If a screen needs something a primitive cannot do, extend the primitive in its own commit rather than styling around it.

**Do not hard-code migration numbers.** Several tickets add database migrations. A section brief may name a number such as 0069 for illustration only. Take the next free number when you rebase onto main.

**Release groups.** S07-04 to S07-07 replace the old plan panel; land them in one release so comments and Implement never go missing between merges. Hold earlier PRs in the group behind the release branch or merge them in one sequence.

## How to build a ticket

1. Read the GitHub issue, its parent epic, and every issue it is blocked by (see `docs/agents/issue-tracker.md`).
2. Read the section brief and the boards. State the scope, the locked decisions, and the dependencies before editing code.
3. Branch from `main`. One ticket, one PR, Conventional Commits.
4. Build the vertical slice: contract, server, adapter decisions, web, desktop where it applies, tests.
5. Delete what the ticket owns in the ledgers and run `node docs/plans/ready-for-build/tools/graph.mjs ledger-run <ticket>`.
6. Verify with the smallest proof: `bun run --cwd <workspace> test -- <files>` plus targeted lint (`bun run --cwd packages/oxlint-plugin build`, then `bunx --no-install oxlint <changed paths>`, which reads the root `.oxlintrc.json`) and `bun run --cwd <workspace> typecheck` for each workspace the ticket touches (AGENTS.md "Verifying"; CI owns the full suite). For UI, run the live check named in the ticket on the Electron app with the live-testing harness (`.agents/skills/electorn-live-testing/SKILL.md`).
7. Open the PR with `.github/pull_request_template.md`. UI changes need before and after screenshots or video from the harness, attached to the PR.

Live checks stay inside AGENTS.md's boundaries. Product and runtime tests touch only `.dev/fixture-repo` (and, where a ticket says so, a second fixture workspace it creates under `.dev` and removes afterwards). Never sign a provider out, install or update a CLI globally, or write global config; use an isolated provider home and a scratch install prefix. Evidence from a captured provider trace is labelled as such; a provider that is unavailable on the machine is reported as pending, not passed.

## Waves

`tickets.md` groups tickets into waves by the length of their blocker chain. Wave 1 is mostly backend prefactors and urgent fixes that need nothing else: the approval fail-closed fix (S06-00), the plan protocol investigation (S07-00), paged ref listing, comparison data, snapshot pinning, the subagent roster, the files backend, and the startup record, plus the Paper token values and the Lucide icon switch. The design-system chain (F-01a, F-01b, then the primitives) gates most UI tickets, so start it first. A wave is a scheduling hint, not permission to edit the same contract, store or migration in parallel; tickets that touch one shared contract merge one at a time.

Tracks that can run side by side once the foundation primitives land:

- Shell and attention: S01, S09.
- New thread and startup: S03, S02, S04.
- Conversation: S05, S08, S08F.
- Approvals and plan: S06, S07.
- Right panel: F-05, S12P, S10, S11, S12T.

## What this program does not cover

- Paper sections 13 to 17: the pull request inbox and detail, global settings, project settings beyond General and Actions, and system states. They are not designed yet.
- The light theme beyond the token pairs in F-01a. The boards are dark; light is checked per primitive and fixed where tokens alone are wrong.
- Paper board fixes. The foundation brief lists Components boards that are stale (old "Errored" markers, old toast card, Phosphor icons). Those are design tasks for the user, listed in `decisions.md`.
