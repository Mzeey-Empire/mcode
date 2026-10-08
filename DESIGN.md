---
name: Mcode
description: Orchestration surface for running many coding agents at once, glanceable, editorial, and dark by default.
# Colors mirror the Paper role tokens (--color-<role> dark, --color-light-<role> light).
# Each role points at a step of the Paper 50 to 950 ramps (neutral, amber, blue, sage,
# clay, violet); the step is named in the trailing comment. The ramps themselves live in
# Paper and in apps/web/src/index.css.
colors:
  page: "oklch(0.12 0.005 260)" # neutral-950
  background: "oklch(0.16 0.005 260)" # neutral-900
  panel: "oklch(0.19 0.005 260)" # neutral-800
  hover: "oklch(0.22 0.005 260)" # neutral-700
  selected: "oklch(0.24 0.005 260)" # neutral-600
  border: "oklch(0.28 0.005 260)" # neutral-500
  control-border: "oklch(0.50 0.010 260)" # neutral-400
  ink: "oklch(0.955 0.005 260)" # neutral-100
  muted: "oklch(0.65 0.005 260)" # neutral-300
  primary: "oklch(0.72 0.17 75)" # amber-500
  primary-hover: "oklch(0.68 0.17 75)" # amber-600
  primary-ink: "oklch(0.16 0.005 260)" # neutral-900
  destructive: "oklch(0.65 0.20 25)" # clay-500
  destructive-ink: "oklch(0.16 0.005 260)" # neutral-900
  button-secondary-hover: "oklch(0.28 0.005 260)" # neutral-500
  button-destructive-hover: "oklch(0.78 0.13 25)" # clay-400
  focus: "oklch(0.62 0.19 264)" # blue-500
  link: "oklch(0.70 0.14 260)" # blue-400
  success: "oklch(0.78 0.13 145)" # sage-400
  error: "oklch(0.78 0.13 25)" # clay-400
  warning: "oklch(0.80 0.13 75)" # amber-400
  info: "oklch(0.70 0.14 260)" # blue-400
  pr-merged: "oklch(0.70 0.14 293)" # violet-400
  diff-add-bg: "oklch(0.26 0.035 145)" # sage-900
  diff-remove-bg: "oklch(0.26 0.045 25)" # clay-900
  light-page: "oklch(0.955 0.005 260)" # neutral-100
  light-background: "oklch(0.99 0.005 260)" # neutral-50
  light-panel: "oklch(0.99 0.005 260)" # neutral-50
  light-hover: "oklch(0.955 0.005 260)" # neutral-100
  light-selected: "oklch(0.955 0.005 260)" # neutral-100
  light-border: "oklch(0.90 0.005 260)" # neutral-200
  light-control-border: "oklch(0.65 0.005 260)" # neutral-300
  light-ink: "oklch(0.19 0.005 260)" # neutral-800
  light-muted: "oklch(0.50 0.010 260)" # neutral-400
  light-primary: "oklch(0.52 0.17 75)" # amber-700
  light-primary-hover: "oklch(0.48 0.17 75)" # amber-800
  light-primary-ink: "oklch(0.99 0.005 260)" # neutral-50
  light-destructive: "oklch(0.577 0.19 27.3)" # clay-600
  light-destructive-ink: "oklch(0.99 0.005 260)" # neutral-50
  light-button-secondary-hover: "oklch(0.90 0.005 260)" # neutral-200
  light-button-destructive-hover: "oklch(0.52 0.14 25)" # clay-700
  light-focus: "oklch(0.52 0.17 264)" # blue-600
  light-link: "oklch(0.50 0.16 260)" # blue-700
  light-success: "oklch(0.52 0.12 145)" # sage-600
  light-error: "oklch(0.52 0.14 25)" # clay-700
  light-warning: "oklch(0.52 0.17 75)" # amber-700
  light-info: "oklch(0.50 0.16 260)" # blue-700
  light-pr-merged: "oklch(0.50 0.16 293)" # violet-700
  light-diff-add-bg: "oklch(0.96 0.035 145)" # sage-100
  light-diff-remove-bg: "oklch(0.96 0.045 25)" # clay-100
  # Identity asset, not a UI role. Provider marks keep their own colours.
  provider-claude: "#D97757"
  # Owned here: Paper defines only the diff background pair.
  diff-add-gutter: "oklch(0.50 0.11 145)"
  diff-add-text: "oklch(0.86 0.09 145)"
  diff-add-emphasis: "oklch(0.34 0.07 145)" # sage-800, word-level emphasis
  diff-remove-gutter: "oklch(0.55 0.13 25)"
  diff-remove-text: "oklch(0.86 0.09 25)"
  diff-remove-emphasis: "oklch(0.37 0.09 25)" # clay-800, word-level emphasis
  light-diff-add-gutter: "oklch(0.78 0.10 145)"
  light-diff-add-text: "oklch(0.40 0.12 145)"
  light-diff-add-emphasis: "oklch(0.93 0.055 145)"
  light-diff-remove-gutter: "oklch(0.78 0.11 25)"
  light-diff-remove-text: "oklch(0.48 0.15 25)"
  light-diff-remove-emphasis: "oklch(0.93 0.065 25)"
typography:
  h1:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "4.8rem"
    fontWeight: 600
    lineHeight: "5.6rem"
    letterSpacing: "-0.03em"
  h2:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "4rem"
    fontWeight: 600
    lineHeight: "4.8rem"
    letterSpacing: "-0.025em"
  h3:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "3.2rem"
    fontWeight: 600
    lineHeight: "4rem"
    letterSpacing: "-0.02em"
  h4:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "2.8rem"
    fontWeight: 600
    lineHeight: "3.2rem"
    letterSpacing: "-0.015em"
  h5:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "2.4rem"
    fontWeight: 600
    lineHeight: "2.8rem"
    letterSpacing: "-0.01em"
  h6:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: "2.4rem"
    letterSpacing: "0em"
  body:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 400
    lineHeight: "2.4rem"
    letterSpacing: "0em"
  prose:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 400
    lineHeight: "2.8rem"
    letterSpacing: "0em"
  body-small:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.4rem"
    fontWeight: 400
    lineHeight: "2rem"
    letterSpacing: "0em"
  caption:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.2rem"
    fontWeight: 400
    lineHeight: "1.6rem"
    letterSpacing: "0em"
  label:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.4rem"
    fontWeight: 500
    lineHeight: "2rem"
    letterSpacing: "0em"
  button:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.4rem"
    fontWeight: 500
    lineHeight: "2rem"
    letterSpacing: "0em"
  link:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 500
    lineHeight: "2.4rem"
    letterSpacing: "0em"
  code:
    fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace"
    fontSize: "1.4rem"
    fontWeight: 400
    lineHeight: "2rem"
    letterSpacing: "0em"
    fontVariantLigatures: "none"
rounded:
  badge: "0.6rem"
  menu: "0.8rem"
  control: "1rem"
  composer: "1.4rem"
  dialog: "1.8rem"
  full: "999px"
spacing:
  4: "0.4rem"
  8: "0.8rem"
  12: "1.2rem"
  16: "1.6rem"
  20: "2rem"
  24: "2.4rem"
  28: "2.8rem"
  32: "3.2rem"
  40: "4rem"
  48: "4.8rem"
  56: "5.6rem"
  compact-row: "{spacing.8}"
  group: "{spacing.16}"
  task-stage: "{spacing.32}"
  workspace: "{spacing.32}"
  text-fade: "{spacing.24}"
sizes:
  control-compact: "3.2rem"
  control-default: "4rem"
  control-comfortable: "4.8rem"
  row-compact: "3.2rem"
  row-default: "4rem"
  row-comfortable: "4.8rem"
  target-touch: "4.8rem"
  border-default: "1px"
  focus-ring: "2px"
  focus-offset: "2px"
opacity:
  disabled: 0.5
  overlay: 0.1
  active-row: 0.55
iconography:
  package: "lucide-react"
  grid: "2.4rem"
  strokeWidth: 1.5
  caps: "round"
  joins: "round"
  sizes:
    metadata: "1.2rem"
    compact: "1.6rem"
    standard: "2rem"
    large: "2.4rem"
    display: "3.2rem"
  opticalSizes:
    dense: "1.4rem"
motion:
  instant: "0ms"
  fast: "120ms"
  standard: "180ms"
  overlay: "240ms"
  ease: "cubic-bezier(0.2, 0, 0, 1)"
  spin: "1000ms"
shadows:
  # The 2px gap takes the color of the surface the control sits on.
  focusRing: "0 0 0 2px {surface}, 0 0 0 4px {colors.focus}"
  popover: "0 8px 24px oklch(0 0 0 / 0.24)"
  floating: "0 8px 24px oklch(0 0 0 / 0.40)"
  dialog: "0 16px 48px oklch(0 0 0 / 0.40)"
  lightOverlay: "0 12px 32px #1418201F, 0 2px 6px #1418200F"
layout:
  sidebarMin: "22rem"
  sidebarDefault: "30.4rem"
  sidebarMax: "34rem"
  conversationMin: "52rem"
  readingMeasure: "76rem"
  composerWidth: "76rem"
  threadOverviewWidth: "28rem"
  inspectorMin: "28rem"
  inspectorDefault: "31rem"
  rightRail: "4.8rem"
  rightRailExpanded: "16rem"
  rightPanelMin: "48rem"
  rightPanelDefault: "60rem"
  rightPanelMax: "84rem"
  panelHeaderPrimary: "4.8rem"
  panelHeaderSecondary: "4rem"
  settingsMeasure: "76rem"
  wideMin: "126rem"
  constrainedMin: "76rem"
layers:
  base: 0
  sticky: 10
  dropdown: 20
  floatingPanel: 30
  modalBackdrop: 40
  modal: 50
  toast: 60
  tooltip: 70
