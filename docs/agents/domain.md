# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — Mcode's domain glossary (thread, fork, handoff, provider terms, etc.)
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

Mcode is a single-context repo:

```
/
├── CONTEXT.md            ← project-wide glossary
├── docs/adr/             ← architectural decision records
└── apps/, packages/      ← source
```

Even though Mcode is a monorepo (`apps/server`, `apps/web`, `apps/desktop`, `packages/contracts`, `packages/shared`), domain terms like `Thread`, `Message`, `Workspace`, `AgentEvent`, `Provider`, `Handoff` are intentionally shared across packages via `packages/contracts`. They belong in a single project-wide glossary.

If you ever start seeing naming collisions across packages (e.g. "Session" meaning different things in server vs. web), revisit `/setup-matt-pocock-skills` to migrate to a multi-context layout with `CONTEXT-MAP.md`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids — e.g. say "Fork" not "Branch" when referring to chat-thread branching (the glossary explicitly notes this rename).

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_

`docs/adr/` doesn't exist yet; ADRs will appear as they get written by `/grill-with-docs` or by hand.
