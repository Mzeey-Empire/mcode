# Section build brief: authoring rules and template

Every file in `../sections/` follows this template. A fresh implementing agent reads one section file plus the tickets that point at it, and must be able to build its slice without this conversation.

## Inputs every author reads first

1. `AGENTS.md`, `CONTEXT.md` (glossary; use its terms), `ARCHITECTURE.md`, `DESIGN.md`, `PRODUCT.md`.
2. `source/screen-pass-todo.md` (decisions per screen, dated) and `source/implementation-notes.md` (code gaps found while designing). These are the user's locked decisions. Do not reopen them.
3. Any `source/NN-*-interview.md` for your section.
4. ADRs in `docs/adr/` that touch your area.
5. The Paper boards for your section (read-only).

## Paper

- File `01M3V9R04VVSFTYQ76BRHHA83K` ("Mcode"). Page "05 · Ready for build" is `p-6-0`: https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0
- Style guide page "01 · Style guide" is `p-1-0`. Components page "04 · Components" is `p-5-0`.
- Read with the Paper MCP tools: `get_tree_summary`, `get_screenshot` (scale 1 unless text is unreadable), `get_computed_styles` / `get_jsx` for exact values. Never use write tools. Never take values from screenshots.
- Reference a board in docs as: board name, node id, and the page link. Example: `05a · Running · Tools streaming · Dark` (`213P-2`, page p-6-0).
- Paper is the source of truth for visual values. Where DESIGN.md disagrees, Paper wins.

## Rules

- Read-only on code. Write only your own section file (and, for the foundation author, the files named in its brief).
- Cite code as `path:line`. Spot-check every claim you make about the code; mark anything you could not verify as "(inferred)".
- Every provider-shaped behavior needs a decision per adapter: Claude, Codex, Cursor, Copilot, Devin (ACP), OpenCode. Say "no change" explicitly where that is the decision.
- Complexity belongs at the provider adapter boundary. Orchestration stays pure, UI stays dumb.
- Reverse states: every way in has a way out and a way to see it.
- Paths and code snippets are allowed in these docs (they are working material). Type sketches for new contracts are encouraged.
- Leave nothing old behind. Every component, store, hook, setting, contract field, CSS class, or doc that the new design replaces goes in the Retirement ledger with the ticket that deletes it. Replacement and deletion land in the same ticket (migrate callers, then delete, in one wave). No feature flags that keep both.

## Template

```markdown
# NN · <Section name>: build brief

<Three to six lines. What the user gets when this section ships, and which surfaces it touches.>

## Boards

| Board | Node | Shows |
|---|---|---|

## Locked decisions

<Bullets copied or condensed from the screen-pass todo and implementation notes, with dates. Only what an implementer needs.>

## How it works today

<Interview of the current code, grouped by concern. File pointers. Bugs found, marked verified or inferred.>

## Gap table

| Design element | Today | Change | Layers (contracts / server / providers / web / desktop) |
|---|---|---|---|

## Backend architecture

<Only where the design needs new or changed behavior below the UI. For each piece: the data shape (TS sketch), where it lives (contracts schema, server service, DB table and migration, provider adapter), the wire method or event, idempotency and failure modes, and per-provider decisions in a table. Reuse existing services by name. Prefer one new seam over several.>

## Components

### New
### Changed
### Retirement ledger

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|

<Proof is a command, e.g. `rg -n "StartupProgressCard" apps packages` returns nothing.>

## Proposed tickets

<Tracer-bullet vertical slices. Each fits one fresh agent context. Prefactors first. Use ids SNN-01, SNN-02 ... For cross-section dependencies name the other section's ticket by id if you know it, else by description. Foundation tickets are F-NN (see below).>

### SNN-01 <Title>

- **Blocked by:** <ids or None>
- **Boards:** <board names + node ids>
- **Delivers:** <end-to-end behavior from the user's view>
- **Build notes:** <layers touched, key types, the seam to test at>
- **Deletes:** <retirement ledger rows>
- **Acceptance criteria:**
  - [ ] ...
- **Verify:** <unit or integration test seam and prior-art test file; the live check on the Electron or web surface (what to click, what must be on screen)>

## Tests

<Seams to test at (highest seam possible), prior-art test files, fixtures.>

## Risks and open questions

<Each with who decides. Product calls go to the user; facts you can check, check.>
```

## Provisional foundation tickets (shared ids)

Section authors reference these by id. The foundation author refines them.

- F-01 Paper token sync: web CSS tokens match the Paper style guide (color roles dark and light, type roles, spacing, radius, sizes, sidebar 304).
- F-02 Fade truncation primitive: 24px right-edge fade replaces every ellipsis.
- F-03 Button primitives: round 32px icon button (ghost at rest, selected fill + ink icon when on), split button, neutral selected state; one amber primary per state.
- F-04 Menu and picker primitives: names-only menus with dividers and muted shortcuts; picker anatomy (search row, flat list, check on selected, silent paging with "Showing x of y", segmented tabs).
- F-05 Right panel shell: two-row panel header (row 1 shares the window caption overlay, row 2 per-tab controls), rail as vertical tabs, horizontal row-1 tabs inside panels.
- F-06 Provider icon component and the overlapping disc stack (max 3).
- F-07 Floating surface primitives: toast and floating-pill shadow, popovers that open to the side.