components:
  button:
    rounded: "{rounded.control}"
    typography: "{typography.button}"
    heights: "{sizes.control-compact} / {sizes.control-default} / {sizes.control-comfortable}"
    paddingInline: "1.2rem / 1.6rem / 2rem"
    iconSize: "1.6rem / 2rem / 2rem"
    pressed: "inset 0 0 0 2px <variant foreground>"
    focus: "{shadows.focusRing}"
    disabledOpacity: "{opacity.disabled}"
  button-primary:
    backgroundColor: "{colors.primary}"
    backgroundColorHover: "{colors.primary-hover}"
    textColor: "{colors.primary-ink}"
    backgroundColorLight: "{colors.light-primary}"
    backgroundColorHoverLight: "{colors.light-primary-hover}"
    textColorLight: "{colors.light-primary-ink}"
  button-outline:
    backgroundColor: "{colors.background}"
    backgroundColorHover: "{colors.hover}"
    borderColor: "{colors.control-border}"
    textColor: "{colors.ink}"
  button-secondary:
    backgroundColor: "{colors.selected}"
    backgroundColorHover: "{colors.button-secondary-hover}"
    textColor: "{colors.ink}"
  button-ghost:
    backgroundColor: "transparent"
    backgroundColorHover: "{colors.hover}"
    borderColor: "transparent"
    textColor: "{colors.ink}"
    iconColorAtRest: "{colors.muted}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    backgroundColorHover: "{colors.button-destructive-hover}"
    textColor: "{colors.destructive-ink}"
  button-link:
    textColor: "{colors.link}"
    typography: "{typography.link}"
    textDecoration: "underline"
  icon-button-round:
    size: "{sizes.control-compact}"
    rounded: "{rounded.full}"
    backgroundColor: "{colors.selected}"
    backgroundColorOn: "{colors.control-border}"
    iconColor: "{colors.ink}"
    iconSize: "{iconography.sizes.compact}"
    border: "none"
    floatingSize: "{sizes.control-default}"
    floatingShadow: "{shadows.floating}"
  input:
    backgroundColor: "{colors.selected}"
    borderColor: "{colors.control-border}"
    borderColorHover: "{colors.muted}"
    textColor: "{colors.ink}"
    placeholderColor: "{colors.muted}"
    errorColor: "{colors.error}"
    focus: "{shadows.focusRing}"
    typography: "{typography.body-small}"
    rounded: "{rounded.control}"
    height: "{sizes.control-default}"
    heightCompact: "{sizes.control-compact}"
    paddingInline: "1.2rem"
    disabledOpacity: "{opacity.disabled}"
  panel:
    backgroundColor: "{colors.background}"
    rounded: "0"
    padding: "0"
  floating-panel:
    backgroundColor: "{colors.panel}"
    borderColor: "{colors.border}"
    rounded: "{rounded.composer}"
    padding: "0.8rem"
    shadow: "{shadows.popover}"
    shadowLight: "{shadows.lightOverlay}"
  menu-row:
    height: "{sizes.row-default}"
    rounded: "{rounded.menu}"
    paddingInline: "1.2rem"
    iconSlot: "2rem"
    iconSize: "{iconography.sizes.compact}"
    iconColor: "{colors.muted}"
    typography: "{typography.body-small}"
    highlighted: "{colors.hover}"
    shortcutColor: "{colors.muted}"
    destructiveColor: "{colors.error}"
    divider: "1px {colors.border}, 0.8rem inset"
  tooltip:
    backgroundColor: "{colors.panel}"
    borderColor: "{colors.border}"
    rounded: "{rounded.menu}"
    typography: "{typography.caption}"
    minHeight: "{sizes.control-compact}"
    paddingInline: "1.2rem"
    maxWidth: "32rem"
  dialog:
    backgroundColor: "{colors.panel}"
    borderColor: "{colors.border}"
    rounded: "{rounded.dialog}"
    shadow: "{shadows.dialog}"
  toast:
    width: "34rem"
    backgroundColor: "{colors.selected}"
    backgroundColorHover: "{colors.border}"
    rounded: "{rounded.dialog}"
    border: "none"
    shadow: "{shadows.floating}"
    padding: "1.2rem 1rem 1.2rem 1.6rem"
    maxStack: 3
    finishedLifetime: "8000ms"
    enter: "{motion.overlay} {motion.ease}"
    swipeExit: "160ms"
    stackReflow: "200ms"
  status-mark:
    size: "0.8rem"
    ringWidth: "1.5px"
    needsYou: "ring {colors.primary}"
    finished: "dot {colors.success}"
    failed: "dot {colors.error}"
    running: "neutral spinner, row at {opacity.active-row}"
    accessibleTextRequired: true
---

# Design System: Mcode

## 1. Overview

**Creative North Star: "The Quiet Workbench"**

Mcode is the surface a developer keeps open all evening on a second monitor while five agents run in parallel. It is not a destination; it is an instrument panel that sits next to the editor, the terminal, and the browser. So the whole system is built for the *glance*, not the read. The user is rarely studying the agent's prose; they are flicking their eyes to the sidebar to see what finished, what failed, what needs them, and what branch each run is on. Everything here optimizes that one-second scan: a status mark read at flick-speed is worth more than a paragraph.

The register is editorial and typeset, closer to a well-made code editor or a terminal than a CRM or a SaaS dashboard. Information density is a feature, but uniform compression is not. Repeated rows and tabular data stay compact. Groups, task stages, writing surfaces, and primary work areas use enough space to communicate hierarchy, focus, and ownership. Color is rationed: a warm amber primary on a matte cool-slate canvas, with sage for additions and clay for removals. The amber is the single point of warmth; the slate is the cool room around it after dark. Dark is the default canvas because the product is used in the evening; a cool light counterpart exists for daytime.

This system explicitly rejects the consumer-app reflexes: no softened "Oops, something went wrong" copy (we say "Failed", "Idle", "Empty"), no emoji decoration, no colorful status chips, no glassmorphism, no gradient hero metrics, no marketing voice in the diff. If it looks like it wants to convert a visitor, it is wrong. It should look like it wants to get out of the way.

**Key Characteristics:**
- Register in three words: editorial, quiet, instrument-grade. A senior
  developer at 11pm should feel in control and unhurried, reading an
  instrument, not being marketed to.
- Glance-first: status communicated by small marks, a fade, and one short
  label, never paragraphs.
- Dark-primary, Filament Amber accent on cool-slate surfaces; light theme is the cool-neutral counterpart.
- Tonal lift instead of divider lines: panels float a few percent off the page.
- Monospace carries machine facts (SHAs, branches, paths, durations, timestamps); Public Sans carries human prose and labels.
- Keyboard-first: shortcuts are first-class, not hidden.
- Information-dense by intent: compact related rows, clear group spacing, and no decorative padding.
- Four-point spacing: every layout gap, inset, control size, and icon size lands on a 4px step.
- Text that does not fit fades out at its right edge. Mcode never truncates with an ellipsis.
- Capability-preserving responsive layout: the same tool docks, floats, or
  collapses without losing state or actions.

### How to use this document

This file is the implementation contract for product UI. An agent should be
able to make a routine design decision from it without opening a reference app.
Read `PRODUCT.md` first for product intent and `CONTEXT.md` for domain language.
Then use this file for visual and interaction choices. Use
`docs/internals/renderer/ui-components.md` for the component registry and live-verification
requirements.

The [Mcode Paper file](https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K)
is the visual source of truth. Its "01 · Style guide" page defines the design
tokens, and its "04 · Components" page defines each component's variants and
states. Design changes start in Paper; this file and the code follow. When
Paper and this file disagree, Paper wins, and the next edit to this file
corrects the drift.

When guidance conflicts, apply this order:

1. Explicit user feedback, screenshots, and selected references.
2. The Paper file for tokens and component appearance.
3. `PRODUCT.md` for audience, jobs, and product principles.
4. This file for interaction, accessibility, and rules a canvas cannot show.
5. Existing shared components and neighboring product patterns.

Within this file, each decision has one normative owner:

| Concern | Normative owner |
|---|---|
| Exact token values and primitive recipes | The Paper file's design tokens. The YAML frontmatter mirrors them by Paper's role names and owns values Paper does not define, such as shadows, motion, layers, and the diff gutter and text colors. |
| Domain ownership and lifecycle | `CONTEXT.md`; this file describes presentation only. |
| Layout, component anatomy, interaction, motion, and accessibility | The matching section in Sections 3 through 10. |
| Product-state composition | Canonical compositions; recipes assemble existing rules and do not redefine them. |
| Implementation workflow | Before an agent changes UI and `docs/internals/renderer/ui-components.md`. |
| Prohibitions | Section 12. |

Later checklists point to these owners. They do not create alternate token
values, names, shortcuts, or behaviors. When a summary conflicts with its
normative owner, fix or remove the summary instead of choosing between them.

Do not copy a reference product wholesale. The Codex app is the main reference
for calm agent-run presentation, progressive disclosure, and a content-first
task surface. Mcode keeps its own identity: cool slate, Filament Amber, a
sidebar built for several concurrent runs, dense machine facts, and explicit
worktree state.

### Fast decisions for agents

| Question | Default answer |
|---|---|
| Which icon family? | Lucide via `lucide-react`, 1.5px stroke. |
| How does an icon show the current or active state? | A selected fill behind it. The stroke never gets heavier. |
| Which accent? | Filament Amber for one primary action per state, a live mode, or a thread that needs the user. Selection uses a neutral fill. Links use the link color. |
| Border or surface change? | Surface change first; add a hairline when adjacent structure still needs definition. |
| Card or pane? | Pane for a primary workspace; one card only for a discrete object. |
| Text too long for its slot? | Clip it and fade the last 24px. Never an ellipsis. |
| Icon-only action at the top level or floating over content? | A 32px round button with the selected fill and an ink icon. |
| Icon-only action inside a row or toolbar? | A ghost button: transparent at rest, hover fill on hover. |
| Spinner, skeleton, or stale content? | Spinner for a short initiating action, skeleton for known first-load geometry, stale content for refresh. |
| Modal or inline interaction? | Inline first, anchored popover second, dialog only for a genuinely modal decision. |
| What happens when width shrinks? | Keep the same component and state; change its posture from docked to floating to full-surface. |
| How many primary actions? | One per state. |
| How should an error sound? | State what failed and place recovery beside it. Say "Failed", not "Errored". |
| Should this row carry a caption or a count? | Only if a developer would miss it. Counts appear only where they change the next action. |

## 2. Colors

A warm amber accent rationed over a matte cool-slate canvas, with a sage/clay pair reserved exclusively for diff and run-state semantics.

Paper defines six 50 to 950 ramps (neutral, amber, blue, sage, clay, violet) on its "01 · Style guide" page, and every color role points at one step of a ramp. The role names below are the Paper names; code uses the same names.

