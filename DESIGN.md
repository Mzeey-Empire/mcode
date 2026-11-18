---
name: Mcode
description: Orchestration surface for running many coding agents at once. Glanceable, editorial, designed dark-first.
---

# Design: Mcode

This is a design brief, not a spec. It tells you what Mcode should feel like
and how to decide when nothing here covers your case. Exact values live in
code: tokens in `apps/web/src/index.css`, components in
`apps/web/src/components/ui/`. When this brief and shipped code disagree on a
value, the code wins and the brief is wrong. When they disagree on intent, ask
the user. Paper holds drafts and explorations; treat it as a source of ideas,
not of truth.

Read `PRODUCT.md` for who Mcode serves and `CONTEXT.md` for its words. Then,
before you design:

1. Name the user job and the exact state the user is in.
2. Pick the primary surface and the one next step.
3. Decide loading, empty, error, and narrow-width behaviour.
4. Open the reference components in section 7 and match them.

## 1. Overview

**The Quiet Workbench.** Mcode is the window a developer keeps open all
evening on a second monitor while five agents run. It sits beside the editor,
the terminal, and the browser; it is an instrument panel, not a destination.
The user rarely reads the agent's prose. They flick their eyes to the sidebar
to see what finished, what failed, what needs them, and which branch each run
is on. Design for that one-second glance.

The register is editorial and typeset: closer to a well-made code editor than
to a SaaS dashboard. A senior developer at 11pm should feel in control and
unhurried, reading an instrument, not being sold to.

What that means in practice:

- **Glance first.** State is recognisable at a glance from a small mark; its
  label stays short, never a paragraph.
- **Dense, not cramped.** Repeated rows stay compact. Groups, stages, and the
  writing surface get room to show hierarchy.
- **One warm light.** A single amber accent in a cool slate room. Its rarity is
  what makes it readable.
- **Quiet over loud.** Leave unused space empty. If a surface looks like it
  wants to convert a visitor, it is wrong.
- **Machine facts look like machine facts.** SHAs, branches, paths, and
  durations are monospace; human words are not.
- **Keyboard first.** Every action has a key path, and shortcuts are visible
  where they apply.

Mcode borrows from the Codex app its calm presentation of a run in flight, a
document-like task surface, and progressive disclosure of technical detail. It
does not borrow Codex's single-task focus. Mcode's sidebar holds many runs at
once, and threads expose provider, branch, worktree, status, and diff as
first-class state.

## 2. Colors

A matte, cool-slate canvas with one warm lamp. Mcode is designed dark-first,
because it is used in the evening. It defaults to the system theme; the user
can choose light or dark. Light is the daytime counterpart with the same
roles. Neutrals carry a faint cool tint and are never pure grey or white. In
dark, the page alone is pure black.

Use colors by role, never by value. The lint rule `mcode/no-raw-color` enforces
this.

| Role | Means | Use it for |
|---|---|---|
| `primary` (Filament Amber) | "Act here" or "this needs you" | One primary action per state, a live mode the user turned on, a thread that needs the user. |
| `page`, `background`, `panel` | Depth | Panels sit a few percent lighter than the page, so surfaces separate without lines. Where two black surfaces meet in dark, a hairline marks the edge. |
| `hover`, `selected` | Pointer and selection | Selection is a neutral fill, never amber. In dark, both are see-through ink tints, so one value works on the page, on panels, and in menus. |
| `ink`, `muted` | Text priority | `muted` for meta and resting icons. It must still hold 4.5:1 on its surface. |
| `success`, `error` | Added or finished; removed, failed, or invalid | Diffs, run state, invalid fields, and destructive menu rows. Never decoration. |
| `destructive` | "This deletes or discards" | The confirming action of a destructive dialog. Never amber. |
| `focus` | Keyboard focus | The focus ring, and nothing else. |
| `link` | Navigation | Links, not brand moments. |
| `warning`, `info` | Notices | Always with an icon and text. Warning's brass sits off amber's hue so it never reads as Send. |
| `capability`, `file-reference`, `pr-merged` | Entity identity | Skill and command tokens, file tokens, merged pull requests. |

**The One Lamp rule.** Each state has at most one amber primary action. Amber
also marks a live mode the user turned on, a thread that needs the user, and a
checked switch; none of those competes with the primary action. Selection, the
Stop button, status icons, and links stay neutral or use their own role. When
two actions want amber, one of them is wrong.

## 3. Typography

Public Sans for everything a person reads or clicks. JetBrains Mono for code,
identifiers, paths, branches, durations, and aligned numbers, with ligatures
off so the reader sees the characters the agent wrote.

Use the named type roles in `index.css` (Body, Body small, Prose, Caption,
Label, Code, and the rest). The lint rule `mcode/no-arbitrary-text-size`
rejects arbitrary font sizes; choosing the right role is on you. Dense chrome
defaults to Body small; long agent output uses Prose; headings are rare.