### Primary
- **Filament Amber** (`primary`, amber-500 dark / `light-primary`, amber-700 light): The single accent. Primary buttons, the composer Send button, a live mode such as Design mode, and the needs-you ring. Selection uses a neutral fill so the lamp remains available for action and attention. Hue 75 reads as a warm workbench lamp, not a brand purple. The same hue and chroma shift only in lightness between themes so identity holds across both. Amber carries dark ink text (`primary-ink`, neutral-900) in dark theme and near-white (`light-primary-ink`, neutral-50) in light theme, to hold 4.5:1.

### Secondary
- **Focus** (`focus`, blue-500 dark / blue-600 light): The keyboard focus ring in both themes. A cooler blue-violet used only for focus affordance, never as a second brand voice.
- **Link** (`link`, blue-400 dark / blue-700 light): Hyperlinks and link-styled actions. Links are navigational plumbing, not brand moments, so they take the surface's own cool hue at higher chroma rather than borrowing the amber lamp.
- **Information** (`info`) and **Warning** (`warning`): feedback notices only, always paired with an icon and text.
- **Merged PR** (`pr-merged`, violet): the merged state of a pull request. Nothing else uses violet.

### Tertiary
- **Success** (`success`, sage-400 dark / sage-600 light): Additions, completed state, the finished status mark, and the "Finished" label.
- **Error** (`error`, clay-400 dark / clay-700 light): Removals, the failed status mark, the "Failed" label, invalid fields, and destructive menu items. Closely related to `destructive` (clay-500 dark / clay-600 light), which fills destructive buttons; `error` is desaturated for inline legibility.

### Neutral
- **Ink** (`ink`, neutral-100 dark / neutral-800 light): Primary text. Near-white in dark, near-black-cool in light. Never pure `#fff` or `#000`.
- **Muted** (`muted`, neutral-300 dark / neutral-400 light): Secondary text, meta, captions, resting icons. Holds 4.5:1 on its surfaces; do not push muted text lighter "for elegance."
- **Page** (`page`): The darkest layer, page chrome and the sidebar. Panels sit *above* it.
- **Background** (`background`): App background and the conversation canvas, one step up from page.
- **Panel** (`panel`): Menus, popovers, pickers, tooltips, dialogs, and cards.
- **Hover** (`hover`) and **Selected** (`selected`): The hover fill and the selected fill. Selected also fills inputs, round icon buttons, toasts, and the active segment of a segmented control.
- **Border** (`border`): The rare explicit hairline, dividers inside menus, and the 1px edge of transient panels.
- **Control boundary** (`control-border`): The 1px edge of inputs, outline buttons, and segmented controls, and the fill of a round icon button that is switched on.

### Theme contract

Both themes use the same semantic roles and hierarchy. Theme switching changes
token values, never component anatomy, status meaning, or action priority.

| Role | Dark | Light |
|---|---|---|
| Page | `page` (neutral-950) | `light-page` (neutral-100) |
| Background | `background` (neutral-900) | `light-background` (neutral-50) |
| Panel | `panel` (neutral-800) | `light-panel` (neutral-50) |
| Hover | `hover` (neutral-700) | `light-hover` (neutral-100) |
| Selected | `selected` (neutral-600) | `light-selected` (neutral-100) |
| Border | `border` (neutral-500) | `light-border` (neutral-200) |
| Control boundary | `control-border` (neutral-400) | `light-control-border` (neutral-300) |
| Text | `ink` (neutral-100) | `light-ink` (neutral-800) |
| Muted text | `muted` (neutral-300) | `light-muted` (neutral-400) |
| Primary | `primary` (amber-500) | `light-primary` (amber-700) |
| Primary hover | `primary-hover` (amber-600) | `light-primary-hover` (amber-800) |
| Primary text | `primary-ink` (neutral-900) | `light-primary-ink` (neutral-50) |
| Destructive | `destructive` (clay-500) | `light-destructive` (clay-600) |
| Destructive text | `destructive-ink` (neutral-900) | `light-destructive-ink` (neutral-50) |
| Secondary button hover | `button-secondary-hover` (neutral-500) | `light-button-secondary-hover` (neutral-200) |
| Destructive button hover | `button-destructive-hover` (clay-400) | `light-button-destructive-hover` (clay-700) |
| Focus | `focus` (blue-500) | `light-focus` (blue-600) |
| Link | `link` (blue-400) | `light-link` (blue-700) |
| Success | `success` (sage-400) | `light-success` (sage-600) |
| Error | `error` (clay-400) | `light-error` (clay-700) |
| Warning | `warning` (amber-400) | `light-warning` (amber-700) |
| Information | `info` (blue-400) | `light-info` (blue-700) |
| Merged PR | `pr-merged` (violet-400) | `light-pr-merged` (violet-700) |
| Diff addition | `diff-add-bg` (sage-900), plus the frontmatter gutter, text, and emphasis colors | Matching `light-*` tokens. |
| Diff removal | `diff-remove-bg` (clay-900), plus the frontmatter gutter, text, and emphasis colors | Matching `light-*` tokens. |

The primary and destructive pairs are contrast-checked as complete pairs. Do
not reuse one theme's foreground in the other theme. Placeholder and muted
readable text still meet 4.5:1 against the surface where they appear.

The control boundary tokens are solid 1px colors, not translucent hints.
`control-border` measures approximately 3.24:1 against `background`;
`light-control-border` measures approximately 3.1:1 against
`light-background`. Recheck the light value after any token change.

### Named Rules
**The One Lamp Rule.** Filament Amber is Mcode's primary brand color. Each state has at most one amber primary action. Amber also marks a live mode the user turned on (Design mode, an agent acting in the Browser) and a thread that needs the user (the needs-you ring and its label). Everything else is neutral: selected rows, the access-mode picker's selected row, the Plan chip, the Full access chip, the Stop button, toggles, update and notification buttons, and status icons. Links use the link color, never amber. Keyboard focus uses the focus blue.

**The Earned-Color Rule.** Neutrals are the surface default. A bounded region may carry color to clarify state, ownership, mode, or task posture. Area color must carry meaning.

**The Semantic-Only Sage/Clay Rule.** Sage and clay are never decoration. They mean addition or success, and removal or failure. A green that does not mean "added or finished" and a red that does not mean "removed or failed" are forbidden.

**The Tinted-Neutral Rule.** Neutrals are never pure gray. Both themes carry 0.005 to 0.010 chroma toward cool hue 260. The tint is subliminal and load-bearing for cohesion.

## 3. Typography

**Display / Body Font:** Public Sans (with `ui-sans-serif, system-ui, -apple-system, sans-serif`)
**Code / Mono Font:** JetBrains Mono (with `Cascadia Code, Consolas, monospace`)

**Character:** A single humanist sans handles headings, prose, controls, captions, and labels. Monospace supports code, identifiers, and aligned values where fixed-width characters improve scanning. It is a functional contrast, not a decorative "developer vibe."

### Roles

| Role | Font | Size / line | Weight | Use |
|---|---|---|---|---|
| H1 | Public Sans | `4.8rem / 5.6rem` | 600 | Rare screen-level or document-level heading. |
| H2 | Public Sans | `4rem / 4.8rem` | 600 | Major panel or document section heading. |
| H3 | Public Sans | `3.2rem / 4rem` | 600 | Section title inside a full surface. |
| H4 | Public Sans | `2.8rem / 3.2rem` | 600 | Dialog title or high-emphasis panel title. |
| H5 | Public Sans | `2.4rem / 2.8rem` | 600 | Compact panel title, utility page title. |
| H6 | Public Sans | `2rem / 2.4rem` | 600 | Dense subsection heading. |
| Body | Public Sans | `1.6rem / 2.4rem` | 400 | Forms, dialogs, and readable UI copy. |
| Prose | Public Sans | `1.6rem / 2.8rem` | 400 | Agent answers, narration, plans, and other long reading. |
| Body small | Public Sans | `1.4rem / 2rem` | 400 | Navigation rows, menus, inputs, dense rows, and helper text. |
| Caption | Public Sans | `1.2rem / 1.6rem` | 400 | Meta lines, timestamps, fine print. |
| Label | Public Sans | `1.4rem / 2rem` | 500 | Field labels, row titles, toast titles. |
| Button | Public Sans | `1.4rem / 2rem` | 500 | Text inside every button size. |
| Link | Public Sans | `1.6rem / 2.4rem` | 500 | Inline links; underlined. |
| Code | JetBrains Mono | `1.4rem / 2rem` | 400 | Code blocks, diffs, file views, inline code. |

Inline code sits in a `panel` well with the badge radius and a `0.4rem / 0.8rem`
inset. Code blocks use a `2.4rem` inset.

### Named Rules
**The Mono-Is-Scannable-Data Rule.** Use monospace for code, identifiers, branch and worktree names, paths, durations, and aligned values. Mono meta (a branch under a thread title, a duration on a tool row) uses the caption size in `muted`. Keep numerals in Public Sans inside prose or human-facing labels. Tabular data uses `tabular-nums`.

**The Duration Rule.** Live timers and tool-row durations render in mono as `m:ss` (`0:42`, `12:05`), never in parentheses. A sentence that names an ending may use words ("Failed after 1m 02s").

**The No-Ligatures-In-Code Rule.** JetBrains Mono turns `=>` and `!==` into ligatures. Code views, diffs, file views, and the terminal switch ligatures off (`font-variant-ligatures: none`; for Pierre diffs, its font-features variable). A reader must see the characters the agent wrote.

**The Fixed-Type Rule.** Product UI uses the roles above. H1 through H6 serve documents and spacious panels; dense chrome defaults to Body small or Label; conversation reading uses Prose. Do not set arbitrary pixel sizes. Add a named role in Paper first when the existing steps fail.

**The Decimal Rem Rule.** The root font size is `62.5%`, making `1rem` equal to 10px in default browser settings. Express fixed dimensions in rem or em whenever practical, so `12px` becomes `1.2rem`, `32px` becomes `3.2rem`, and `48px` becomes `4.8rem`. Use raw px only for true hairlines, bitmap dimensions, canvas pixels, and sub-pixel optical fixes.

### Text overflow

Text that does not fit its slot fades out over its last `2.4rem` (the `text-fade`
spacing token). Never add an ellipsis, never use `text-overflow: ellipsis`, and
never cut a string with `…` in code. Progress labels such as "Starting thread…"
are not truncation and keep their ellipsis.

- Apply the fade only when the text actually overflows. Text that fits shows no
  fade.
- Put the mask on the clipping container, not on the text node:
  `mask-image: linear-gradient(to right, black calc(100% - 2.4rem), transparent)`.
- Keep icons, counts, shortcuts, and actions in the row fully visible. Only the
  text fades.
- When the full value matters, show it on hover or keyboard focus, or let the
  text wrap where space permits.
- A path shows the file name first in `ink` and the folder after it in `muted`;
  the folder is the part that fades.
- A clamped multi-line block ends in a `2.4rem` bottom fade and a "Show all"
  control, never a trailing ellipsis.

## 4. Iconography

Lucide is Mcode's product icon family. Use `lucide-react` with a 1.5px stroke on
the 24px grid, round caps and joins. Provider marks, file-type icons, action
icons from the vscode-icons set, and operating-system or third-party brand
marks remain their authentic assets. They are identity, not product controls.

Every product icon renders at the 1.5px stroke. Set the stroke once in the
shared icon module, not per call site. Do not import Phosphor or any second
outline library.

The shared module `apps/web/src/components/ui/icon-map.tsx` is the only
product-level alias map. It exports the canonical concepts below with the
documented stroke, size, and mirroring defaults. Feature files import named
concepts from that module rather than inventing aliases. Direct Lucide imports
remain valid for a one-off literal object icon that has no product-wide
meaning; use Lucide's current names, not its deprecated aliases (`CircleAlert`,
not `AlertCircle`). Provider, file-type, operating-system, and third-party
brand assets bypass the map.

### State and style

- One stroke weight in every state. The current destination, a selected mode,
  or a switched-on toggle shows a selected fill behind the icon and an `ink`
  icon. The stroke never gets heavier to show state.
- Resting icons in rows, menus, and ghost buttons use `muted`. Icons on a
  selected or round button use `ink`.
- Filled silhouettes are reserved for status marks and for a persistent
  binary state whose filled form is conventional, such as pinned. Never fill
  an icon merely to make it louder.

### Size and geometry

| Role | Size | Typical use |
|---|---:|---|
| Metadata | 12px | Passive inline facts and low-priority status. |
| Dense optical | 14px | Close glyphs on toasts and tabs, rail tab badges. |
| Compact | 16px | Default toolbar, menu, input, row, and round-button icon. |
| Standard | 20px | Controls in a 40px or larger box. |
| Large | 24px | Touch targets and spacious controls. |
| Display | 32px | Empty-state or teaching glyph only. |

Icons sit in a fixed slot so rows align into lanes: a 16px icon in a 20px slot
in compact rows, a 20px icon in a 24px slot in standard rows. Keep 8px between
an icon and a text label. Icon-only controls use the documented button boxes;
the glyph does not become the hit target.

### Meaning and accessibility

- Pick the most literal familiar symbol. A `GitBranch` means a branch; a
  `GitFork` means a fork. Do not choose a clever metaphor when a domain symbol
  exists.
- One concept uses one icon throughout the app. Record exceptions in the
  shared icon mapping, not inside individual features.
- Do not repeat a type icon on every row of a list whose type is already
  clear, such as a branch icon on every row of a branch picker.
- Decorative icons use `aria-hidden="true"`. Icon-only controls require an
  accessible name and a tooltip. Do not give the same control two competing
  names.
- State never depends on an icon or color alone. Pair it with position, visible
  copy, or accessible status text.
- Use `currentColor` so theme and interaction state come from the parent.
- Directional icons mirror in right-to-left layouts when meaning follows
  reading direction. Object icons such as play, terminal, and provider marks do
  not mirror.

### Canonical product mapping

Use these Lucide concepts unless a neighboring established pattern is more
specific:

| Concept | Lucide icon |
|---|---|
| Add or create | `Plus` |
| Close or dismiss | `X` |
| Search | `Search` |
| Settings | `Settings` |
| More actions | `Ellipsis` |
| Expand or next | `ChevronRight` |
| Collapse or disclose | `ChevronDown` |
| Back | `ArrowLeft` |
| Submit or send | `ArrowUp` |
| Retry or refresh | `RotateCw` |
| Copy | `Copy` |
| Edit | `Pencil` |
| Delete | `Trash2` |
| Confirmed | `Check` |
| Warning | `TriangleAlert` |
| Error | `CircleAlert` |
| Information | `Info` |
| Terminal | `SquareTerminal` |
| Browser | `Globe` |
| Review | `Diff` |
| Files | `Files` |
| Git branch | `GitBranch` |
| Fork | `GitFork` |
| Pull request | `GitPullRequest` |
| Open externally | `ExternalLink` |
| Toggle sidebar | `PanelLeft` |
| Toggle right panel | `PanelRight` |
| Pin | `Pin` |
| Attachment | `Paperclip` |
| Plan | `ListChecks` |
| Build or run | `Hammer` |

## 5. Shape and Elevation

Flat by default. Depth begins with **tonal layering**. The signature move: `page` sits one step below `background` in both themes; panels step further along the ramp. Use quiet hairlines for dense boundaries, toolbars, diff hunks, resize seams, and adjacent rows when tone is insufficient.

### Radius

| Token | Value | Use |
|---|---:|---|
| `badge` | 6px | Badges, inline code, segmented-control segments. |
| `menu` | 8px | Menu rows, tooltips, list rows. |
| `control` | 10px | Buttons, inputs, selects, segmented controls, icon tiles. |
| `composer` | 14px | The composer, menus, popovers, pickers, and floating cards. |
| `dialog` | 18px | Dialogs, sheets, toasts, and floating pills. |
| `full` | 999px | Round icon buttons, the composer Send button, status marks. |

Workspace panes stay square to the app shell.

### Borders and focus

- Dividers and the edges of transient panels are 1px `border`.
- Interactive boundaries (inputs, outline buttons, segmented controls) are 1px
  `control-border`.
- Keyboard focus is a 2px `focus` ring with a 2px offset in the surface
  color, drawn outside the control (`shadows.focusRing`). It never changes the
  control's own size.

### Shadow vocabulary

| Recipe | Value | Use |
|---|---|---|
| None | Tonal separation | Permanent panes and resting content. |
| `popover` | `0 8px 24px` at 24% black | Menus, popovers, pickers, hover cards. |
| `floating` | `0 8px 24px` at 40% black | Toasts and controls that float over content, such as the floating Commit button. |
| `dialog` | `0 16px 48px` at 40% black | Dialogs and sheets. |
| `lightOverlay` | Two soft cool shadows | Every transient layer in the light theme. |

Frontmatter owns the exact shadow values. Feature code references these recipes
and never copies their CSS values locally.

### Named Rules
**The Tonal-Lift Rule.** Separate major surfaces with a step on the lightness ramp. Use `border` for compact internal structure where neighboring elements share a tone or where a resize, diff, toolbar, or row boundary must remain legible.

**The Earned-Elevation Rule.** Permanent panes rely on tone and hairlines. Transient layers use the recipe for their role. Resting content has no decorative shadow.

## 6. App Shell and Layout

Mcode borrows Codex's calm task presentation, shallow chrome, and content-first
conversation. It does not borrow Codex's single-task emphasis. Mcode's shell
must keep several runs legible at once.

### Shell anatomy

The desktop hierarchy has three sibling panes:

1. **Sidebar:** projects, threads, status, and primary navigation.
2. **Conversation:** thread header, narrative, and composer, with the thread
   overview card floating at its top right.
3. **Right panel:** the workspace-global host for Browser, Terminal, Review,
   Plan, Files, Subagents, and Project settings, with a vertical tab rail at
   the window's right edge. Its visibility, width, active tab, and top-level
   tab set persist even when no thread is open. Each tab declares whether its
   content uses workspace or thread scope. Browser and Terminal can use the
   workspace root; Plan requires a thread.

These panes share the app frame. Never wrap them in an outer dashboard card.
The conversation is the visual anchor. The sidebar provides orientation; the
right panel provides inspection. Neither should compete with the thread's
current work.

There is no separate title bar. On Windows and Linux the native caption
buttons overlay the top 48px of the rightmost surface; read their width from
`env(titlebar-area-width)` rather than hard-coding it. On macOS the traffic
lights sit in the sidebar header.

### Calm precision

- Use one bounded task column inside a quiet canvas. Do not stretch readable
  content merely because space exists.
- Keep containment shallow. Make one surface dominant and place supporting
  controls directly on the canvas when they do not need a boundary.
- Separate selection, focus, and activity. A neutral fill selects, the focus
  ring focuses, and Filament Amber marks the primary action, a live mode, or
  a thread that needs the user.
- Align headings, controls, metadata, and trailing values to shared axes.
- Leave unused space empty. Do not fill the canvas with cards, metrics,
  decoration, or duplicate navigation.
- Spend strong contrast on the current task. Peripheral chrome stays legible
  and quiet.

### Pane behavior

- Sidebar width ranges from `22rem` to `34rem` and defaults to `30.4rem`.
  The right panel ranges from `48rem` to `84rem` and defaults to `60rem`; its
  tab rail is `4.8rem` wide, `16rem` when expanded. The thread overview card
  is `28rem` wide. A compact floating inspector defaults to `31rem` and never
  shrinks below `28rem`.
- The composer is `76rem` wide wherever it appears and never resizes between
  the new-thread screen and a running thread. Conversation keeps at least
  `52rem` of usable width. Its prose measure caps at `76rem`; code, diffs,
  tables, and terminal output may exceed that measure inside their own
  scrolling region.
- Sidebar and right panel widths persist per workspace.
- Resize seams are visible on hover and focus, remain at least 1px at rest, and
  implement the keyboard and accessibility contract below.
- Toolbars remain attached to the content they control. Do not add a detached
  global toolbar for a local action.
- Sticky chrome may hold orientation and primary actions. It must not cover the
  first or last readable line, and its background must clearly separate it
  from scrolling content.

### Panel header