Durations read as compact words: `22s`, `1m 5s`, "Worked for 9s".

**Text that does not fit fades out at its right edge.** Never an ellipsis
(`mcode/no-ellipsis-truncation`). Only the text fades; icons, counts, and
actions in the row stay whole. The full value stays in the accessible name and
appears on hover or focus. A path shows the file name first and lets the folder
fade.

## 4. Layout

Three sibling panes share the window: the **sidebar** (projects, threads,
status), the **conversation** (thread, narrative, composer), and the **right
panel** (Browser, Terminal, Review, Plan, Files, and other tools). The
conversation is the anchor. The sidebar orients; the right panel inspects.
Neither competes with the current work. Never wrap the panes in an outer
dashboard card.

- **One task column.** Readable content keeps a bounded measure inside a quiet
  canvas. Do not stretch it because space exists. Code, diffs, and terminal
  output may run wider inside their own scroll region.
- **Shallow containment.** One dominant surface. Controls that need no boundary
  sit directly on the canvas.
- **Shared axes.** Headings, controls, metadata, and trailing values line up.
- **One spacing scale.** Gaps, insets, and control sizes land on the spacing
  scale: tight for related controls, more within a group, most between stages.
  The root font size is 62.5%, so `1rem` is 10px when the browser's text size
  is the usual 16px; write rem sizes with that in mind.
- **Width changes posture, not capability.** As the window narrows, a pane goes
  from docked to floating to full-surface. It keeps its state, its actions, and
  its way back. Never swap a capable pane for a weaker picker to save width.
  Focus stays on the same control when it remains visible. Closing a floating
  or full-surface pane returns focus to the control that opened it. When the
  user opens a pane full-surface from another surface, focus moves to the
  pane's heading or first control. If the opener no longer exists when a pane
  closes, focus goes to the active thread row, then to the workspace's main
  heading.
- **Toolbars stay with what they control.** No detached global toolbar for a
  local action.

## 5. Elevation and Depth

Depth comes from tone, not lines or shadows. A panel floats a few percent off
the page. Add a hairline only when neighbouring structure still needs it.
Shadows belong to things that truly float (menus, popovers, dialogs, toasts),
never to resting cards. Stack layers with the `--layer-*` tokens
(`mcode/no-numeric-z-index`, `mcode/no-raw-shadow`).

## 6. Shapes

Lucide icons at one shared stroke, through the map in
`apps/web/src/components/ui/icon-map.tsx`. A direct `lucide-react` import is
fine for a one-off icon; never add a second icon library. State never makes a
stroke heavier: a current or active icon gets a selected fill behind it.
Provider, file-type, and brand marks keep their own artwork. A provider is
identified by its mark, never by a coloured badge.

Corners are soft but not bubbly; use the radius tokens. Icon buttons follow
the surface they sit in, so copy the icon buttons already beside the one you
are adding rather than choosing a shape. Take sizes and variants from
`button.tsx`.

## 7. Components

Do not design a component from this section. Open the reference, match it, and
extend its variants rather than writing a parallel one. These are the pieces
that carry Mcode's look best:

| Reference | File | What it teaches |
|---|---|---|
| Sidebar thread row | `apps/web/src/features/projects/sidebar/SidebarThreadRow.tsx`, `apps/web/src/features/thread-attention/thread-row-state.ts` | The glance: density, status lane, fade truncation, hover actions that also appear on focus. The state file owns the thread states; `thread-row-presentation.ts` maps each to its mark and label. |
| Status mark | `apps/web/src/components/ui/status-mark.tsx` | Shows a thread's state at a glance. Reuse it instead of drawing a new one. |
| Composer | `apps/web/src/features/conversation/composer/Composer.tsx` | The strongest persistent object: a drafting surface, not a chat bubble. Controls that change what a send does stay visible beside Send. |
| Picker | `apps/web/src/components/ui/picker.tsx` | Default anatomy: search on top, a flat list, a check on the chosen row. It also supports grouped rows, tabs, and a detail pane; extend it rather than stripping those out. |
| Button and menu row | `apps/web/src/components/ui/button.tsx`, `menu-row.tsx` | Variants, sizes, and states for every action. |

**The status mark** carries meaning you must know without opening code. These
are examples; `thread-row-state.ts` holds the thread states,
`thread-row-presentation.ts` gives each its mark and label, and a row may add
short-lived ones of its own, such as "Closed" as a thread closes
(`SidebarThreadRow.tsx`):

| State | Colour | Label |
|---|---|---|
| Needs the user | `primary` | "Approval required", "Answers required", "Plan ready", "Interrupted", "Setup failed" |
| Finished, unopened | `success` | "Finished" |
| Failed | `error` | "Failed" |
| Running | Neutral | "Running" |
| Idle, or a settled outcome the user has seen | None | None |