Every right panel tab uses the same two-row header. Nothing floats over the
panel's content except one floating primary action when the design calls for
it (the Review panel's Commit button).

- **Row 1** (`4.8rem`) shares the window caption overlay. It holds the tab's
  identity on the left (a view picker, a title pill, or horizontal tabs), a
  drag spacer, and the round expand and panel-toggle buttons on the right,
  clear of the caption buttons.
- **Row 2** (`4rem`) is always present. The tab's operand sits on the left
  (a URL, a branch pair, a working folder, a version picker) and its view
  controls sit on the right as 32px round buttons.

### Responsive posture

Choose posture from remaining usable width. The thresholds below are the
fallback contract when content measurement cannot decide earlier:

| Posture | Layout behavior |
|---|---|
| Wide, `126rem` and above | Sidebar, conversation, and right panel may dock as siblings. |
| Constrained, `76rem` to `125.9rem` | Preserve conversation width; float the secondary pane over the right edge. |
| Narrow, below `76rem` | One primary surface at a time; preserve the same pane state and return path. |

The component stays mounted when practical so selection, scroll, draft, and
terminal state survive posture changes. A width change must take effect during
resize, without close and reopen.

#### Focus, resizing, and announcements

- A posture change does not move focus when the focused control remains visible
  in the same mounted pane. Docking and floating change presentation, not
  interaction identity.
- When a secondary pane becomes full-surface while focus is inside it, keep
  focus on the same control. When the user opens it from another surface, move
  focus to the pane heading or first task control after the transition settles.
- Closing a floating or full-surface pane returns focus to its invoking control.
  If that control no longer exists, return focus to the active thread row or
  the workspace's primary heading, in that order.
- A resize seam is a focusable separator with `aria-orientation="vertical"`
  and current, minimum, and maximum values. Left and Right Arrow resize by
  `1.6rem`; Shift plus Arrow resizes by `4.8rem`; Home and End move to the
  documented minimum and maximum. Direction follows the edge the seam controls.
- Do not announce every pixel during pointer or window resize. After a
  user-initiated keyboard resize, announce the settled width. Announce a change
  to floating or full-surface posture once, through a polite live region, only
  when it changes the focused user's navigation context.

Secondary surfaces use these minimum usable widths before changing posture:

| Surface | Minimum width | Next posture below minimum |
|---|---:|---|
| Plan or tasks | `40rem` | Float, then full-surface. |
| Terminal | `48rem` | Float, then full-surface. |
| Diff or review | `56rem` | Float, then full-surface. |
| Preview | `64rem` | Float, then full-surface. |
| Compact inspector | `28rem` | Full-surface. |

When content needs more width than this table, change posture at the measured
content threshold. Do not squeeze controls, clip labels, or create horizontal
page scroll to preserve docking.

### Layer contract

Use the semantic `layers` tokens from frontmatter. `base` holds normal panes;
`sticky` holds attached headers and composers; `dropdown` holds menus and
popovers; `floatingPanel` holds constrained-layout inspectors; `modalBackdrop`
and `modal` form one modal pair; `toast` reports transient global outcomes;
`tooltip` sits above every interactive layer. Portaled content keeps the layer
assigned to its semantic role. Feature code never invents a numeric z-index.

### Alignment and density

- Pane headers, tabs, filters, and their content use one horizontal axis.
- Repeated rows use 32px as the compact height and 40px as the default height
  (menus, pickers, settings rows). Increase height when a second line, status
  explanation, or direct manipulation needs it.
- Use 8px internal gaps for tightly related controls, 16px within a group,
  24px for panel insets, and 32px between task stages. These are applications
  of the four-point scale, not new tokens.
- Preserve visible hierarchy at 100%, 125%, and 200% zoom. Density may never
  depend on text clipping.

### Canonical compositions

These recipes fix information order and focal contrast. They are authoritative
across features; local variation may change content, not hierarchy.

| State | Sidebar | Conversation or task canvas | Secondary surface | Primary focus |
|---|---|---|---|---|
| Multi-run glance | Project groups, compact thread rows, visible attention labels, one selected row. | Selected thread remains readable but quiet until opened. | Closed unless the selected thread needs inspection. | The run that needs the user. |
| Active run | The row fades to about 55% with a neutral spinner and no status text. | Latest narration and local progress remain near the work; the composer's submit position holds a neutral Stop. | The thread overview shows environment, changes, tasks, and subagents. | Current work and its Stop. |
| Needs the user | Full brightness, amber ring, and a visible label ("Approval required", "Answers required", "Plan ready", "Interrupted"). | The request docks in place of the composer surface. | The overview keeps showing what exists. | The one decision being asked. |
| Finished run | Unopened: green status mark and a green "Finished" line, no fill. | The final answer leads into the end-of-turn changes bar, whose Review action stays neutral. | Review opens only when requested or already active. | The answer and its changes. |
| Failed or disconnected run | Clay status mark plus a visible "Failed" or "Disconnected" line. | Preserve completed output, name the failed boundary, and show what remains safe in one end notice. | Technical detail opens by disclosure without replacing recovery. | One recovery action such as `Retry` or `Reconnect`. |
| Empty workspace | Navigation remains available; no fake activity or metrics. | Center one explanation and one create or connect action in a bounded task column. | Closed. | The first useful setup action. |
| Settings or utility | Utility navigation replaces the project rail and provides `Back to app`. | Center a `72rem` to `80rem` task column; group related rows in shallow tonal cards. | Closed unless a setting needs a focused picker. | The setting currently being changed. |
| Constrained inspection | Preserve selected thread and compact rail where width allows. | Conversation keeps its measure and state. | The same inspector floats at the right edge, then becomes full-surface below its minimum. | The user's current pane, not a replacement picker. |

## 7. Components

### Buttons

Paper's "04 · Components" page holds the full state matrix for every variant.

- **Shape and size:** `control` radius (10px) at every size. Compact is 32px
  (12px inset, 16px icon), default is 40px (16px inset, 20px icon),
  comfortable is 48px (20px inset, 20px icon). Labels use the Button role at
  every size. Dense chrome uses compact; dialogs, forms, and docks use
  default; comfortable is for touch and rare spacious confirmations.
- **Primary:** `primary` fill, `primary-ink` text, `primary-hover` on hover.
  One per state.
- **Outline:** `background` fill, 1px `control-border`, `ink` text, `hover`
  fill on hover. An alternate action beside a primary.
- **Secondary:** `selected` fill, `ink` text, `button-secondary-hover` on
  hover. Everyday neutral actions.
- **Ghost:** transparent with a reserved transparent 1px border so geometry
  never shifts; `hover` fill on hover. Ghost is the default for icon-only
  buttons inside rows and toolbars because most buttons are not primary. Its
  icon is `muted` at rest.
- **Destructive:** `destructive` fill, `destructive-ink` text,
  `button-destructive-hover` on hover. Only for the confirming action of a
  destructive decision.
- **Link:** `link` color, Link role, underlined. No fill.
- **Round icon button:** a 32px circle with the `selected` fill, no border,
  and a 16px `ink` icon. Use it for top-level actions (panel header expand and
  toggle, the thread overview button, canvas header actions) and for every
  view control in a panel header's second row. When it toggles something on,
  the fill becomes `control-border` and the icon stays `ink`. A round button
  that floats over content is 40px and takes the `floating` shadow.
- **Composer Send:** a round primary button. While a turn runs the same slot
  holds Stop: an `ink` circle with a `background`-colored square, never amber
  or red.
- **Split button:** one control with the action on the left and a chevron on
  the right that opens a menu of alternate methods ("Implement v2 ⌄",
  "Commit 3 files ⌄"). The menu lists the alternates by name with their
  shortcuts. A split button is amber only when its action is the state's
  primary.
- **States:** Hover changes the fill. Pressed draws a 2px inset ring in the
  variant's foreground color; no translation. Focus draws the focus ring
  outside the control. Disabled drops to 50% opacity. Loading keeps the width,
  swaps the leading icon for a spinner, and blocks repeat activation.
- **Inline row actions:** per-file and per-row actions inside a row, such as
  revert file, a row's Stop, or a toast's close, use a 24px or 28px ghost or
  round box. The row around them stays the larger target, and adjacent inline
  actions keep at least 4px apart.

### Inputs / Fields
- **Style:** `selected` well, 1px `control-border`, `control` radius, 40px
  default height (32px in dense chrome), 12px inset, Body small text. The
  boundary remains visible in both themes; tone alone is not sufficient on
  the light canvas.
- **Hover:** the border shifts to `muted`.
- **Focus:** the 2px focus ring with a 2px offset outside the field. No
  bounce, no color flash.
- **Error / Disabled / Read-only:** invalid draws an `error` border and an
  error line under the field (icon plus text). Disabled drops to 50% opacity
  and `pointer-events-none`. Read-only keeps the value legible and removes
  the boundary affordance.
- **Search rows** inside menus and pickers are borderless: a 16px search icon
  and the field on the panel surface, sitting above the list.

### Selection controls

- Checkboxes, radio buttons, and switches each have default, hover, focus,
  invalid, and disabled states on the Components page. Checkboxes support a
  three-state (mixed) value for folder rows.
- Off uses a muted track and quiet knob. On uses a stronger neutral track and
  ink knob, plus the control's semantic checked state.
- Do not use Filament Amber for an enabled switch. Amber is appropriate only
  when enabling the setting directly starts, arms, or exposes live work.
- Keep labels and concise consequences beside the control. A switch changes the
  setting immediately; use a checkbox when several choices are submitted as a
  group.

### Segmented controls

A 32px `panel` container with a 1px `control-border` and the `control` radius
holds equal-width segments with the `badge` radius. The active segment has the
`selected` fill and an `ink` Label; inactive segments are `muted` Body small.
Use them for sibling sources of one list (Branches | Pull requests, Local |
Origin) and for view modes (unified | split). Segments show names only, no
counts.

### Cards / Panels
- **Workspace panes:** Edge-to-edge, square to the app shell, and resizable where the user compares or inspects content. Do not wrap a primary work area in a decorative card.
- **Floating cards** (the thread overview, menus, popovers, pickers): `panel`
  fill, 1px `border`, `composer` radius, and the `popover` shadow.
- **Dialogs and sheets:** `panel` fill, 1px `border`, `dialog` radius, and the
  `dialog` shadow.
- **Shadow strategy:** Tonal separation first. Transient panels use the
  recipe for their role.
- **Border:** Quiet hairlines are allowed for dense internal structure. Never a colored side-stripe.
- **Internal Padding:** 8px inside menus and pickers, 16px inside popovers,
  24px inside dialogs and panels. Repeated list rows may use less, while
  writing, reading, and decision surfaces should preserve comfortable
  structure.
- **Containment depth:** A discrete object may use one contained surface. Its
  headers, metadata, body, and actions stay flat inside it. Do not nest cards,
  tonal slabs, rings, and footers to restate the same boundary.

### Responsive Workspaces
- Preserve the component, its state, and its actions across widths.
- Prefer docked pane to floating pane to full-surface takeover. Use a modal only when the interaction itself is modal.
- Choose breakpoints from the component's usable content width, not a device label.
- Recompute posture while the user resizes. Do not require close and reopen.
- Keep one visible toggle for a panel. Do not add a second compact-only control that exposes a different version of the same tool.

### Action Hierarchy
- Give one task one visible control. Put alternate methods in an attached menu or a split button.
- Put persistent actions in persistent chrome. Do not create a second bottom toolbar for an action already available at the top.
- Use a neutral fill for the current selection. Keep amber for the state's one primary action. Secondary toolbar actions stay neutral.
- Keep actions near the object they affect, without creating a panel solely to hold a button.

### Navigation (Sidebar)
- **Style:** Projects-and-threads tree on the `page` surface, drag-reorderable. The first thing the user scans, every time.
- **Thread row:** a status lane, the provider icon, the title in Label (fading
  when long), and a second line with the branch or worktree name in mono
  caption, `muted`. A third line appears only when the thread needs the user,
  failed, or finished unseen.
- **States:** Selection is a full row fill with `selected`, never a left side-stripe. Indentation alone carries tree depth; no nested guide rails.
- **Row priority:** a thread that needs the user outranks a finished one. It
  keeps full brightness, the selected-style fill, an amber ring, and an amber
  label. A finished, unopened thread shows a green mark and a green
  "Finished" line without the fill. A failed thread shows a clay mark and a
  clay "Failed" line. A running thread fades to about 55% with a neutral
  spinner and no text, so the user is not drawn to watch it. A thread the user
  stopped shows nothing. Every attention state clears when the thread is
  opened.

### Status Mark (signature)

The smallest and most important component. An 8px mark in the status lane:

| State | Mark | Visible text |
|---|---|---|
| Needs the user | 8px ring, 1.5px `primary` border | Amber label: "Approval required", "Answers required", "Plan ready", "Interrupted". |
| Finished, unopened | 8px `success` dot | Green "Finished". |
| Failed | 8px `error` dot | Clay "Failed". |
| Running or starting | Neutral spinner; the row at 55% opacity | None; the accessible name says "Running". |
| Idle, stopped, opened | No mark | None. |

The mark always has accessible status text. Color never carries the status
alone. Dark surfaces use `success` and `error`; light surfaces use
`light-success` and `light-error`. The documented status pairs exceed the 3:1
graphical-object threshold against their default canvases: dark success on
`background` is approximately 10.16:1, dark error is 9.17:1, light success on
`light-background` is 5.08:1, and light error is 5.75:1. These calculated sRGB
ratios validate the tokens, not an implementation. Live UI verification must
recheck the rendered mark against its actual surface, including the row fade.

Tooltips may clarify status but cannot be the only source of critical
information. Never add a second colored chip.

### Status-mark placement

Status marks are ambient attention signals, not universal completion ornaments.
Use one when an object appears on a glance surface while its underlying content
is hidden, or when its state changed while the user was elsewhere. Appropriate
uses include a thread in the project tree, a toast, a terminal tab, a subagent
row, a collapsed CI result in the thread overview, and a background run that
completed outside the current view.

Do not use a mark to repeat state already stated by the current section, label,
or open content. A completed item inside `Done`, or a completed detail view,
does not need a green mark solely to restate completion.

When the user opens the object, its local content becomes the primary source of
state. Remove the ambient mark unless ongoing activity or an exceptional state
still needs monitoring. Preserve the state through visible text or accessible
semantics; color and motion remain supplementary.

### Provider identity

Providers are shown by their own icon, never by generic colored badges or
assigned identity colors. Conversation chips and rows use the 16px provider
icon. A stack of subagents in the thread overview overlaps 20px provider discs
on a 12px step, each with a ring in the panel color, and shows at most three;
the text beside it carries the total ("1 active · 7 done"). Subagent threads
are provider-native, so they show the parent thread's provider.

### Conversation and Narrative

- Render the conversation as a readable document, not alternating speech
  bubbles. User prompts may use a restrained tonal block when authorship needs
  emphasis; agent prose stays on the conversation canvas in the Prose role.
- Keep the current run state near the work it describes. Narration, reasoning,
  tool calls, approvals, and final response remain distinct, but they share one
  chronological reading flow. Reasoning renders as a collapsed "Thought" row;
  narration and the final answer render as prose.
- Collapse detail before hiding meaning. A settled tool call may reduce to its
  action, target, outcome, and duration. Its full payload remains available by
  disclosure.
- Parallel sub-agents appear as chips in the flow and open in their own right
  panel tab. Nested tool calls follow
  `docs/internals/conversation/narrative-pipeline.md`. Do not invent a second
  timeline grammar.
- Streaming motion stays local to the newest content. Existing content must not
  reflow or flash as tokens arrive.

### Composer

- The composer is a drafting surface and the strongest persistent object in
  the conversation. It is not a chat bubble or search field. It uses the
  `composer` radius and is `76rem` wide everywhere.
- Keep the draft as the largest hit area. Mode, model, reasoning, access,
  attachments, and capabilities stay visible at the point where they affect
  submission. Before the first send the thread overview hosts the workspace
  and branch selectors; after it, the overview carries mode, branch, and
  tasks.
- Separate configuration from the draft with tone and spacing, not a stack of
  chips. Use chips only for removable attached entities such as files, images,
  comments, or enabled capabilities. Capability chips such as Plan use the
  neutral selected fill.
- The submit control owns pending state. While a turn is running, the same
  location exposes the neutral Stop or queue behavior according to the
  product contract.
- Trays that belong to the composer (the task row, queued messages, the slash
  command list) dock flush on its top edge with the panel fill and no border.
- A request that needs the user (approval, plan questions) docks in place of
  the composer surface and names the waiting state in the status line.

### Tabs and Toolbars

- **Vertical tabs** are the right panel's rail entries: one per panel tab,
  icon-led, with the selected fill on the active entry. Opened subagents
  appear as their own rail entries.
- **Horizontal tabs** live in a panel header's first row (browser pages,
  terminals, open files). The active tab has the selected fill. Hovering a tab
  swaps its leading icon for a 14px close glyph in the same slot, so the tab
  never changes width. When tabs overflow, inactive tabs shrink to `9.6rem`
  with a text fade, the strip scrolls with a right-edge fade, and the new-tab
  button stays pinned.