The mark's shape, and whether its label shows as text, in a tooltip, or only
as the mark's accessible name, come from `status-mark.tsx` and the row that
uses it.

Use a mark only on glance surfaces or for state the user cannot otherwise see.
Opening a thread clears its settled outcomes once seen, including finished,
failed, and interrupted. Running activity and live waits (approval, answers,
setup failure, plan ready) stay visible. `thread-row-state.ts` defines the
exact rules.

**The conversation** reads as a document, not speech bubbles: one
chronological flow. Collapse detail before you hide meaning. Do not invent a
second timeline grammar for a new event type; fit it into the existing one.
Streaming must not reflow or flash earlier content. See
`docs/internals/conversation/narrative-pipeline.md`.

**Choosing a surface.** Inline first, an anchored popover second, a dialog only
for a decision that truly blocks. Menus run commands; pickers choose a value;
popovers inspect. Escape closes the frontmost surface and returns focus to its
trigger. A destructive confirmation uses the `destructive` button variant, not
amber.

**The next step.** When a thread has one likely next move, show it in the same
place every time, between the narrative and the composer: one amber action,
other valid moves as quiet ghosts. The next step is a fixed function of state.
It does not learn, reorder, or guess.

**When things go wrong.** Keep what the user had (draft, output, changes,
scroll). Say what failed in plain words, with raw detail behind a disclosure.
Put one recovery action beside the failed object: `Retry`, `Reconnect`,
`Resume`, `Sign in`. Never imply a rollback that did not happen. When a remote
outcome is unknown, check its status before you offer `Retry`, because
repeating it may duplicate work. A run the user stopped gets a quiet line, with
no fill and no button. Success updates the object in place; show a toast only
when the object is no longer visible.

**Loading and empty.** A spinner inside the control for a short action, a
skeleton for a first load whose shape is known, stale content with a quiet cue
for a refresh. An empty surface says why it is empty. Offer one action only
when the user can resolve the condition. No fake activity, no placeholder
metrics.

## 8. Do's and Don'ts

### Every interactive element

Define default, hover, focus-visible, pressed, selected, disabled, loading,
and error before you ship. Selection, focus, and live status are three
different signals: a neutral fill, the focus ring, and the status mark. Never
put amber on all three.

### Motion

Motion explains a change of state or place. It never decorates a resting
surface. Use `--ease-standard` with `--duration-fast`, `--duration-standard`,
or `--duration-overlay`, and never bounce. Prefer transform and opacity.
Disclosures reuse `AnimatedCollapsible` (`components/ui/animated-collapsible.tsx`),
or the `animate-collapsible-*` classes for a Radix `CollapsibleContent`, instead
of writing a new height animation. Content renders without waiting for an
animation. With reduced motion, movement becomes an instant change or a short
fade and no information is lost. Avoid timers that
re-render a whole tree every second.

### Accessibility

WCAG 2.1 AA. Every action has a keyboard path, and focus is always visible.
Colour, icon, position, fade, and motion support text or an accessible name;
none carries critical state alone. Announce completions, blocking errors, and
permission requests through a live region, but never stream text token by
token. At 200% zoom a pane may change posture, but no action or state
disappears. Tooltips explain; they never hold required instructions
(`mcode/no-native-title-tooltip`).

### Voice

Short technical sentences. Lead with the object and the outcome. Sentence case.
Buttons start with a verb. Use the words in `CONTEXT.md`, not synonyms.

| Write | Not |
|---|---|
| `Command failed` | `Oops, something went wrong` |
| `Failed` | `Errored` |
| `Worktree removed` | `Success! Your worktree has been removed` |
| `No files changed` | `Nothing to see here yet` |
| `Delete 4 threads and 1 worktree` | `Are you sure?` |

The users are developers. Do not caption ordinary git or developer behaviour.
Show a count only when it changes what the user does next. Mcode is single-user:
do not label the user's own notes "You" or timestamp them.

### Never

- Emoji decoration, marketing voice, hero type, or eyebrow labels on a task
  surface.
- Glassmorphism, gradient text, decorative glow, resting card shadows, coloured
  side stripes, or decorative charts.
- A second amber primary action in the same state, or two competing next steps.
- Green or red outside the `success`, `error`, and `destructive` roles.
- A status shown only by colour.
- Speech bubbles or typing theatrics in the conversation.
- Raw wire syntax where a product concept exists.
- A new raw colour, size, radius, shadow, or z-index in feature code. If a token
  is missing, add it to `index.css` first and say why.

## Keeping this brief short

Add a line here only if it changes decisions across more than one component.
One component's measurements belong in its code, with a comment when the reason
is not obvious. If a rule can be checked, write a lint rule instead and link to
it from here.