- Tabs switch sibling views inside one object. They do not duplicate the
  sidebar's thread navigation.
- Toolbars contain direct actions for the visible surface. Keep the common
  action visible, group alternate methods in an attached menu, and send rare
  commands to overflow.
- Icon-only actions keep a stable position across loading and settled states.
  Replace the glyph in place rather than inserting a new control.

### Menus, Pickers, Popovers, Tooltips, and Dialogs

- Menus are command lists. Pickers choose one value from a list. Popovers
  expose lightweight choices or inspection. Dialogs interrupt only for a
  focused decision, destructive confirmation, or work that cannot safely
  remain inline.
- Anchor transient surfaces to their trigger and keep the trigger visible.
- Escape closes the frontmost transient surface and restores focus to its
  trigger.

**Menus.** A floating card with 8px padding and 40px rows (`menu` radius,
12px inset). A row holds the name in Body small and, only when it improves
scanning, a 16px `muted` icon in a 20px slot. Shortcuts sit right-aligned in
`muted` caption. Rows show names only: no descriptions, counts, operands, or
group labels. Groups are separated by 1px dividers. The highlighted row takes
the `hover` fill. A checked row shows a check. Destructive rows use `error`
for icon and label. An unavailable row stays listed and dimmed, and its reason
appears in a tooltip ("Nothing staged"). A submenu opens to the side.

**Menus open to the side.** A menu opened from a row inside a floating card
(the thread overview's workspace or branch row) opens beside the card,
top-aligned to the trigger row, never stacked below it.

**Picker anatomy.** One anatomy for every picker (branch, pull request,
commit, model, project):
1. A borderless search row on top.
2. Segmented tabs under it when the list has sibling sources.
3. A flat list with no section labels and no per-row type icons or counts.
   The selected row shows a trailing check, with a `muted` tag when it helps
   ("current", "worktree"). About five rows are visible; the list scrolls
   with top and bottom fades.
4. Silent paging: more rows load as the user scrolls, and a `muted` footer
   reads "Showing 50 of 568". A search across all history may read
   "N matches in M commits" instead.
5. Optional footer toggles below a hairline ("Start from origin").

States: no match reads `Nothing matches "query"` and offers a one-click switch
when the other tab has matches; a load failure names the failure, shows the
raw cause in mono, and offers Retry.

**Popovers.** A floating card with 16px padding and a heading in Label.
Lightweight inspection and settings only; no command lists.

**Tooltips.** `panel` fill, 1px `border`, `menu` radius, caption text in
`ink`, 32px minimum height, 32rem maximum width, with a small arrow toward the
trigger. A tooltip may show the command's shortcut in keycaps. Every icon-only
control has one; native `title` tooltips are not used.

**Dialogs.** Destructive confirmation names the object and cascade. The
confirming action uses the destructive variant, not Filament Amber.

### Toasts

Toasts report events about something the user cannot see right now. Never
show a toast for the thread on screen.

- **Lane:** top center of the conversation column, 8px under the 48px header,
  centered on the column, not the window.
- **Shape:** `34rem` wide, `selected` fill, `dialog` radius, no border, the
  `floating` shadow, 12px top and bottom, 16px left, 10px right.
- **Anatomy:** a status mark, the title in Label (fading when long), a caption
  meta line (`Finished · 14:32`), and a 24px round close with a 14px glyph.
  The whole toast is the button that opens its object; there is no separate
  View button. Hover lifts the fill to `border`.
- **Lifetime:** a finished event hides after 8 seconds, paused while hovered.
  Needs-you and failed events stay until opened or closed. At most three
  stack, newest on top.
- **Motion:** see Motion and Time.

### Settings and Utility Pages

- A full settings or utility area replaces the project and thread rail with its
  own navigation and a clear route back. Do not nest a second full-height
  navigation rail beside the normal app rail.
- Use a centered task column instead of stretching forms across the available
  workspace. Start near 72rem to 80rem for settings and narrow utility lists,
  then widen only when the content requires comparison.
- Put the page title and optional description above the task column. Routine
  utility pages use the H5 or H4 role, not the H1 display size.
- Group related settings in one tonal card. Put the group label outside the
  card, separate rows with quiet hairlines, and keep larger gaps between groups
  than between rows.
- A setting row places its label and one concise description on the left, then
  its control or current value on the right. Controls align to a stable trailing
  edge.
- Flat lists, filters, and scheduled items remain on the page canvas. Use a
  contained surface only when the group itself needs a boundary.
- Search spans the task column. Segmented filters may sit below it with one
  neutral selected state.

### Tool Results, Diffs, and Technical Data

- Show the human meaning first: command, file, provider, branch, outcome, and
  duration. Keep raw payloads behind disclosure.
- Code and terminal output use the mono stack with ligatures off. Labels
  around them remain Public Sans unless fixed-width comparison improves
  scanning.
- Diff additions use sage plus a `+` or addition gutter. Removals use clay plus
  a `-` or removal gutter. Never rely on red and green alone. Diff lines in a
  compact preview never wrap: they clip with the fade and scroll sideways.
- File identity stays primary. A state marker supplements the file-type icon;
  it does not replace it.
- Long technical output has a bounded region, copy action, and a clear route to
  the full source. Avoid nested scroll areas when one continuous scroll works.

### Loading, Empty, Error, and Success

| State | Treatment |
|---|---|
| Short action under three seconds | Spinner inside the initiating control; keep its label when space allows. |
| First load with known geometry | Skeleton that matches the final rows or blocks. |
| Background refresh | Keep stale content visible; add a quiet local progress cue. |
| Empty first use | Explain the surface and offer one action. |
| Empty filtered result | Name the active filter and offer clear or edit filter. |
| Unavailable data | State the unavailable source and preserve the rest of the surface. |
| Recoverable error | Put technical cause and recovery beside the failed object. |
| Destructive or blocking error | Use a bounded callout or dialog with the affected scope. |
| Success | Update the object in place; use a toast only when the originating object is no longer visible. |

### Failure and interruption journeys

| Journey | Preserve | Explain | Primary recovery |
|---|---|---|---|
| Permission required | Draft, completed output, and triggering context. | The exact capability, target, duration, and consequence of allowing it. | `Allow once`; keep `Deny` beside it as a neutral action. |
| Run stopped by user | Completed output, draft, files already changed, and last settled step. | A quiet "You stopped" line; no fill and no button. | None; Revert this turn lives in the turn's menu. |
| Run interrupted | Completed output and changes. | That Mcode closed while the provider was working. | `Resume`. |
| Run failed | Completed output, partial answer, and changes. | The cause in plain words with its status, raw detail by disclosure. | `Retry`, or `Sign in` or `Switch model` when that is the cause. |
| Provider disconnected | Last confirmed output and local changes. | The provider boundary, last confirmed event, and whether remote execution state is unknown. | `Reconnect`; do not imply rollback. |
| Preview or source is stale | Current content, scroll, and selection. | The last refresh time and source that failed to update. | `Refresh`; keep stale content visibly marked until replaced. |
| Remote outcome unknown | Request identity and last confirmed state. | That repeating the action may duplicate work. | `Check status`; enable `Retry` only when the operation is known to be idempotent. |
| Return after interruption | Draft, pane posture, selection, scroll, and run state. | What changed while the user was away. | The current curated next step, not a generic resume dialog. |

### Empty States (signature)
Empty states explain why content is absent and what can happen next. Match first use, filtered results, completed work, unavailable data, and quiet resting states with suitable compositions. A glyph, diagram, message, or restrained illustration may clarify the state. Use technical copy. Show one nearby action when the user can resolve the condition.

### Next-Step Slot (signature)
The interface expression of the "Anticipate the next step" product principle. When the thread reaches a state with one likely next move, the interface shows it at the seam between the narrative and the composer, in the same place in every thread: a single primary action with any other valid moves beside it as quiet ghost buttons. When there is no next move, the slot collapses to nothing, no empty chrome. Tab remains reserved for focus traversal. When the primary action has focus, Enter or Space activates it. A product-wide command shortcut may also invoke the current next step when its label and binding are visible in the command menu. Safe, single-outcome transitions (add project -> new chat) do not render here; they auto-advance, landing the user on the next surface with one quiet cue, per Quiet-over-loud.

### Named Rules
**The One Next-Step Rule.** Each state elevates at most one primary action in Filament Amber. Everything else stays a quiet ghost. Never two competing primaries; the rarity of the lamp is what makes the suggestion legible at a glance.

**The Curated-Not-Clever Rule.** The next step is a fixed function of state, the same every time. It does not learn, reorder, or guess. Predictability is the feature; a suggestion the user has to second-guess is worse than none.

## 8. Interaction States

Every interactive component defines the following states before implementation:

| State | Required signal |
|---|---|
| Default | Clear affordance without decorative emphasis. |
| Hover | One fill or foreground shift; never the only indication of action. |
| Focus-visible | A 2px focus ring with a 2px offset in the surface color, outside the control. |
| Active or pressed | A 2px inset ring in the variant's foreground color. No translation. |
| Selected or current | The selected fill plus a check marker or semantic state. |
| Disabled | 50% opacity, unavailable cursor behavior, and a reason when the cause is not obvious. |
| Loading | Stable geometry, a spinner in place of the leading icon, and repeat-action prevention. |
| Error | Error color on the boundary, an icon and technical explanation, and recovery when available. |
| Reduced motion | Preserve the same state and information; replace movement with an instant change or short fade. |

The table above owns shared state meaning. The contracts below add semantics and
behavior for components where agents must not invent an interaction model.

### High-risk component contracts

| Component | Semantics | Keyboard and focus | Loading and error | Reduced motion |
|---|---|---|---|---|
| Thread row | `treeitem` inside a labeled `tree`; use `aria-selected` for the viewed thread and `aria-expanded` only on expandable project or group rows. | Up and Down Arrow move between visible rows; Left and Right Arrow collapse or expand groups; Enter opens the focused thread. Keep focus on the row after selection. | Preserve the thread identity and last confirmed state. Show the visible label for every attention state (needs the user, failed, finished unseen); running carries its state in the accessible name. Never disable the whole row because status failed. | The spinner stops and holds a steady ring; the row fade and labels remain. |
| Progress row | A static step is a `listitem`; a row that reveals detail contains a real button with `aria-expanded` and `aria-controls`. | Tab reaches only actionable controls. Enter or Space toggles detail. Restoring a collapsed row returns focus to its disclosure button. | Keep the settled label and elapsed time. A failed step names the boundary and places recovery beside it; loading does not replace earlier steps. | Replace progress shimmer or pulse with a steady icon and text update. |
| Narrative event | An event is an `article` or labeled list item inside one chronological `log`; tool detail uses a disclosure button. | Reading order follows DOM order. Disclosure uses Enter or Space and does not move focus when content opens. | Stream only the newest event. On failure, preserve completed content and append cause plus recovery without rewriting history. | New content appears immediately or with a `fast` opacity fade; no vertical settle. |
| Diff hunk | A labeled region identifies file and hunk; additions and removals include textual `+` and `-` markers. | Tab reaches hunk actions, not every code line. Find and review commands move focus to the target hunk heading. | Keep the last confirmed diff visible during refresh. A stale or failed hunk is labeled and offers `Refresh` without discarding selection. | Reveal or replace the hunk without animated line movement. |
| Review comment | `article` with body and a labeled action group; edit fields use the input contract. Mcode is single-user: no author label, no timestamp on the user's own notes. | Tab follows body actions in visual order. Escape cancels an inline edit and restores focus to Edit; submission returns focus to the updated comment. | Keep the draft and comment context during submission. Put validation or provider failure beside the editor and prevent duplicate submission. | Insert the settled comment without spatial animation; a short opacity fade is optional. |
| Switch | Native checkbox semantics or `role="switch"` with an accessible label, `aria-checked`, and visible consequence text. | Space toggles the focused switch. Do not bind Enter unless the underlying native control already supports it. Focus remains on the switch after change. | Disable repeat input only while persistence is pending. On failure, restore the confirmed value and place the reason beside the control. | The knob changes position instantly; color and checked state still update. |
| Tabs | `tablist`, `tab`, and `tabpanel` with stable IDs and relationships. Use manual activation when changing tabs performs work. | Left and Right Arrow (Up and Down for the vertical rail) move roving focus; Home and End reach the first and last tab; Enter or Space activates. Tab then enters the active panel. | Keep the active tab selected while its panel refreshes. Mark failure inside that panel and retain a retry path. | Replace the active fill instantly; do not slide it between tabs. |
| Pane resizer | Focusable `separator` with vertical orientation and `aria-valuemin`, `aria-valuenow`, and `aria-valuemax`. | Use the resize keys and focus behavior defined in Responsive posture. The seam remains in the tab order whenever resizing is available. | If persistence fails, keep the usable current width for the session and report that it was not saved. Never collapse the pane as a fallback. | Direct resizing is instant. Dock, float, and full-surface transitions use the reduced posture rule. |
| Menu, picker, or popover | Use `menu` and `menuitem` only for commands. Use a labeled listbox for pickers, and form controls or a plain region for inspection. The trigger exposes `aria-expanded` and `aria-controls`. | Opening a menu moves focus to the current or first enabled item; opening a picker focuses its search field. Arrow keys move between items; Home and End reach the boundaries; Enter or Space invokes; Escape closes and returns focus to the trigger. A non-menu popover follows normal tab order. | Keep the trigger stable while an action runs. Prevent duplicate invocation and place a failed action beside its origin; do not leave a dead menu open as a success-shaped fallback. | Use `instant` or a `fast` opacity fade. Do not scale or slide a menu from its trigger. |
| Dialog | Labeled `dialog` with `aria-modal="true"`; destructive scope appears in its accessible description. | Move focus to the first task control, or the least destructive action for a destructive confirmation. Trap focus while open. Escape cancels when cancellation is safe and returns focus to the trigger. | The initiating action owns pending state and blocks duplicates. Preserve entered values. Put validation beside its field and blocking failure in a focusable summary inside the dialog. | Use `instant` or a `fast` opacity fade for dialog and backdrop; remove scale and spatial movement. |
| Toast | A `status` live region for finished events and `alert` for needs-you and failed events; the toast itself is one button named by its title and state, with a separate close button. | Toasts never take focus. A keyboard user reaches them through the region landmark; Enter opens the object, Escape on a focused toast closes it. | A failed open leaves the toast in place. | Appear and leave with a `fast` opacity fade; no slide and no swipe animation. |

Keyboard and pointer interaction share the same state model. Hover-only
controls must also appear on focus-within, and they must remain reachable in a
logical tab order. Avoid making routine row actions permanently visible when
that harms scanning, but never hide them from keyboard or touch users.

Selection, focus, and live status are distinct:

- **Selection** answers "which object am I viewing?" Use the selected fill or tab state.
- **Focus** answers "where will the next keyboard action land?" Use the focus ring.
- **Live status** answers "what is happening now?" On glance surfaces or for
  hidden state, use the status mark and local motion. Open content carries its
  own state and does not repeat a settled ambient mark.

Do not use Filament Amber for all three on the same element.

## 9. Motion and Time

Motion explains state, continuity, and causality. It never decorates a resting
surface.

### Timing

| Token | Duration | Use |
|---|---:|---|
| Instant | 0ms | Reduced-motion replacement and direct state swap. |
| Fast | 120ms | Hover, color, press, and small icon feedback. |
| Standard | 180ms | Menus, popovers, disclosure, and selection. |
| Overlay | 240ms | Dialogs, panels, posture changes, toast entry, and the first-send move. |

Every transition uses one curve, `cubic-bezier(0.2, 0, 0, 1)`. Never use bounce
or elastic easing. Avoid animating width, height, top, or left when a transform
or clip can show the same continuity. Keep content visible by default; motion
enhances a state change and may not gate rendering.

### Product motion patterns

- A running thread's spinner turns once per second, linear. The row fade does
  not animate.
- A new narrative segment enters over `standard` with an opacity fade and a
  small vertical settle. Earlier segments do not replay.
- Pane posture changes preserve the relationship to the right edge through an
  `overlay` transform. Resizing under direct manipulation has no easing.
- Completion updates status. Do not fire confetti, bounce rows, or animate
  several unrelated regions.
- **First send.** The composer is the same width on the new-thread screen and
  in a running thread, so the first send is a vertical move only: the composer
  slides down over 240ms (a transform, not a resize). The heading and hint fade
  out over 0 to 120ms, the new sidebar row fades in over 0 to 180ms, the user's
  message fades in over 120 to 300ms, and the startup steps fade in over 240 to
  420ms. The overview's selectors swap instantly.
- **Toasts.** A toast slides down from under the header with a fade over
  `overlay`. Dragging it sideways makes it follow the pointer and fade with
  distance; releasing past 35% of its width, or a flick, sends it off that
  side in 160ms, otherwise it returns to rest. The stack closes the gap in
  200ms. Close and auto-hide reverse the entry.
- `prefers-reduced-motion: reduce` removes movement and looping animation. The
  composer docks instantly, toasts and messages fade over `fast`, spinners hold
  still, and all information remains available, including visible progress
  text.

Time labels use relative time in compact lists and exact time in tooltips or
details. Durations and aligned timestamps use tabular numerals. Avoid a timer
that causes a whole component tree to render every second.

## 10. Accessibility and Content

### Accessibility floor

- Target WCAG 2.1 AA. Body, placeholder, and muted readable text hold at least
  4.5:1 against their actual surface. Large or bold text holds at least 3:1.
- Every action has a keyboard path. Focus order follows the visual task order,
  and focus remains visible against every theme surface.
- Minimum pointer target is 32px for standalone controls in dense desktop
  chrome. Inline row actions may use the 24px or 28px boxes described under
  Buttons when the row is the larger target and adjacent actions keep 4px
  apart. Use 48px for touch-oriented controls.
- Color, icon, position, motion, and fade supplement text or an accessible
  name; none carries critical state alone.
- Announce asynchronous completion, blocking errors, and incoming permission
  requests through an appropriate live region. Do not announce streaming text
  token by token.
- Preserve useful content at 200% zoom and during text enlargement. A pane may
  change posture, but no action or state disappears.
- Faded text keeps its full value in the accessible name.
- Tooltips describe unfamiliar icon-only actions or clipped values. They do
  not contain required instructions or interactive content.

### Product voice

Write short technical sentences. Lead with the object and outcome:

| Prefer | Avoid |
|---|---|
| `Command failed` | `Oops, something went wrong` |
| `Failed` | `Errored` |
| `Worktree removed` | `Success! Your worktree has been removed` |
| `No files changed` | `Nothing to see here yet` |
| `Retry` | `Try again now` |
| `Delete 4 threads and 1 worktree` | `Are you sure?` |

Use sentence case for labels and headings. Use the domain terms in
`CONTEXT.md`. Do not invent synonyms for thread, turn, worktree, narration,
handoff, or right panel. Button labels begin with a verb. Empty-state headings
state the condition; supporting copy explains the next useful move.

Mcode's users are developers. Keep copy terse:

- Do not add captions that explain ordinary git or developer behavior. A
  toggle such as "Start from origin" stands alone.
- Show a count only where it changes what the user does next, such as a
  pager's "Showing 50 of 568". No decorative counts on tabs, groups, or
  segmented controls.
- Mcode is single-user and local. Do not label the user's own notes "You" or
  stamp them with a time.

## 11. Reference Translation and Agent Checklist

### What to borrow from Codex

- Calm presentation of a run in flight.
- A document-like central task surface with restrained chrome.
- Progressive disclosure for technical detail.
- A strong composer anchored to the work.
- Local, in-place feedback instead of global banners.
- Familiar controls and shallow visual hierarchy.

### What remains distinctly Mcode

- The multi-run sidebar is the primary glance surface.
- Threads expose provider, branch, worktree, status, and diff as first-class
  state.
- Filament Amber on cool slate carries brand identity.
- Public Sans and tabular mono separate human and machine information.
- The right panel supports inspection without turning Mcode into an editor.
- The ambient status mark and the curated next step are signature components.

### External references

A reference is a scalpel, not a template: borrow the one quality named here,
not the whole look.

- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
  defines Codex as a command center for parallel, long-running agent work. Use
  its published product imagery as an interaction and composition reference.
  Codex centers one task and one stream; Mcode holds many runs and optimizes
  for the cross-thread glance.
- [Zed](https://zed.dev) treats performance as a design property: instant
  response, no jank, density without lag. Borrow the discipline behind Mcode's
  targets (sub-2s startup, under 150MB idle, 60fps timeline). Zed is an editor
  with editor chrome; Mcode sits beside the editor.
- [T3 Code](https://github.com/pingdotgg/t3code) is Mcode's closest peer, a
  minimal GUI for coding agents. Borrow its multi-provider control patterns and
  its build discipline (Vite, oxlint, a fast desktop shell). It centers a single
  agent view; the sidebar of runs and the worktree as an object stay Mcode's.
- [Synara](https://github.com/Emanuele-web04/synara), a T3 Code fork, adds
  broader provider coverage and a multi-tab layout for threads, views, and an
  embedded browser. Borrow the tab layout and the provider breadth. Mcode's
  organizing object is the thread on the sidebar, not a tab.
- [Lucide](https://lucide.dev) is the icon API and asset source of truth. It
  documents icon names, deprecated aliases, stroke and size props, and the
  license.
- [awesome-design-md](https://github.com/VoltAgent/awesome-design-md/tree/main/design-md)
  is comparative research, not an authority on the referenced brands. Its
  useful lesson is document completeness: tokens, component recipes, and
  explicit rules must appear together.

### What not to resemble

If a design wants to convert a visitor, it is wrong.

- SaaS dashboards and admin panels: colorful stat chips, the hero-metric
  template, "your week in Mcode" summaries.
- The AI-tool aesthetic: neon or cyan accents on dark, purple-to-blue
  gradients, glassmorphism, gradient text.
- Consumer chat apps: speech bubbles, emoji reactions, "typing..." theatrics,
  soft rounded everything.
- Marketing-page tropes inside the product: oversized hero type,
  tracked-uppercase eyebrows above every section, identical repeating card
  grids, decorative resting shadows, colored side-stripe borders.

### Before an agent changes UI

1. Name the user job and the exact state being designed.
2. Identify the primary surface, current action, and one likely next step.
3. Reuse a component from `apps/web/src/components/ui/` or extend its variants.
4. Use design tokens, the icon map, type roles, spacing scale, and state
   matrix from this file.
5. Specify loading, empty, error, disabled, focus, and narrow-posture behavior.
6. Check that keyboard, pointer, reduced-motion, and accessible-name paths agree.
7. Compare the result with neighboring Mcode patterns and the reference
   translation above. Preserve Mcode when the two differ.
8. Run the live UI checks in `docs/internals/renderer/ui-components.md`, add a focused
   behavior test, and run typecheck.

### Implementation status

The design decisions in this document are complete enough for routine feature
work. The codebase is still migrating toward them; the foundation brief in
`docs/plans/ready-for-build/sections/00-foundation.md` lists each gap and the
ticket that closes it:

- Lucide is installed and used across the app at its default 2px stroke.
  `@phosphor-icons/react` is installed and imported by two files; both
  migrate to Lucide and the dependency goes. Do not add new Phosphor imports.
- The shared `icon-map.tsx`, the fade truncation primitive, the round icon
  button, the split button, the picker primitive, and the toast lane do not
  exist yet. Feature work that needs them depends on the matching foundation
  ticket.
- Pane thresholds and layer values in this document are the fallback contract.
  Live measurement may move a posture earlier when real content needs more
  space, but feature code must not invent different global constants.

## 12. Non-negotiable Prohibitions

This section owns system-wide bans. Positive values and behavior stay with their
normative sections; do not copy them here.

- Do not invent spacing, sizing, radius, motion, layer, shadow, or color values
  outside frontmatter. Named optical exceptions must be added there before
  reuse.
- Do not truncate text with an ellipsis, `text-overflow: ellipsis`, a
  line-clamp ellipsis, or a `…` appended in code.
- Do not use a colored side stripe, nested guide rails, gradient text,
  glassmorphism, decorative glow, resting card shadows, hero metrics, or
  decorative charts and grids.
- Do not use raw framework palette colors or literal color values in feature
  code. Semantic tokens own primary, focus, link, success, error, warning,
  info, diff, and status color.
- Do not use color, icon, position, fade, or motion as the only carrier of
  critical state.
- Do not show a provider as a generic colored badge or an assigned identity
  color; use its icon.
- Do not replace object identity with a generic state glyph, expose raw wire
  syntax when a product concept exists, or soften technical outcomes into
  consumer copy.
- Do not add explanatory captions for ordinary developer behavior or counts
  that change no decision.
- Do not duplicate a persistent action, show two primary next steps, or let the
  next step learn, reorder, or guess.
- Do not replace a capable resizable pane with a picker, dropdown, or weaker
  component to accommodate width.
- Do not add marketing whitespace, emoji decoration, promotional type, or
  ornamental color to a task surface.
