# 00 · Foundation: build brief

The shared layer every section builds on. When this ships, the web app's tokens equal the Paper style guide in both themes and use Paper's role names, text fades instead of ending in an ellipsis, icons are one Lucide family at a 1.5px stroke, and every section gets ready primitives: buttons (including the round 32px icon button and the split button), form controls, menus and overlay surfaces, the picker, tooltips, status marks and notices, provider icons, and the toast lane. Lint rules stop raw colours, ellipsis truncation, arbitrary font sizes, raw shadows and numeric z-index from coming back. The last ticket, F-99, reruns every section's retirement proofs and adds a dead-code check to CI.

Surfaces: `apps/web` only (tokens, `components/ui`, shared CSS), `packages/oxlint-plugin` (lint guards), `docs/internals/renderer/ui-components.md`. No contracts, server, provider or desktop changes.

## Boards

Style guide, page "01 · Style guide" (`p-1-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-1-0

| Board | Node | Shows |
|---|---|---|
| Color palette · 50–950 | `7MF-0` | Six ramps: neutral, amber, blue, sage, clay, violet. |
| Named color roles · Dark and light | `7MG-0` | Every role and the ramp step it points at, both themes. |
| Typography · Roles and specimens | `2-0` | H1 to H6, body 16/24, prose 16/28, body-small 14/20, caption 12/16, label, button, link, code 14/20, inline code and code block insets. |
| Layout and interaction | `5-0` | Wide and constrained postures, 760 reading lane, 520 minimum, 310 work tools. Still labels the sidebar 256 (see open questions). |
| Spacing and sizing | `81C-0` | 4px scale 4 to 56 plus 28; control and row sizes 32 / 40 / 48. |
| Shape and elevation | `81D-0` | Radii 6 / 8 / 10 / 14 / 18 / full; 1px border and control border; 2px focus ring with 2px offset; popover and dialog shadows. |
| Iconography | `81E-0` | Lucide, 24px grid, 1.5px stroke, sizes 12 to 32, selected state as a fill tile. |
| States and motion | `81F-0` | Button states (pressed = 2px inset ring), selection with check, feedback colours, 120 / 180 / 240ms on `cubic-bezier(.2, 0, 0, 1)`. |
| Interaction states · Light | `8KN-0` | The same state rules in the light theme. |
| Text overflow · Fade | `J9C-0` | 24px right-edge mask, only when the text overflows. |

Components, page "04 · Components" (`p-5-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-5-0

| Board | Node | Shows |
|---|---|---|
| Buttons · Dark / Light | `8O1-0` / `8O2-0` | Six variants (primary, outline, secondary, ghost, destructive, link) × six states. |
| Buttons · Sizes and composition | `8O3-0` | 32 / 40 / 48, insets 12 / 16 / 20, icon placement. |
| Buttons · Composer Send | `93N-0` | Round primary Send at three sizes and all states. |
| Inputs · Dark / Light | `9KK-0` / `9QI-0` | Text input and textarea states and sizes. |
| Selection controls · Dark / Light | `9WN-0` / `A7A-0` | Checkbox, radio, switch states. |
| Pickers · Dark / Light | `AHR-0` / `ASN-0` | Select, searchable dropdown, segmented control. |
| Labels · Dark / Light | `B4I-0` / `BF4-0` | Badges, thread markers and spinner sizes, PR and CI indicators, attachment tiles. |
| Navigation · Tabs · Dark / Light | `CUF-0` / `E1K-0` | Vertical rail tabs, horizontal tabs, quiet contextual navigation. |
| Overlays · Menus, popovers and tooltips · Dark / Light | `HZC-0` / `HZD-0` | Menu item states, menu surfaces, popovers, tooltip variants and placements. |
| Overlays · Dialogs · Dark / Light | `IJA-0` / `IJB-0` | Form, confirmation and base dialogs. |
| Feedback · Dark / Light | `JHK-0` / `JHP-0` | Notices and recovery, toasts (old card style), loading, empty states. |
| Model picker · Polished · Dark / Light | `189C-2` / `190D-2` | The newest picker and menu surface recipe. |

Screens used as primitive evidence, page "05 · Ready for build" (`p-6-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0

| Board | Node | Shows |
|---|---|---|
| 03b · Branch picker · States · Dark | `2BP1-2` | Picker anatomy: search row, segmented tabs, flat list, check, "Showing x of y", footer toggle, no-match and failure states. |
| 10a · Review · Turn view · Revert file · Dark | `2241-2` | Round 32 icon buttons at rest (selected fill) and on (control-border fill). |
| 09a · Toast · Another thread finished · Dark | `25IT-2` | Toast recipe (node `25R2-2`). |
| 09b · Toast · Events and stacking · Dark | `2DN0-2` | Toast kinds and stacking. |
| 09f · Toast motion · Click, hover, swipe away · Dark | `2DSS-2` | Toast motion. |
| 04g · Thread starting · First send motion · Dark | `2CQU-2` | First-send keyframes. |
| 05a · Running · Tools streaming · Dark | `213P-2` | Running sidebar row at 55% with a neutral spinner (node `2156-2`); mono meta at 12/16. |
| 06f · Another thread needs approval · Dark | `200I-2` | Needs-you ring, 8px, 1.5px amber border. |
| 08d · Finished in the background · Dark | `207O-2` | Finished 8px green dot and green "Finished" line. |

## Locked decisions

From `source/screen-pass-todo.md` and `source/implementation-notes.md`. Not reopened here.

- Paper is the source of truth for values, for example sidebar 304 (screen pass, open decisions).
- Truncation fades the last 24px (`--spacing-text-fade`), never an ellipsis, only on text that overflows (2026-10-07).
- Ghost is the default icon button: transparent 1px border at rest (2026-10-06).
- Top-level and floating icon buttons are 32px circles with the selected fill and an ink icon; switched on, the fill is `--color-control-border` (2026-10-07, 08c and 10a).
- One amber primary per state. Links use the link colour, never amber (2026-10-06).
- Full access and Stop are neutral: Full access is a muted icon and label; Stop is an ink circle with a background-colour square (2026-10-07). The access picker's selected row is neutral (2026-10-07). The Plan chip is neutral, never amber (implementation notes, plan mode).
- A thread that needs the user is never faded: full brightness, amber ring, visible label. It outranks a finished thread, whose 8px green dot and green "Finished" line have no fill. An active thread fades to about 55% with a spinner and no text (2026-10-07).
- Menus list names only, in groups split by dividers, with shortcuts muted on the right; unavailable items stay listed, dimmed, with the reason in a tooltip (10b, 11c, 2026-10-07).
- Picker anatomy: search row, segmented tabs for sibling sources, flat list with no row icons, counts or captions, check on the selected row, silent paging with "Showing x of y", scroll fades (03b, 10e, 2026-10-07).
- Panel headers have two rows: row 1 (48) shares the window caption overlay, row 2 (40) holds per-tab controls as round 32px buttons; nothing floats over content except one floating primary (11c, approved 2026-10-07).
- Menus opened from the thread overview open to the side of the card, top-aligned to the trigger row (03c to 03e, 2026-10-07).
- Subagents show the provider icon, never generic coloured badges; overview stacks show at most 3 overlapping 20px discs on a 12px step and the text carries the total (2026-10-07).
- Developer-terse copy: no captions for obvious git or dev behaviour, no decorative counts, no "You" or timestamps on the user's own notes (2026-10-06 and 2026-10-07).
- Visible "Errored" becomes "Failed" everywhere, toasts included (implementation notes, 08f).
- Durations are mono `m:ss` with no parentheses (2026-10-07). Prose is 16px, code 14px (2026-10-07).
- JetBrains Mono ligatures are off in code views (implementation notes, approvals).
- Toast: selected fill, radius 18, no border, `#00000066 0 8px 24px`, 340 wide, padding 12/10/12/16, top centre of the conversation column, whole toast is the button, Finished hides after 8s (paused on hover), needs-you and Failed stay, max 3 newest on top; enter 240ms `cubic-bezier(.2, 0, 0, 1)`, swipe exit 160ms past 35% or on a flick, stack reflow 200ms (09, 09f, 2026-10-07).
- First send: composer 760 everywhere, translateY 240ms `cubic-bezier(.2, 0, 0, 1)`; heading and hint fade 0 to 120ms; sidebar row 0 to 180; message 120 to 300; steps 240 to 420; overview selectors swap instantly; reduced motion docks instantly with 120ms fades (04g, 2026-10-07).
- Theme: dark first, light later (assumed until told otherwise). Primitives still ship both themes because the token contract is shared.

## How it works today

### Tokens (`apps/web/src/index.css`)

- Theme variables use shadcn names: light `:root` at `index.css:10`, `.dark` at `index.css:88`, Tailwind mapping in `@theme inline` at `index.css:149`. Names: `--page`, `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--primary-foreground`, `--secondary`, `--muted`, `--muted-foreground`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--link`, `--chart-1..5`, `--sidebar-*`, `--diff-*`, `--subagent-identity-1..5`. Verified.
- Name collision (verified): code `--muted` is a surface (dark `oklch(0.22 ...)`, the Paper hover fill) while Paper `--color-muted` is the muted text colour. Copying a Paper value into a code `muted` utility gives invisible text.
- Value drift (verified): light `--ring` is amber `oklch(0.52 0.17 75)` (`index.css:34`), Paper light focus is blue-600. Dark `--primary-foreground` is white `oklch(0.985 0 0)` (`index.css:99`), Paper primary-ink is neutral-900, so the primary button's label fails the documented pairing in dark. Dark `--foreground` is `oklch(0.93 0 0)` with no hue (`index.css:93`), Paper ink is `oklch(0.955 0.005 260)`. Light `--foreground` 0.18 vs Paper 0.19 (`index.css:18`). Light `--card` 0.985 vs Paper panel 0.99 (`index.css:19`). Light `--destructive` chroma 0.245 vs Paper 0.19 (`index.css:31`). `--input` is a fill in dark (0.24) and a border in light (0.90) (`index.css:33,108`).
- Missing roles (verified): no `control-border`, `success`, `error`, `warning`, `info`, `pr-merged`, `primary-hover`, `destructive-ink`, `button-secondary-hover`, `button-destructive-hover`, `text-fade` spacing, size tokens, motion tokens, shadow recipes or layer tokens.
- Unused (verified): `--chart-*` and `--sidebar-*` appear only in `index.css` (`rg -l "chart-[1-5]|sidebar-primary|bg-sidebar" apps/web/src` returns only `index.css`).
- Type: `--text-sm--line-height: 1.6rem` and `--text-base--line-height: 2rem` (`index.css:154,156`), Paper body-small is 14/20 and body 16/24. No prose, label or code roles. `--font-mono` is `"SF Mono", "Cascadia Code", "Consolas", monospace` (`index.css:170`) although JetBrains Mono is bundled (`apps/web/src/main.tsx:3`, `apps/web/package.json:22`) and is the terminal default (`packages/contracts/src/models/terminal-settings.ts:22`). Public Sans loads from Google Fonts at runtime (`index.css:1`).
- Literal colours outside the theme blocks: selection and scrollbar tints and slider focus (11 lines between `index.css:749` and `index.css:858`), plus `.glow-primary` (`index.css:648`).
- Easing: eight different curves across CSS and TSX; the most common are `cubic-bezier(0.22,1,0.36,1)` (28) and `(0.25,1,0.5,1)` (13), plus `ease-out` (26) and `ease` (17). Paper uses one curve.

### Primitives (`apps/web/src/components/ui`)

- Button (`button.tsx:8-43`): sizes `xs`, `sm`, `default` are all 32px; `md` 48, `lg` 56; icon sizes `icon-xs`, `icon-sm`, `icon` all 32. Paper is 32 / 40 / 48. Destructive is a 10% tint (`button.tsx:20-21`), Paper fills it. Press is `active:translate-y-px` and focus is `ring-3 ring-ring/50` (`button.tsx:9`), Paper uses a 2px inset ring and a 2px offset focus ring. No round variant, no split button. Usage: `size="sm"` 165, `xs` 89, `icon-xs` 78, `icon-sm` 26, `icon` 5; `variant="ghost"` 270. 443 raw `<button>` elements in 156 files.
- Menus (`dropdown-menu.tsx:37,59`): `rounded-lg` (10) surface, 4px padding, about 28px rows, highlight with `bg-accent` (the selected fill), `shadow-md`. Paper: radius 14, padding 8, 40px rows, hover fill, popover shadow. 15 files use `DropdownMenuContent`, 24 use `PopoverContent`, 6 use `SelectContent`, 15 use cmdk lists.
- 15 files hand-roll overlay surfaces with `bg-popover` outside `components/ui`: 14 in the F-07a ledger row, plus `Toast.tsx`, which F-07b deletes.
- Tooltip (`tooltip.tsx:60-63`): inverse by default (`bg-foreground text-background`) with zoom and slide entry. Paper's first variant is the surface tooltip; motion is a fade.
- Toast (`components/Toast.tsx:96`, `stores/toastStore.ts:4,33`): levels `error` and `info`, bottom-right, 5s default, `line-clamp-2` message. 28 files reference toasts.
- No fade primitive. Four ad-hoc masks with different widths: `ComposerAddMenu.tsx:46` (1.5rem), `SlashCommandPopup.tsx:238` (2.5rem), `ThreadOverview.tsx:1597`, `ProjectTree.tsx:2601`. `PathLabel.tsx:17` uses an rtl ellipsis trick. `WorktreePicker.tsx:127` cuts paths in code.
- Truncation: `truncate` on 195 lines; `line-clamp` 6; 201 lines in 99 files in total (excluding tests).
- Provider icons: four separate provider-to-icon maps, two of them recolouring marks with raw palette classes: `ModelSelector.tsx:50-58` (Copilot violet, OpenCode violet, Gemini sky), `ProjectTree.tsx:2219-2228`, `ModelSection.tsx:38-44`, `CoordinationPanel.tsx:51`. Subagents use coloured identity glyphs (`ui/SubagentIdentityGlyph.tsx`, `--subagent-identity-*` at `index.css:63,136`, `.subagent-identity-glyph`).
- Status: `ThreadStateMarker.tsx:16,32` labels "Errored"; also `ThreadFilterDropdown.tsx:12`, `lib/thread-status.ts:96`, `subagent-projection.ts:413` (mapped back to "Failed" at `SubagentsPanel.tsx:94`). Spinners come from `ui/spinner.tsx`, `.spinner-tail-fade` (`index.css:437`), `Loader2` (7 lines, 4 files) and ad-hoc `animate-spin` (13 lines, 11 files).
- Icons: Lucide in 154 files at its default 2px stroke, with 46 explicit `strokeWidth` props from 1.25 to 3. Deprecated Lucide aliases in use: `AlertCircle` 16, `AlertTriangle` 4, `MoreHorizontal` 4, `Loader2` 3, `Code2` 3, `XCircle` 2, `TerminalSquare` 2. Phosphor in 2 files (`TerminalSearchShelf.tsx:16`, `PreviewErrorPanel.tsx:10`).
- Raw values in TSX (excluding tests and `performance/`): raw Tailwind palette colour classes 203 lines in 38 files (top: `PreviewPanel.tsx` 53, `lib/file-icons.tsx` 31, `ImageAttachmentLightbox.tsx` 19, `ProjectActionControl.tsx` 13); hex 40 in 12 files; `rgb()` 23 in 2 files; `oklch()` 3 in 2 files; arbitrary colour classes 16 in 5 files. Arbitrary font sizes `text-[Npx]` 154 in 51 files (`10px` 44, `11px` 44, `10.5px` 21, `13px` 17, `11.5px` 10). Numeric z-index 81 lines in 41 files. Tailwind shadow utilities 153 lines.
- Sidebar width: `w-72` (288) at `Sidebar.tsx:87` and `SIDEBAR_WIDTH_PX = 288` at `lib/composer-layout.ts:9`; not resizable (inferred from the fixed class).

### Tooling

- `bun run lint:deadcode` runs knip (`package.json:27`, devDependency at `package.json:53`), but there is no knip config and knip is not installed in this worktree, so no baseline was taken. It is not in CI (`.github/workflows` has no knip step).
- `packages/oxlint-plugin` holds Mcode lint rules wired in `.oxlintrc.json:32-36`; `mcode/no-native-title-tooltip` is the prior art for UI guard rules (test: `packages/oxlint-plugin/src/__tests__/no-native-title-tooltip.test.ts`).
- `@fontsource-variable/geist` is a dependency (`apps/web/package.json:21`) with no import in `apps/web/src` (verified by `rg`).
- `docs/internals/renderer/ui-components.md:40-47` documents the old button sizes.

## Gap table

### Style guide drift (Paper vs DESIGN.md before this pass vs code)

DESIGN.md now matches Paper; the "DESIGN.md" column records what it said before this pass.

| Design element | Paper | DESIGN.md (before) | Code today | Change | Layers |
|---|---|---|---|---|---|
| Token names | Role names: page, background, panel, hover, selected, border, control-border, ink, muted, primary, primary-hover, primary-ink, destructive, destructive-ink, focus, link, success, error, warning, info, pr-merged, diff-add-bg, diff-remove-bg; light pairs `--color-light-*` | slate-page, slate-card, amber-primary, cool-ring, patina-sage, oxide-clay ... | shadcn names, `muted` collides | Rename to Paper names (F-01b) | web |
| Ramps | neutral, amber, blue, sage, clay, violet, 50 to 950 | none | none | Add ramps (F-01a) | web |
| Dark ink | neutral-100 `0.955 0.005 260` | same | `0.93 0 0` | Fix (F-01a) | web |
| Dark primary text | neutral-900 | amber-ink `0.15 0.005 260` | white `0.985 0 0` | Fix (F-01a) | web |
| Light focus | blue-600 | cool-ring-light `0.52 0.17 264` | amber | Fix (F-01a) | web |
| Light primary text, destructive text | neutral-50 `0.99 0.005 260` | `0.985 0 0` | `0.984 0 0` | Fix (F-01a) | web |
| Light muted / control border | neutral-400 `0.50 0.010` / neutral-300 `0.65 0.005` | `0.5 0.005` / `0.65 0.01` | muted text `0.5 0.005`, no control border | Fix (F-01a) | web |
| Light ink, panel, selected | `0.19` / `0.99` / neutral-100 `0.955` | `0.19` / `0.99` / `0.95` | `0.18` / `0.985` / `0.95` | Fix (F-01a) | web |
| Light destructive | clay-600 `0.577 0.19 27.3` | `0.577 0.19 27.3` | `0.577 0.245 27.325` | Fix (F-01a) | web |
| Warning, info, merged PR, secondary and destructive button hovers | Defined | Missing | Missing | Add (F-01a) | web |
| Type scale | body 16/24, prose 16/28, body-small 14/20, caption 12/16, label 14/20/500, button 14/20/500, link 16/24/500, code 14/20 | body-md 16/20, body-sm 14/16, body-lg 20/24, mono-data 12/16 | `text-sm` 14/16, `text-base` 16/20, no prose/label/code roles; 154 arbitrary px sizes | Roles (F-01a), sweep (F-11b) | web |
| Mono font | JetBrains Mono | JetBrains Mono first | SF Mono first, no JetBrains | Fix stack, ligatures off in code (F-01a) | web |
| Radius | 6 badge, 8 menu, 10 control, 14 composer, 18 dialog, full 999 | sm/md/lg/xl/2xl same values, no roles; floating panels 14, dialogs 14 | same values, Tailwind names | Role names (F-01a); dialogs 18 (F-04a) | web |
| Spacing | 4 to 56 plus 28; compact-row 8, group 16, task-stage 32, workspace 32, text-fade 24 | Tailwind steps, no 28, no named roles | `--spacing: 0.4rem` | Add named roles (F-01a) | web |
| Control and row sizes | 32 / 40 / 48 | button 32 / 48 / 56 | 32 / 48 / 56, three aliases at 32 | Fix (F-03) | web |
| Focus ring | 2px ring, 2px offset | 3px 20% glow, separate offset recipe | `ring-3 ring-ring/50` | One recipe (F-01a, F-03, F-12) | web |
| Pressed | 2px inset ring | `active:translate-y-px` | translate | Fix (F-03) | web |
| Elevation | popover `0 8 24` 24% black; dialog `0 16 48` 40% black | floatingPanel `0 4 8` 22% | `shadow-md`, `shadow-lg`, `shadow-xl` | Recipes (F-01a), sweep (F-11a) | web |
| Popover and menu surface | panel, 1px border, radius 14, padding 8 (menus) / 16 (popovers) | slate-card, control-border, radius 14, padding 12 | radius 10, padding 4, `bg-popover`, `shadow-md` | F-04a | web |
| Icon family | Lucide, 1.5px stroke, 24 grid, selected = fill tile, same weight in every state | Phosphor, bold for active | Lucide at 2px, Phosphor in 2 files | F-08 | web |
| Icon sizes | 12 / 16 / 20 / 24 / 32 | plus optical 14 and 18 | ad hoc | Keep 14 as the one optical size (F-08) | web |
| Motion | 120 fast, 180 standard, 240 overlay, one curve `(.2, 0, 0, 1)` | 120 / 180 / 240 deliberate, productive and narrative eases, 1600 pulse | eight curves, durations 90 to 2400 | Tokens (F-01a), sweep (F-11b) | web |
| Layout | sidebar 304, conversation min 520, reading 760, inspector 310, rail 48, rail expanded 160, wide 1260, constrained 760 | sidebar 256, no rail tokens | sidebar 288 fixed | F-01a constant; resizing is section 01 | web |
| Text overflow | 24px right-edge fade when overflowing | not covered | `truncate` ellipsis, 4 ad-hoc masks | F-02 | web |
| Round 32 icon buttons | selected fill, ink icon, on = control-border fill | not covered | none | F-03 | web |
| Selected state | selected fill plus check marker, neutral | slate-accent | `bg-accent` | F-01b, F-04a | web |
| Status marks | 8px dot or 1.5px amber ring; running row 55% with neutral spinner | 6px dot, amber pulsing running dot | `ThreadStateMarker`, "Errored" | F-10 | web |
| Amber discipline | one primary per state; Full access, Stop, Plan chip, access picker neutral; links blue | One Lamp rule without those cases | Plan chip amber (`ComposerCapabilityChip.tsx:30-32`, per implementation notes) | DESIGN.md updated; chip is section 07 | web |
| Light theme pairs | full pair table on `7MG-0` | partial | partial and drifted | F-01a | web |

### Primitive gaps

| Design element | Today | Change | Layers |
|---|---|---|---|
| Fade truncation | ellipsis everywhere | `.text-fade` utility and `PathText`, overflow-only mask, lint guard | web, lint |
| Round icon button, split button | none (`PrSplitButton` is PR-specific) | Button variants | web |
| Menu rows, side-opening menus, disabled-with-reason | 28px rows, no side placement | Menu primitive | web |
| Picker | eight hand-built pickers | `Picker` primitive with segmented tabs and silent paging | web |
| Tooltip | inverse, zoom | surface default, fade, keycaps | web |
| Toast lane | bottom-right card, levels | top-centre floating pill, kinds, swipe, stack of 3 | web |
| Provider icons | four maps, recoloured marks, identity glyphs | one `ProviderIcon` and `ProviderDiscStack` | web |
| Status mark, notice | marker plus eight banners | `StatusMark`, `Spinner`, `Notice` | web |
| Radio | hand-rolled in 2 files | `RadioGroup` | web |

## Backend architecture

None. The foundation is renderer-only: no contract, server, database, provider or desktop change.

The one provider-shaped piece is the provider icon (F-06). Decision per adapter:

| Provider | Adapter change | UI decision |
|---|---|---|
| Claude | No change | `ProviderIcon` renders the authentic mark; `--color-provider-claude` (`#D97757`) is the mark's own colour. |
| Codex | No change | Authentic mark in `ink`. |
| Cursor | No change | Authentic mark. |
| Copilot | No change | Authentic mark; drop the violet recolour (`ModelSelector.tsx:53`). |
| Devin (ACP) | No change | Authentic mark. |
| OpenCode | No change | Authentic mark; drop the violet recolour (`ModelSelector.tsx:55`). |

Gemini also has a mark (`ProviderIcons.tsx:96`) for model listing; it moves into the same component without its sky recolour.

## Components

### New

| Component | Where | Notes |
|---|---|---|
| `.text-fade`, `.text-fade-lines-*`, `PathText` | `index.css`, `components/ui/path-text.tsx` | F-02. Overflow-only mask; path shows name in ink, folder muted and fading. |
| `IconButton` round variant, `SplitButton` | `components/ui/button.tsx`, `components/ui/split-button.tsx` | F-03. |
| `Menu` row anatomy | `components/ui/dropdown-menu.tsx`, `context-menu.tsx` | F-04a. Names-only rows, dividers, muted shortcuts, disabled reason. |
| Overlay surface recipe and side placement | `components/ui/popover.tsx`, `dialog.tsx`, shared positioning helper | F-07a. Side placement aligns the surface top to the trigger row minus 4px and opens beside a boundary element. |
| `Picker`, `SegmentedControl` | `components/ui/picker.tsx`, `components/ui/segmented-control.tsx` | F-04b. |
| `ProviderIcon`, `ProviderDiscStack` | `components/ui/provider-icon.tsx` | F-06. |
| `Toast` lane and store | `components/ui/toast.tsx`, `stores/toastStore.ts` (rewritten) | F-07b. |
| `icon-map.tsx` | `components/ui/icon-map.tsx` | F-08. |
| `Kbd` (moved) | `components/ui/kbd.tsx` from `palette/Kbd.tsx` | F-09, used by tooltips and menus. |
| `StatusMark`, `Notice` | `components/ui/status-mark.tsx`, `components/ui/notice.tsx` | F-10. |
| `RadioGroup` | `components/ui/radio-group.tsx` | F-12. |
| Lint rules | `packages/oxlint-plugin/src/rules/` | `no-ellipsis-truncation` (F-02), `no-raw-color`, `no-raw-shadow` (F-11a), `no-arbitrary-text-size`, `no-numeric-z-index` (F-11b). |

### Changed

`button.tsx`, `input.tsx`, `textarea.tsx`, `checkbox.tsx`, `switch.tsx`, `select.tsx`, `dropdown-menu.tsx`, `context-menu.tsx`, `popover.tsx`, `dialog.tsx`, `tooltip.tsx`, `badge.tsx`, `spinner.tsx`, `skeleton.tsx`, `collapsible.tsx` and `animated-collapsible.tsx` (motion tokens only), `index.css`, `docs/internals/renderer/ui-components.md`.

### Paper "04 · Components" inventory against code

| Paper component (board) | Code today | Status | Owner |
|---|---|---|---|
| Buttons, six variants, three sizes (`8O1-0`, `8O2-0`, `8O3-0`) | `ui/button.tsx` | Exists, drifted | F-03 |
| Round icon button (screens, `2241-2`) | none | New | F-03 |
| Split button (screens 07e, 10d) | `chat/PrSplitButton.tsx` only | New generic; PR one migrates | F-03 |
| Composer Send (`93N-0`) | composer submit control (inferred: `features/conversation/composer/ComposerStatusStrip.tsx` area) | Exists, restyle | Variant F-03; placement sections 03 and 05 |
| Text input, textarea (`9KK-0`, `9QI-0`) | `ui/input.tsx`, `ui/textarea.tsx` | Exists, drifted (32 default, glow focus) | F-12 |
| Checkbox, switch (`9WN-0`, `A7A-0`) | `ui/checkbox.tsx`, `ui/switch.tsx` | Exists, restyle; checkbox needs mixed state | F-12 |
| Radio (`9WN-0`) | hand-rolled in `ProjectEnvironmentPanel.tsx:317,358` and the plan wizard's `plan-questions/OptionTile.tsx:127` | New primitive | F-12; the wizard's radio retires with the wizard in S07-09 |
| Select (`AHR-0`) | `ui/select.tsx` | Exists, restyle | Trigger F-12, list F-04a |
| Searchable dropdown (`AHR-0`), Model picker (`189C-2`) | `ui/command.tsx`, `settings/SearchableGroupedPicker.tsx`, `settings/SettingsProviderPicker.tsx`, `chat/ModelSelector.tsx` | Replace with `Picker` | F-04b (primitive and settings pickers); F-04c (model picker) |
| Segmented control (`AHR-0`) | `settings/SegControl.tsx` (7 files) | Moves to `ui/`, restyle | F-04b |
| Badges (`B4I-0`) | `ui/badge.tsx` | Exists, reconcile variants | F-10 |
| Thread markers and spinner sizes (`B4I-0`) | `sidebar/ThreadStateMarker.tsx`, `ui/spinner.tsx` | Exists, drifted; board still says "Errored" | F-10 |
| PR and CI indicators (`B4I-0`) | `chat/PrBadge.tsx`, `chat/ChecksPopover.tsx` | Exists | Thread overview section 03 or 04 (inferred), PR sections later |
| Attachment tiles (`B4I-0`) | `chat/FileAttachmentTile.tsx`, `chat/AttachmentPreview.tsx` | Exists | Sections 05, 11 |
| Vertical and horizontal tabs, quiet contextual navigation (`CUF-0`) | `panels/ActivityRail.tsx`; per-surface tab strips | Vertical exists; generic horizontal tabs new | F-05 (section 12) |
| Threads and projects (`CW1-0`) | `features/projects/ProjectTree.tsx`, `ProjectRow.tsx`, `sidebar/Sidebar.tsx` | Exists, restyle | Section 01 |
| Thread hover card (`H1W-0`) | none | New | Section 01 (inferred) |
| Menu items and menus (`HZC-0`) | `ui/dropdown-menu.tsx`, `ui/context-menu.tsx` | Exists, drifted | F-04a |
| Popovers (`HZC-0`) | `ui/popover.tsx` | Exists, drifted | F-07a |
| Tooltips (`HZC-0`) | `ui/tooltip.tsx` | Exists, drifted | F-09 |
| Dialogs (`IJA-0`) | `ui/dialog.tsx` | Exists, radius and shadow drift | F-07a |
| Disclosure (`ITC-0`) | `ui/collapsible.tsx`, `ui/animated-collapsible.tsx` | Exists; motion tokens | F-11b |
| Notices and recovery (`JHK-0`) | eight banners: `CliErrorBanner`, `CompactingBanner`, `HandoffFallbackBanner`, `InterruptedSessionsBanner`, `ProviderUnavailableBanner`, `RetryBanner`, `ThreadWarningBanner`, `ConnectionBanner` | Replace with `Notice` | F-10 for `CliErrorBanner`, `HandoffFallbackBanner`, `ProviderUnavailableBanner`, `ThreadWarningBanner` and `ConnectionBanner`. `CompactingBanner` becomes a status-line state in S05-02; `RetryBanner` and `InterruptedSessionsBanner` retire in the section 05 and 08f ledgers |
| Toasts (`JHK-0`, superseded by 09 boards) | `components/Toast.tsx`, `stores/toastStore.ts` | Replace | F-07b |
| Loading and progress (`JHK-0`) | `ui/skeleton.tsx`, `ui/spinner.tsx`, `.spinner-tail-fade`, `Loader2` | Consolidate | F-10 |
| Empty states (`JHK-0`) | `panels/PanelEmptyState.tsx` | Exists | Sections |
| Composer, composer controls, composer context (`KUV-0`, `M9R-0`, `ST1-0`, `T5A-0`, `TQN-0`) | `features/conversation/composer/*`, `chat/Composer*`, `SlashCommandPopup`, `FileTagPopup`, `EntityToken`, selection comment components | Exists, restyle | Sections 03, 05, 06, 07 |
| Chat header (`WUI-0`) | `chat/HeaderActions.tsx`, `chat/ThreadTitleEditor.tsx` (inferred) | Exists, restyle | Sections 03, 05 |
| Thread overview · Ship lane (`ZEJ-0`) | `chat/ThreadOverview.tsx` | Exists, restyle | Sections 03, 04, 05, 12 |
| Message blocks (`11GK-0`) | `messages/MessageBubble.tsx`, `narrative/TurnFooter.tsx`, `narrative/PersistedTurnFooter.tsx` | Exists, restyle | Sections 05, 08 |
| Tool-call rows (`129W-0`) | `narrative/*`, `chat/tool-renderers/*`, `chat/ToolCallCard.tsx` | Exists, restyle | Section 05 |
| Approval dock (`13F0-0`, `138A-0`) | `chat/PermissionRequestCard.tsx` | Replace | Section 06 |
| Diff summaries (`15OZ-0`) | `chat/TurnChangeSummary.tsx` | Exists, restyle | Section 08 |
| Sidebar footer, notifications and updates (`1E8W-0`) | `sidebar/UpdateIndicator.tsx`; no bell | Exists plus new | Sections 01, 09 |
| Summary boards: Fields and control patterns (`3-0`), Navigation and overlays (`LB-0`), Agent work (`4-0`), Workspace chrome and overview (`1VW-0`), Light theme components (`6-0`) | n/a | Older overview boards superseded by the detailed boards; no build target | None |

Code with no Paper counterpart:

| Code | Decision | Owner |
|---|---|---|
| `ui/SubagentIdentityGlyph.tsx`, `--subagent-identity-*`, `.subagent-identity-glyph` | Retire; provider icon replaces it | F-06 |
| `ui/StackedLayersIcon.tsx`, `.stacked-layers-animated` | Not retired here. F-06 removes its use inside the identity glyph; section 05's status line still has a `layers` icon state (the `RunStatus` sketch in `05-running-turn.md`), and the tool-call `Agent` icon uses it (`tool-renderers/constants.ts:36`) | Section 05 decides |
| `panels/CoordinationPanel.tsx` | Retire (decided) | S12P-02 |
| `features/thread-startup/StartupProgressCard.tsx` | Retire (decided) | S04-03 |
| `chat/PlanQuestionWizard.tsx`, `chat/plan-questions/*`, wizard keyframes | Replace with the question dock | S07-09 |
| `components/ShortcutHelpDialog.tsx` | Keep; Settings · Shortcuts is not designed yet | None (section 15 later) |
| `performance/vlist-react-adapter-prototype.tsx` | Keep. It is a performance probe, still imported by `performance/frontend-renderer-fixture-bridge.ts:22`, and nothing in this design replaces it | None |
| `ui/copy-button.tsx`, `ui/favicon.tsx`, `ui/file-type-icon.tsx`, `ui/scroll-area.tsx`, `ui/separator.tsx`, `ui/label.tsx`, `ui/VirtualRows.tsx` | Keep: structural or identity | None |

### Retirement ledger

Run every proof from the repository root. An `rg` proof passes when it prints nothing (exit 1); `node docs/plans/ready-for-build/tools/graph.mjs ledger-run <ticket>` runs a ticket's `rg` proofs. A `bun` proof passes when it exits 0. Most proofs skip tests (`-g '!*.test.*' -g '!**/__tests__/**'`) because regression tests legitimately name the code they guard against; a stale test still fails typecheck or the test run.

Foundation-shaped retirements that a section ticket owns live in that section's ledger, not here: the project chooser (S02-03), the branch and worktree pickers (S03-05), Review's commit and branch-ref pickers (S10-05), the Pierre diff header's rtl ellipsis (S10-06), `CompactingBanner` (S05-02) and the plan wizard with its `OptionTile` radio (S07-09).

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| shadcn colour names `--card`, `--popover`, `--secondary`, `--accent`, `--input`, `--ring`, `--foreground`, every `*-foreground`, and the utilities built on them | `index.css:10-204`; class occurrences: `text-muted-foreground` 932, `text-foreground` 440, `bg-accent` 88, `ring-ring` 36, `text-popover-foreground` 29, `bg-popover` 27, `bg-card` 24, `bg-foreground` 23, `text-accent-foreground` 22 | Paper role names | F-01b | `rg -n "(-foreground\b\|--(card\|popover\|secondary\|accent\|input\|ring)\b\|\b(bg\|text\|border\|ring\|outline\|fill\|stroke\|divide\|from\|via\|to\|placeholder\|caret\|decoration)-(card\|popover\|secondary\|accent\|input\|ring)\b)" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'`. `bg-muted` and `--muted` are deliberately absent: both survive with Paper's meaning (the muted text colour). |
| `--chart-1..5`, `--sidebar-*` | `index.css:38-50,111-123,191-203` | nothing (unused) | F-01a | `rg -n "(chart-[1-5]\|--(color-)?sidebar(-(primary\|accent\|border\|ring))?(-foreground)?[:)])" apps/web/src` |
| Literal colours in base CSS (selection, scrollbars, slider focus) and the unused `.glow-primary` | `index.css:647-649`, `749-858` | role tokens; nothing for `.glow-primary` (decorative glow is banned) | F-01a | `rg -n "(^\s*[a-z][a-z-]*:[^;]*(oklch\|rgba?)\(\|glow-primary)" apps/web/src/index.css` |
| `--font-mono` without JetBrains Mono | `index.css:170` | `JetBrains Mono, Cascadia Code, Consolas, monospace` | F-01a | `rg -n "SF Mono" apps/web/src/index.css` |
| Unused font dependency `@fontsource-variable/geist` | `apps/web/package.json:21`; no import in `apps/web/src` | nothing | F-01a | `rg -n "fontsource-variable/geist" apps/web/package.json apps/web/src` |
| Sidebar 288 constant | `lib/composer-layout.ts:8-9`, `Sidebar.tsx:87`, floating sidebar `App.tsx:243` | `--container-sidebar` (304) | F-01a | `rg -n "SIDEBAR_WIDTH_PX = 288\|\bw-72\b" apps/web/src -g 'Sidebar.tsx' -g 'composer-layout.ts' -g 'App.tsx'` |
| `truncate` and `text-ellipsis` classes | 194 lines in about 95 files | `.text-fade` | F-02 | `rg -n "((^\|[^-\w.])truncate($\|[^-\w(])\|\btext-ellipsis\b)" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'`. It matches the class only, so names such as `truncatePath` and prose such as "middle-truncate" stay out. |
| `line-clamp-*` ellipsis | `ui/select.tsx:52`, `Toast.tsx:59`, `ImageAttachmentLightbox.tsx:208`, `CoordinationPanel.tsx:236`, `StickyUserMessage.tsx:146`, `SelectedTextCommentsComposerAttachment.tsx:75` | `.text-fade-lines-*` | F-02 | `rg -n "\bline-clamp-" apps/web/src -g '*.{ts,tsx}' -g '!*.test.*' -g '!**/__tests__/**'` |
| Ad-hoc horizontal fade masks | `ComposerAddMenu.tsx:46` (1.5rem), `SlashCommandPopup.tsx:238-239` (2.5rem), `ThreadOverview.tsx:1597` (1.25rem, left edge), `ProjectTree.tsx:2601` (1.5rem on hover) | `.text-fade`, `PathText` | F-02 | `rg -n "(maskImage\|mask-image)[^,]*to[ _]right" apps/web/src -g '!*.css' -g '!**/components/ui/**' -g '!*.test.*' -g '!**/__tests__/**'`. Vertical scroll fades (`MessageList.tsx:486`) and the overview ring mask are not text truncation and stay. |
| rtl ellipsis path trick, code-side path cutting | `features/projects/PathLabel.tsx:17,42`, `chat/WorktreePicker.tsx:127` (`truncatePath`) | `PathText` | F-02 | `rg -n "truncatePath\|direction:\s*\"?rtl" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'` |
| Button size aliases `xs`, `sm`, `icon-xs`, `icon-sm`, `icon`, `md`, `lg`, `icon-md`, `icon-lg` | `button.tsx:25-35`; 363 call sites | `compact`, `default`, `comfortable` and their icon-only boxes | F-03 | `rg -n "^\s+\"?(xs\|sm\|md\|lg\|icon\|icon-(xs\|sm\|md\|lg))\"?:" apps/web/src/components/ui -g 'button.tsx'`, then `bun run --cwd apps/web typecheck` proves no call site still passes a removed size |
| Destructive tint on Button | `button.tsx:20-21` | filled destructive | F-03 | `rg -n "bg-destructive/10" apps/web/src/components/ui -g 'button.tsx'` |
| Translate press and 3px focus glow outside the form controls | `translate-y-px`: `button.tsx:9`, `ThreadOverview.tsx:230`, `SidebarRevealButton.tsx:77`; `ring-3`: `button.tsx:9`, `TerminalSection.tsx:37`, `ProjectEnvironmentPanel.tsx:97`, `SelectedTextCommentsComposerAttachment.tsx:257,486` | 2px inset press ring, 2px focus ring with 2px offset | F-03 | `rg -n "translate-y-px\|\bring-3\b" apps/web/src -g '!**/components/ui/{input,textarea,checkbox,select,switch}.tsx' -g '!*.test.*' -g '!**/__tests__/**'` |
| PR-specific split button | `chat/PrSplitButton.tsx` | `SplitButton` | F-03 | `rg -n "PrSplitButton" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'` |
| Old button docs | `docs/internals/renderer/ui-components.md:40-47` | rewritten section | F-03 | `rg -n "icon-xs\|size-14" docs/internals/renderer/ui-components.md` |
| Overlay surface recipe in the primitives: Tailwind shadows, zoom and slide entry | `popover.tsx:52`, `dropdown-menu.tsx:37,171`, `context-menu.tsx:56`, `select.tsx:94`, `dialog.tsx:54` | panel fill, radius 14 or 18, `shadow-popover` or `shadow-dialog`, opacity fade | F-07a | `rg -n "\bshadow-(sm\|md\|lg\|xl\|2xl)\b\|zoom-(in\|out)-\|slide-(in\|out)-from-" apps/web/src/components/ui -g '{popover,dialog,dropdown-menu,context-menu,select}.tsx'` |
| Menu rows highlighted with the selected fill (about 28px rows) | `dropdown-menu.tsx:59,77,131`, `context-menu.tsx:73`, `select.tsx:128` | 40px rows, hover fill, check on the checked row | F-04a | `rg -n "(highlighted\|focus\|hover):bg-(accent\|selected)\b" apps/web/src/components/ui -g '{dropdown-menu,context-menu,select}.tsx'`; row height, disabled reason and focus return are proved by `bun run --cwd apps/web test -- src/components/ui/__tests__/dropdown-menu.test.tsx` |
| Hand-rolled overlay surfaces | `SelectedTextCommentsComposerAttachment.tsx`, `ComposerOverlaySurface.tsx`, `FileTagPopup.tsx`, `DiffCommentEditor.tsx`, `ChecksPopover.tsx`, `ModelSelector.tsx` (surface only; F-04c replaces its content), `MermaidPreviewDialog.tsx`, `ComposerModelPreferences.tsx`, `PreviewAnnotationBundleChip.tsx`, `ThreadSortControl.tsx`, `ThreadFilterDropdown.tsx`, `PullRequestCode.tsx`, `SelectedTextCommentEditor.tsx`, `CommandPalette.tsx`. `Toast.tsx` retires with F-07b. | `Popover`, `Menu`, `Dialog` primitives | F-07a | `rg -n "\bbg-(popover\|panel)\b\|popover-foreground" apps/web/src -g '{SelectedTextCommentsComposerAttachment,ComposerOverlaySurface,FileTagPopup,DiffCommentEditor,ChecksPopover,ModelSelector,MermaidPreviewDialog,ComposerModelPreferences,PreviewAnnotationBundleChip,ThreadSortControl,ThreadFilterDropdown,PullRequestCode,SelectedTextCommentEditor,CommandPalette}.tsx'`. The surface fill comes from the primitive, so none of these files sets it. |
| `SegControl` | `components/settings/SegControl.tsx`, 7 files | `ui/segmented-control.tsx` | F-04b | `rg -n "\bSegControl\b" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'` |
| Settings pickers | `settings/SearchableGroupedPicker.tsx`, `settings/SettingsProviderPicker.tsx` | `Picker` | F-04b | `rg -n "SearchableGroupedPicker\|SettingsProviderPicker" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'` |
| Model picker internals: left provider rail, split panels, per-row metadata | `chat/ModelSelector.tsx`: `LEFT_RAIL_WIDTH_CLASS` (`:62`), `ProviderRailItem` and `ProviderRail` (`:1001-1104`), `ModelSelectorRightPanel` (`:942`), `ModelSelectorPanel` (`:1106`), `GroupedModelList` (`:799`), `ModelMetadata` (`:680`) | `Picker` with provider-icon tabs | F-04c | `rg -n "LEFT_RAIL_WIDTH_CLASS\|ProviderRail\|ModelSelectorPanel\|ModelSelectorRightPanel\|GroupedModelList\|ModelMetadata" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'` |
| File editor list: hand-sized rows, fixed width, mono `:line` caption | `diff/FileEditorPicker.tsx:97-125` | F-04a menu rows | F-04c | `rg -n "items-center gap-2 px-3 py-1\.5 text-xs\|min-w-\[200px\]\|:\{line\}" apps/web/src -g 'FileEditorPicker.tsx'` |
| Provider maps and recolours | `ModelSelector.tsx:49-58`, `ProjectTree.tsx:2215-2228`, `settings/sections/ModelSection.tsx:37-45`, `CoordinationPanel.tsx:51-61` | `ProviderIcon` | F-06 | `rg -n "ProviderIcons\"" apps/web/src -g '!**/components/ui/provider-icon.tsx' -g '!openInAppIcons.tsx' -g '!*.test.*' -g '!**/__tests__/**'`. Only `ProviderIcon` imports the marks; `openInAppIcons.tsx` keeps Cursor's mark for the Cursor editor. |
| Subagent identity colours | `ui/SubagentIdentityGlyph.tsx`, `index.css:63-67,136-146`, `.subagent-identity-glyph`; callers in 4 files and the `features/subagents/index.ts` re-export | `ProviderIcon`, `ProviderDiscStack` | F-06 | `rg -n "subagent-identity-(glyph\|color\|[1-5])\|SubagentIdentityGlyph\|getSubagentIdentityPaletteIndex" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'`. `format-subagent-identity.ts` formats names, not colours, and stays. |
| Old toast | `components/Toast.tsx`, `toastStore` `show(level, ...)` API (21 call sites), `.app-toast-stack` (`index.css:84`) | `ui/toast.tsx` lane | F-07b | `rg -n -U "app-toast-stack\|ToastLevel\|components/Toast\"\|\.show\(\s*\"(error\|info)\"" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'` |
| Phosphor | `TerminalSearchShelf.tsx:16`, `PreviewErrorPanel.tsx:10`, `apps/web/package.json:26` | Lucide via `icon-map.tsx` | F-08 | `rg -n "@phosphor-icons" apps/web/package.json apps/web/src` |
| Deprecated Lucide aliases | `AlertCircle`, `AlertTriangle`, `MoreHorizontal`, `XCircle`, `Code2`, `TerminalSquare` (69 lines); `Loader2` is F-10's | current names via `icon-map.tsx` | F-08 | `rg -n "\b(AlertCircle\|AlertTriangle\|MoreHorizontal\|XCircle\|Code2\|TerminalSquare)\b" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'` |
| Per-icon stroke widths on Lucide icons | 36 `strokeWidth` props on icon components | 1.5 default in one place | F-08 | `rg -n -U "<[A-Z][A-Za-z0-9.]*\b[^<>]*?strokeWidth=" apps/web/src -g '*.tsx' -g '!**/components/ui/icon-map.tsx' -g '!*.test.*' -g '!**/__tests__/**'`. Hand-drawn SVG elements (`<path>`, `<circle>`) keep their own stroke. |
| Inverse-default tooltip and zoom entry | `tooltip.tsx:60-63` | surface tooltip, fade | F-09 | `rg -n "zoom-(in\|out)-\|slide-(in\|out)-from-" apps/web/src/components/ui -g 'tooltip.tsx'`; the surface default is proved by `bun run --cwd apps/web test -- src/components/ui/__tests__/tooltip.test.tsx` |
| `palette/Kbd.tsx` location | `components/palette/Kbd.tsx` | `components/ui/kbd.tsx` | F-09 | `rg -n "palette/Kbd" apps/web/src` |
| Visible "Errored" | `ThreadStateMarker.tsx:16,32`, `ThreadFilterDropdown.tsx:12`, `lib/thread-status.ts:96` | "Failed" | F-10 | `rg -n "label: \"Errored\"" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'`. Contract comparisons such as `case "Errored":` (`virtual-items.ts:89`, `thread-lifecycle.ts:66`) and the roster's terminal outcome (`subagent-projection.ts:413`) are values, not labels, and stay. |
| Spinner variants | `Loader2` (7 lines, 4 files), ad-hoc `animate-spin` (13 lines, 11 files) | `ui/spinner.tsx` | F-10 | `rg -n "\bLoader2\b\|\banimate-spin\b" apps/web/src -g '*.{ts,tsx}' -g '!**/components/ui/**' -g '!*.test.*' -g '!**/__tests__/**'` |
| Five banners | `CliErrorBanner`, `HandoffFallbackBanner`, `ProviderUnavailableBanner`, `ThreadWarningBanner`, `ConnectionBanner`, one caller each | `Notice` | F-10 | `rg -n "\b(CliErrorBanner\|HandoffFallbackBanner\|ProviderUnavailableBanner\|ThreadWarningBanner\|ConnectionBanner)\b" apps/web/src -g '!*.test.*' -g '!**/__tests__/**'` |
| Raw palette colours in feature code | Tailwind palette, ramp-step, `white` and `black` classes: 159 lines in 37 files | role tokens; identity assets and the image lightbox allowlisted | F-11a | `rg -n "\b(bg\|text\|border\|ring\|fill\|stroke\|from\|to\|via\|outline\|divide\|decoration\|placeholder\|caret\|shadow)-((slate\|gray\|zinc\|neutral\|stone\|red\|orange\|amber\|yellow\|lime\|green\|emerald\|teal\|cyan\|sky\|blue\|indigo\|violet\|purple\|fuchsia\|pink\|rose\|sage\|clay)-[0-9]{2,3}\|white\|black)\b" apps/web/src -g '*.{ts,tsx}' -g '!EditorIcons.tsx' -g '!ProviderIcons.tsx' -g '!file-icons.tsx' -g '!vscode-icons.ts' -g '!ImageAttachmentLightbox.tsx' -g '!*.test.*' -g '!**/__tests__/**'` |
| Hex, `rgb()`, `oklch()` and arbitrary colour classes in TSX | 40 + 23 + 3 + 16 lines | role tokens; allowlist `EditorIcons.tsx`, `ProviderIcons.tsx`, `lib/file-icons.tsx`, `lib/vscode-icons.ts` in the rule config | F-11a | `bun run --cwd packages/oxlint-plugin build`, then `bunx --no-install oxlint apps/web/src` exits 0 with `mcode/no-raw-color` at `error` in `.oxlintrc.json`. Issue references such as `#613` and the Browser panel's colour picker make a plain `rg` for hex too broad, so the rule (tested in `packages/oxlint-plugin/src/__tests__/no-raw-color.test.ts`) is the proof. |
| Tailwind shadow utilities in feature code | 50 lines outside the overlay primitives | `shadow-popover`, `shadow-floating`, `shadow-dialog` | F-11a | `rg -n "(^\|[\s\"':])shadow(-(xs\|sm\|md\|lg\|xl\|2xl\|\[[0-9][^\s]*\]\|black/[0-9]+))?($\|[\s\"'}])" apps/web/src -g '*.{ts,tsx}' -g '!**/components/ui/{popover,dialog,dropdown-menu,context-menu,select,tooltip}.tsx' -g '!**/components/Toast.tsx' -g '!*.test.*' -g '!**/__tests__/**'`. The overlay primitives are F-07a's and F-09's rows; `Toast.tsx` is deleted by F-07b; `shadow-none` and inset marks such as the diff gutter stripe are not elevation and stay. |
| Arbitrary font sizes | 154 lines, 51 files | type roles | F-11b | `rg -n "\btext-\[[0-9.]+(px\|rem\|em)\]" apps/web/src -g '*.{ts,tsx}' -g '!*.test.*' -g '!**/__tests__/**'` |
| Numeric z-index | 85 lines | layer tokens | F-11b | `rg -n "\bz-([0-9]+\|\[[0-9]+\])($\|[^-\w])\|zIndex:\s*[0-9]" apps/web/src -g '*.{ts,tsx}' -g '!*.test.*' -g '!**/__tests__/**'` |
| Off-system easing in shared animations | `index.css` animations `fade-up-in` (`:258`), `collapsible-down` and `collapsible-up` (`:298-301`), `chip-enter` (`:309`), `popover-enter` (`:322`), `composer-popup-enter` (`:349`), `overview-enter` (`:359`), `diff-mode-swap` (`:497`); `animated-collapsible.tsx:30`. Section-owned animations (wizard, startup, narrative, plan skeleton) move in their sections. | `--ease-standard` and the duration tokens | F-11b | `rg -n "animation: (popover-enter\|composer-popup-enter\|collapsible-(down\|up)\|chip-enter\|fade-up-in\|diff-mode-swap\|overview-enter) [0-9.]+m?s\|ease-\[cubic-bezier" apps/web/src -g 'index.css' -g '{animated-collapsible,collapsible}.tsx'` |
| Hand-rolled radio | `ProjectEnvironmentPanel.tsx:317,358` | `RadioGroup` | F-12 | `rg -n "role=\"radio\"" apps/web/src -g '!**/components/ui/**' -g '!SegControl.tsx' -g '!**/plan-questions/**' -g '!*.test.*' -g '!**/__tests__/**'`. `SegControl` moves into `ui/` in F-04b; the wizard's `OptionTile` retires in S07-09. |
| Glow focus on fields | `focus-visible:ring-3` with `ring-ring/50` in `checkbox.tsx:16`, `select.tsx:52`, `textarea.tsx:11` | 2px focus ring with 2px offset | F-12 | `rg -n "\bring-3\b" apps/web/src/components/ui -g '{input,textarea,checkbox,select,switch}.tsx'` |

## Proposed tickets

Section authors referenced F-01 to F-07. F-01, F-04 and F-07 are now split; a reference to "F-01" means F-01a and F-01b, "F-04" means F-04a and F-04b (F-04c then moves the model picker and the file editor list onto them), and "F-07" means F-07a (overlay surfaces, side placement, floating shadow) and F-07b (toast lane). Tickets run in this order: F-01a and F-08 first (no blockers), then F-01b, then everything else; F-99 last. `tools/graph.json` is the source of truth for blockers; this table mirrors it.

| Ticket | Title | Blocked by |
|---|---|---|
| F-01a | Paper token values | None |
| F-01b | Token vocabulary rename | F-01a |
| F-02 | Fade truncation primitive | F-01a |
| F-03 | Button primitives | F-01b |
| F-04a | Menu primitive | F-01b, F-03, F-07a, F-09 |
| F-04b | Picker primitive | F-04a, F-07a, F-02, F-12 |
| F-04c | Migrate the model picker and file editor picker to the picker primitive | F-04b, F-06 |
| F-05 | Right panel shell (section 12) | F-02, F-03, F-04a, F-07a, S01-01 |
| F-06 | Provider icon and disc stack | F-01b |
| F-07a | Overlay surfaces and side placement | F-01b |
| F-07b | Toast lane | F-01b, F-02, F-03, F-07a, F-10 |
| F-08 | Icon system: Lucide at 1.5px | None |
| F-09 | Tooltip primitive | F-01b |
| F-10 | Status marks, spinner, badges, notices | F-01b, F-08 |
| F-11a | Raw colour and shadow sweep, lint guards | F-01b, F-06 |
| F-11b | Type size, layer and motion sweep, lint guards | F-01b |
| F-12 | Form controls | F-01b |
| F-99 | Dead code sweep | Every other ticket in the program |

### F-01a Paper token values

- **Blocked by:** None (can start immediately).
- **Boards:** Color palette (`7MF-0`), Named color roles (`7MG-0`), Typography (`2-0`), Spacing and sizing (`81C-0`), Shape and elevation (`81D-0`), States and motion (`81F-0`), Layout and interaction (`5-0`)
- **Delivers:** Every surface in both themes shows Paper's values: correct dark ink and primary text, blue focus in light, the new feedback colours, Paper line heights, JetBrains Mono for code, and the 304px sidebar.
- **Build notes:** Export with Paper `get_tokens` (`format: "css"`, file contentHash `e63b1b95` at the time of writing) and add the six ramps to `index.css`. Point the existing variable names at ramp steps in this ticket (rename is F-01b). Add the missing roles: `--control-border`, `--success`, `--error`, `--warning`, `--info`, `--pr-merged`, `--primary-hover`, `--destructive-ink`, `--button-secondary-hover`, `--button-destructive-hover`, and their light values. Add `@theme` entries for type roles (`text-body`, `text-prose`, `text-body-small`, `text-caption`, `text-label`, `text-button`, `text-link`, `text-code`, each with line height and weight), radius roles, `--spacing-text-fade`, size tokens, `--ease-standard` and `--duration-fast/standard/overlay`, `--shadow-popover/floating/dialog` (dark) and the light overlay recipe, layer tokens, `--container-sidebar` (304), rail 48 and 160. Change `--text-sm` and `--text-base` line heights to Paper's (14/20, 16/24); this shifts every row that uses them, so take before/after screenshots of the sidebar, composer, a menu and settings. Set `--font-mono` to the JetBrains stack and add `font-variant-ligatures: none` to a `.font-code` utility used by code views (Pierre: its font-features variable). Move selection, scrollbar and slider-focus colours to tokens, and delete the unused `.glow-primary` (`index.css:647-649`; no TSX references it). Delete `--chart-*` and `--sidebar-*`. Replace `SIDEBAR_WIDTH_PX = 288`, the docked sidebar's `w-72` and the floating sidebar's `w-72` (`App.tsx:243`) with the token (resizing stays with section 01). Remove the unused `@fontsource-variable/geist` dependency while the font stack is open.
- **Deletes:** ledger rows "`--chart-1..5`, `--sidebar-*`", "Literal colours in base CSS", "`--font-mono` without JetBrains Mono", "Unused font dependency" and "Sidebar 288 constant".
- **Acceptance criteria:**
  - [ ] Every Paper role resolves to its Paper value in both themes (parity test below).
  - [ ] Dark primary button label is neutral-900 on amber-500; light focus ring is blue-600.
  - [ ] `font-family` of a diff line and the terminal is JetBrains Mono with ligatures off.
  - [ ] Sidebar renders 304 wide at 1440.
  - [ ] No visual regression beyond the intended value changes in the four screenshots.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-01a` passes.
- **Verify:** `bun run --cwd apps/web test -- src/__tests__/design-tokens.test.ts`. The test is new: it parses `index.css` and compares each role in `:root` and `.dark` against a checked-in `design-tokens.paper.json` exported from Paper (the test fails when either side drifts). Live: `bun run --shell system agent:up`, open the Electron app with the live-testing harness, toggle dark and light, screenshot sidebar, composer, a dropdown, and Settings.

### F-01b Token vocabulary rename

- **Blocked by:** F-01a Paper token values.
- **Boards:** Named color roles (`7MG-0`)
- **Delivers:** Code uses Paper's role names, so a value read from Paper JSX can be pasted into a Tailwind class without translation, and the `muted` collision is gone.
- **Build notes:** One scripted codemod over `apps/web/src` that rewrites whole class tokens in a single pass from an exact map. A single pass means no rename feeds into another, and exact tokens mean `bg-muted` never matches inside `bg-muted-foreground`. A token is a utility name bounded on the left by the start of a string, whitespace, a quote, a backtick or a variant colon (`hover:`, `data-highlighted:`), and on the right by whitespace, a quote, a backtick, `/` (opacity) or `]`; variant prefixes and opacity suffixes are kept. The map, by colour name with the utility prefix kept (`bg-`, `text-`, `border-`, `ring-`, `outline-`, `fill-`, `stroke-`, `from-`, `via-`, `decoration-`):
  - `muted-foreground` to `muted` (`text-muted-foreground` 932 occurrences, `bg-muted-foreground` 24, `border-`, `stroke-`, `decoration-`).
  - `muted` to `hover` (`bg-muted` 216). Applied to the original token only, so the `bg-muted` produced by the line above is never rewritten again.
  - `primary-foreground` to `primary-ink`.
  - `foreground`, `card-foreground`, `popover-foreground`, `accent-foreground`, `secondary-foreground` to `ink`.
  - `card` and `popover` to `panel`.
  - `accent`, `secondary` and `bg-input` to `selected`.
  - `border-input` to `border-control-border`.
  - `ring` to `focus` (`ring-ring`, `border-ring`, `outline-ring`, `text-ring`, `bg-ring`).

  The script stops and prints any `*-foreground`, `-card`, `-popover`, `-accent`, `-secondary`, `-input` or `-ring` token it has no mapping for, rather than guessing. It edits class strings only: the xterm theme key `foreground:` (`TerminalView.tsx:676`), prose such as `transport/types.ts:876` and CSS custom properties stay out of it; rewrite `index.css` by hand. Then delete the old variables and their `@theme` entries. After this ticket `bg-muted` and `--muted` still exist with Paper's meaning (the muted text colour), which is why the ledger proof leaves them out; the screenshot diff is what proves no old `bg-muted` surface survived. Update `apps/web/components.json` notes or remove the shadcn CLI config if generated components would reintroduce old names (inferred: `shadcn` is a devDependency at `apps/web/package.json:52`). Commit the codemod script under `scripts/` only if the user wants it kept; otherwise attach it to the PR.
- **Deletes:** ledger row "shadcn colour names".
- **Acceptance criteria:**
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-01b` passes.
  - [ ] Typecheck, lint and web tests pass.
  - [ ] Screenshot diff of the four F-01a surfaces shows no change (rename only).
- **Verify:** `bun run --cwd apps/web typecheck`; `bun run --cwd packages/oxlint-plugin build`, then `bunx --no-install oxlint apps/web/src`; focused tests `bun run --cwd apps/web test -- src/__tests__/Button.test.tsx src/components/ui/__tests__/overlay-pointer-events.test.tsx src/__tests__/design-tokens.test.ts` (CI runs the full suite); live screenshots compared with F-01a's.

### F-02 Fade truncation primitive

- **Blocked by:** F-01a Paper token values.
- **Boards:** Text overflow · Fade (`J9C-0`); Typography (`2-0`)
- **Delivers:** Every long label, title, path and branch fades its last 24px instead of ending in "…", and only when it overflows.
- **Build notes:** A `.text-fade` utility: `overflow: clip; white-space: nowrap; min-width: 0;` plus the mask applied only when the element overflows. Prefer a CSS-only overflow test with a scroll-driven animation on the clip element (`animation-timeline: scroll(self inline)`), which Electron 35 (Chromium 134, `apps/desktop/package.json:41`) supports (inferred; prove it in the live check). In browsers without scroll-driven animations the text clips with no fade, which is acceptable for the web client. `.text-fade-lines-2/3` for vertical clamps ends in a 24px bottom fade. `PathText` renders file name in ink then folder in muted, with only the folder fading, and replaces `PathLabel`'s rtl trick. Add `mcode/no-ellipsis-truncation` (bans `truncate`, `text-ellipsis`, `line-clamp-` and `text-overflow` class tokens and string concatenation ending in `…`), at error, in the same ticket after the sweep. Match whole class tokens, not substrings: `"context-overflow"` in a provider error union (`transport/types.ts:898`) and `truncatePath`-style names are not violations. Three tests assert the old masks and change with them (`ComposerCapabilities.test.tsx:165`, `ThreadOverview.branchless-pr.test.tsx:513`, `slash-command-popup-icons.test.tsx:334`).
- **Deletes:** ledger rows "`truncate` and `text-ellipsis` classes", "`line-clamp-*` ellipsis", "Ad-hoc horizontal fade masks" and "rtl ellipsis path trick, code-side path cutting".
- **Acceptance criteria:**
  - [ ] A title that fits shows no fade; the same title in a narrower slot fades the last 24px.
  - [ ] Icons, counts and actions next to faded text stay fully visible.
  - [ ] Faded text keeps its full value in the accessible name, and a tooltip shows it where the row already had one.
  - [ ] Lint rule at error; `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-02` passes.
- **Verify:** `bun run --cwd packages/oxlint-plugin test -- src/__tests__/no-ellipsis-truncation.test.ts` and `bun run --cwd apps/web test -- src/components/ui/__tests__/path-text.test.tsx src/components/chat/__tests__/ComposerCapabilities.test.tsx src/components/chat/ThreadOverview.branchless-pr.test.tsx src/components/chat/__tests__/slash-command-popup-icons.test.tsx`. The rule test is new (prior art `no-native-title-tooltip.test.ts`); `path-text.test.tsx` is a new component test for `PathText` ordering; the other three web tests assert the old masks and change with them. Live: resize the sidebar narrow, confirm a long thread title and branch fade with no "…"; open a picker with long branch names; check the web client in Chromium.

### F-03 Button primitives

- **Blocked by:** F-01b Token vocabulary rename.
- **Boards:** Buttons · Dark / Light (`8O1-0`, `8O2-0`), Sizes and composition (`8O3-0`), Composer Send (`93N-0`); round buttons on 10a (`2241-2`)
- **Delivers:** Every button matches Paper: six variants, 32 / 40 / 48, inset press, offset focus; a round 32px icon button with selected fill and ink icon (control-border fill when on, 40px with the floating shadow when it floats); a split button; the round Send and neutral Stop styles.
- **Build notes:** Sizes `compact` (32, 12 inset, 16 icon), `default` (40, 16, 20), `comfortable` (48, 20, 20) and their icon-only boxes; keep the call-site default at compact for dense chrome. Variants per DESIGN.md Buttons. `IconButton` with `shape="round"` and `pressed`/`aria-pressed` driving the on fill. `SplitButton` composes a button and a menu trigger sharing one outline and focus order. Inline row-action boxes 24 and 28 (`size="inline"` naming is the implementer's call). Codemod the 363 size call sites (`xs`, `sm`, `icon-xs`, `icon-sm`, `icon` to compact); removing the old keys from the `size` map makes `bun run typecheck` catch any call site the codemod missed. Replace the translate press and the 3px focus glow wherever buttons and button-like rows carry them (`ThreadOverview.tsx:230`, `SidebarRevealButton.tsx:77`, `TerminalSection.tsx:37`, `ProjectEnvironmentPanel.tsx:97`, `SelectedTextCommentsComposerAttachment.tsx:257,486`); the glow on form controls is F-12's. Migrate `PrSplitButton` to `SplitButton`. Rewrite the Button section of `docs/internals/renderer/ui-components.md`.
- **Deletes:** ledger rows "Button size aliases", "Destructive tint on Button", "Translate press and 3px focus glow outside the form controls", "PR-specific split button" and "Old button docs".
- **Acceptance criteria:**
  - [ ] All six variants render Paper's six states in both themes.
  - [ ] Round button: selected fill at rest, control-border fill with `aria-pressed="true"`, accessible name and tooltip required (type-level: `aria-label` is a required prop for icon-only).
  - [ ] Loading keeps width and blocks repeat clicks.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-03` passes and `bun run --cwd apps/web typecheck` passes.
- **Verify:** `bun run --cwd apps/web test -- src/components/ui/__tests__/button.test.tsx src/__tests__/Button.test.tsx`. `button.test.tsx` is new: loading blocks a second click; split button keyboard order (action, then chevron opens the menu). The existing `src/__tests__/Button.test.tsx` asserts today's size aliases and changes with the size map. Live: Review panel header, sidebar header ghost buttons, a dialog's primary and destructive pair, both themes.

### F-04a Menu primitive

- **Blocked by:** F-01b Token vocabulary rename; F-03 Button primitives; F-07a Overlay surfaces and side placement; F-09 Tooltip primitive.
- **Boards:** Overlays · Menu items and menus (`HZC-0`, `HZD-0`); Review view picker 10b (`2DV5-2`); Browser More menu 11c (`2F1L-2`)
- **Delivers:** Menus with 40px rows, names only, dividers, muted shortcuts, checked and destructive rows, dimmed unavailable rows with a reason tooltip, and submenus that open to the side, on the F-07a surface.
- **Build notes:** Restyle `dropdown-menu.tsx`, `context-menu.tsx` and the `select.tsx` popup list. Row API: `label`, optional `icon`, optional `shortcut`, `checked`, `destructive`, `disabledReason` (renders dimmed with a tooltip and an accessible description). Groups are separated by a divider component, with no group-label slot. The menu surface (fill, radius, padding, shadow, fade) comes from F-07a; this ticket owns the rows. Migrate the 13 `DropdownMenuContent` users outside `components/ui` to the row API; the 14th, `FileEditorPicker`, moves in F-04c.
- **Deletes:** ledger row "Menu rows highlighted with the selected fill".
- **Acceptance criteria:**
  - [ ] Menu row is 40px; highlighted row uses the hover fill; a checked row shows a check, not a fill.
  - [ ] A disabled row is focusable for its tooltip, not invocable, and its reason is in the accessible description.
  - [ ] Escape closes and restores focus to the trigger.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-04a` passes.
- **Verify:** `bun run --cwd apps/web test -- src/components/ui/__tests__/dropdown-menu.test.tsx src/components/ui/context-menu.test.tsx`. `dropdown-menu.test.tsx` is new, for keyboard, disabled reason and focus return (prior art `context-menu.test.tsx`, which also runs because this ticket restyles its rows). Live: sidebar thread context menu and Review view picker, both themes.

### F-04b Picker primitive

- **Blocked by:** F-04a Menu primitive; F-07a Overlay surfaces and side placement; F-02 Fade truncation primitive; F-12 Form controls.
- **Boards:** 03b Branch picker states (`2BP1-2`), Pickers (`AHR-0`, `ASN-0`), Model picker · Polished (`189C-2`, `190D-2`)
- **Delivers:** One picker every section uses: borderless search row, optional segmented tabs, flat list with a trailing check and muted tag on the selected row, silent paging with "Showing x of y", top and bottom scroll fades, optional footer toggles, no-match and failure states.
- **Build notes:** Props sketch:
  ```ts
  interface PickerProps<T> {
    readonly tabs?: readonly { id: string; label: string }[];
    readonly activeTab?: string;
    readonly onTabChange?: (id: string) => void;
    readonly query: string;
    readonly onQueryChange: (q: string) => void;
    readonly items: readonly T[];
    readonly total: number | null; // null while unknown; footer hides
    readonly onLoadMore?: () => void; // called near the end of the list
    readonly status: "ready" | "loading" | { failed: string; detail?: string };
    readonly selectedKey?: string;
    readonly renderItem: (item: T) => PickerRow; // name, optional mono, optional tag
    readonly emptySwitch?: { tabId: string; label: string }; // "matches in Pull requests"
    readonly footer?: ReactNode;
    readonly onSelect: (item: T) => void;
  }
  ```
  Listbox semantics; focus starts in the search field. Build on cmdk only if it supports server-side paging and an external filter (inferred; `ui/command.tsx`). Move `SegControl` to `ui/segmented-control.tsx` with Paper's recipe. Migrate the two settings pickers. Every other picker has one owner: the model picker and the file editor list move in F-04c; the project chooser, branch and worktree pickers in S02-03 and S03-05; Review's commit and branch-ref pickers in S10-05.
- **Deletes:** ledger rows "`SegControl`" and "Settings pickers".
- **Acceptance criteria:**
  - [ ] Five rows visible by default; fades appear only when the list scrolls.
  - [ ] Scrolling near the end calls `onLoadMore` once per page; the footer reads "Showing 50 of 568".
  - [ ] No-match reads `Nothing matches "q"` and offers the other tab when `emptySwitch` is set.
  - [ ] Failure shows the title, the raw detail in mono, and Retry.
- **Verify:** `bun run --cwd apps/web test -- src/components/ui/__tests__/picker.test.tsx`, a new test with a fake paged source (load-more fires once per threshold, keyboard selection, tab switch keeps the query). Live: Settings model and provider pickers in both themes.

### F-04c Migrate the model picker and file editor picker to the picker primitive

- **Blocked by:** F-04b Picker primitive; F-06 Provider icon and disc stack.
- **Reconciled:** Migrates the model picker and the file editor picker to the F-04b picker; owns their retirement (they were assigned to whole sections before).
- **Boards:** Model picker · Polished · Dark / Light (`189C-2`, `190D-2`, page p-5-0); Overlays · Menu items and menus (`HZC-0`, `HZD-0`) for the editor list
- **Delivers:** The composer's model picker is the shared picker: a search row, provider tabs drawn with each provider's icon (Favourites first), and a flat list that names each model once, with a check on the selected model and a star to favourite it. Favourites show the provider under each model, because providers mix there. Section 08f's Switch model (S08F-07) opens this same picker. Open in editor on a file row becomes a names-only menu of the detected editors plus Reveal in file manager.
- **Build notes:**
  - Model picker. Keep `ModelSelector`'s export and props (`ModelSelector.tsx:90-105`, `:1194`), so `ComposerAgentControls.tsx:67` and S08F-07 need no change. F-07a has already moved its surface into `Popover`; this ticket replaces the content with `Picker`.
  - Tabs: Favourites (star) first, then one tab per provider drawn with F-06's `ProviderIcon`; the active tab's name sits muted at the right of the tab row (`189C-2`). If F-04b's tab type has no icon slot, add `icon?: ReactNode` here and keep `label` as the accessible name. A provider with a single model still selects it on click (`ModelSelector.tsx:1258-1265`).
  - Rows name the model only. Drop `ModelMetadata` (context window, multiplier, "Until" date, `:680`) from rows. The selected row gets a trailing check and no fill; the star is a trailing action. Favourites rows add the provider icon and name as a second line. If F-04b's `PickerRow` has no trailing action or second line, add them here.
  - Unavailable stays visible: a gated model (`GatedModelRow`, `:647`) and an unavailable provider tab (`providerRailUnavailableReason`, `:73`) render dimmed with the reason in a tooltip and cannot be picked.
  - Keep today's behaviour: live catalog fetch per provider with the 30s retry cooldown (`useProviderModelCatalog`, `:425`), the favourites store, the provider lock after a thread starts (`getProvidersForLeftRail`, `:277`), the locked label while a turn runs (`LockedModelLabel`, `:1175`), and catalog subgroups (`groupModels`, `:338`) split by dividers.
  - Out of scope: `189C-2` also draws a reasoning, context and Fast flyout beside the hovered model, Ctrl+1 to 4 shortcuts on favourites, a folded "Legacy models" row and a cross-provider Switch. They are new behaviour with no owning ticket (open question 15). `ComposerModelPreferences` keeps its own trigger until that is decided.
  - File editor list. Keep `FileEditorPicker`'s export and props (`FileEditorPicker.tsx:22-37`) so `FileActionBar.tsx:138` and the Open in editor actions in sections 08, 10 and 12 reuse it. It is an action list with no search, paging or selected row, so it takes F-04a's menu rows rather than the searchable list: icon and name per detected editor, a divider, then Reveal in file manager. Drop the mono `:line` caption (`:108-112`); the line still goes to `openIn` (`:67`).
- **Deletes:** ledger rows "Model picker internals" and "File editor list".
- **Acceptance criteria:**
  - [ ] Opening the model picker puts focus in search; typing filters the active tab; switching tabs keeps the query; Escape closes and returns focus to the trigger.
  - [ ] Each provider tab shows its `ProviderIcon` and announces the provider name; after a thread starts, only that thread's provider tab is offered.
  - [ ] Rows show the model name only; the selected model has a check and no fill; Favourites rows add the provider on a second line.
  - [ ] Starring a model adds it to Favourites; a gated model is dimmed, explains why in a tooltip and cannot be picked.
  - [ ] The Open in editor menu lists the detected editors and Reveal in file manager; picking an editor opens the file at the line.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-04c` passes.
- **Verify:** `bun run --cwd apps/web test -- src/components/chat/__tests__/ModelSelector.test.tsx src/components/diff/__tests__/FileEditorPicker.test.tsx`, extended for tab switching with a kept query, the provider lock, favourites, gated rows and the editor menu. Live, on `.dev/fixture-repo`: open the composer model picker in both themes and compare it with `189C-2` and `190D-2`; start a thread and confirm only its provider's tab remains; open Open in editor from a Review file row.

### F-05 Right panel shell (section 12 owns)

- **Blocked by:** See the full spec in `12b-panel-shell-files-and-subagents.md` (F-02, F-03, F-04a, F-07a, S01-01).
- **Boards:** see section 12.
- **Delivers:** Two-row panel header, rail as vertical tabs, horizontal row-1 tabs. Written by the section 12 author; listed here so dependencies resolve.

### F-06 Provider icon and disc stack

- **Blocked by:** F-01b Token vocabulary rename.
- **Boards:** 05c / 05d on `p-6-0` (subagent chips and overview row; node ids in section 05), Labels (`B4I-0`)
- **Delivers:** Every provider appears by its authentic icon from one component; subagents show the provider icon; overview rows show up to three overlapping 20px discs.
- **Build notes:** `ProviderIcon({ provider, size })` with sizes 16 and 20, keyed by provider id, no colour classes. `ProviderDiscStack({ providers, max = 3 })`: 20px discs with the `selected` fill and a 12px ink provider icon, on a 12px step, each with a 1.5px `panel` ring (values from section 05's reading of the overview board; recheck in Paper), rendering the first three. Replace the four maps (`ModelSelector.tsx`, `ProjectTree.tsx`, `settings/sections/ModelSection.tsx`, `CoordinationPanel.tsx`) so only `ProviderIcon` imports the marks from `chat/ProviderIcons.tsx`; `openInAppIcons.tsx` keeps Cursor's mark because there it means the Cursor editor. Replace every `SubagentIdentityGlyph` caller (`SubagentsPanel.tsx`, `ThreadOverview.tsx`, `SubagentRow.tsx`, `NarrativeDetailView.tsx`) and the `features/subagents/index.ts` re-export. This ticket is the only owner of the glyph's retirement; sections 05 and 12 consume the provider icon. Per-provider decisions in Backend architecture.
- **Deletes:** ledger rows "Provider maps and recolours" and "Subagent identity colours".
- **Acceptance criteria:**
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-06` passes.
  - [ ] A stack of 8 subagents shows three discs; the text beside it carries the count.
- **Verify:** `bun run --cwd apps/web test -- src/components/ui/__tests__/provider-icon.test.tsx`, a new small render test for the stack cap. Live: model picker provider tabs, a thread with Codex subagents, both themes.

### F-07a Overlay surfaces and side placement

- **Blocked by:** F-01b Token vocabulary rename.
- **Boards:** Shape and elevation (`81D-0`), Overlays · Popovers and Dialogs (`HZC-0`, `IJA-0` and light pairs); 03d / 03e overview menus (`20F4-2`, `20M5-2`)
- **Delivers:** Popovers, hover cards, dialogs and menu surfaces share Paper's surface recipe; a surface opened from a row inside a floating card opens beside the card, top-aligned to the row; floating controls share one shadow.
- **Build notes:** Surface recipe in one place: `panel` fill, 1px `border`, radius 14 (menus, popovers, pickers) or 18 (dialogs, sheets), `shadow-popover` or `shadow-dialog` (light theme: the light overlay recipe). Side placement: open to the left or right of a boundary element (the overview card), top at the trigger row minus 4px, falling back below the row only when neither side fits (from section 01/03's reading of `20F4-2`). Use Base UI positioning (`side`, `align`, `alignOffset`, `collisionBoundary`; inferred API, check `@base-ui/react` 1.8.0). Floating recipe: `shadow-floating` and the 40px round button from F-03. Motion: standard opacity fade; no zoom or slide. Migrate the 14 hand-rolled overlay surfaces in the ledger to `Popover` or `Dialog` with their content unchanged. After the move none of those files paints the panel fill itself: an inner region that repeated it (`ModelSelector.tsx:1160`) drops it, and a floating control group inside one (the Mermaid preview zoom bar, `MermaidPreviewDialog.tsx:181`) takes the floating recipe from the F-03 round buttons. For `ModelSelector` move only the surface (its click-outside hook and absolute panel, `:531`, `:1128`); F-04c replaces the content.
- **Deletes:** ledger rows "Overlay surface recipe in the primitives" and "Hand-rolled overlay surfaces".
- **Acceptance criteria:**
  - [ ] Popover, dialog and menu surfaces render the recipe in both themes.
  - [ ] A surface opened from a row inside a 280px card opens beside the card, top-aligned to the row, and flips sides at the window edge.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-07a` passes.
- **Verify:** `bun run --cwd apps/web test -- src/components/ui/__tests__/side-placement.test.ts src/components/ui/__tests__/overlay-pointer-events.test.tsx`. `side-placement.test.ts` is a new placement unit test for the shared positioning helper with a mocked boundary rect (left, right, fallback below); `overlay-pointer-events.test.tsx` covers the restyled popover, menu and select positioners. Live: thread overview workspace and branch menus on a new thread, a dialog, a hover card, both themes.

### F-07b Toast lane

- **Blocked by:** F-01b Token vocabulary rename; F-02 Fade truncation primitive; F-03 Button primitives; F-07a Overlay surfaces and side placement; F-10 Status marks, spinner, badges and notices.
- **Reconciled:** Also absorbs S09-01: existing app toasts move into the lane in this ticket.
- **Boards:** 09a (`25IT-2`, toast node `25R2-2`), 09b (`2DN0-2`), 09f (`2DSS-2`)
- **Delivers:** One toast lane at the top centre of the conversation column with the floating pill style, kinds (finished, needs-you, failed, info), lifetime rules, stacking, click-to-open, hover lift and swipe to dismiss; existing app toasts move into it.
- **Build notes:** Store API sketch:
  ```ts
  type ToastKind = "finished" | "needs-you" | "failed" | "info";
  interface ToastInput {
    readonly kind: ToastKind;
    readonly title: string;
    readonly meta?: string; // "Finished · 14:32"
    readonly onOpen?: () => void; // whole toast is the button
    readonly dedupeKey?: string; // one toast per thread
  }
  interface ToastStore {
    show(input: ToastInput): string; // returns the toast id; a live toast with the same dedupeKey is replaced in place
    dismiss(id: string): void;
    dismissByKey(dedupeKey: string): void; // no-op when no toast holds the key
  }
  ```
  `dismissByKey` exists for section 09: it removes a thread's toast when the user opens that thread or the condition that raised it clears, without the caller tracking toast ids. Both dismiss paths clear the toast's timer and play the normal exit, not the swipe exit. Finished and info hide after 8s, paused while hovered; needs-you and failed persist. Max 3, newest on top; the overflow is dropped (thread events have no log). Position against the conversation column's measured box, 8px under the 48px header. Enter 240ms with `--ease-standard`; swipe with pointer events (follow, fade with distance, exit 160ms past 35% or on a flick, otherwise return); stack reflow 200ms; reduced motion fades over 120ms only. The toast uses F-07a's floating shadow. Move all 21 `show(level, ...)` callers to the new input, then delete `Toast.tsx`, `ToastLevel` and `.app-toast-stack`; this ticket is the only owner of the old toast's retirement. Section 09 adds thread-event producers.
- **Deletes:** ledger row "Old toast".
- **Acceptance criteria:**
  - [ ] Four toasts in a row leave three on screen, newest on top.
  - [ ] A finished toast hidden after 8s stays while hovered.
  - [ ] Enter on a focused toast opens its object; Escape closes it; toasts never steal focus.
  - [ ] Error and info toasts from existing callers render in the new lane.
  - [ ] `dismissByKey` removes the toast holding that key, cancels its timer and leaves other toasts in place; with no matching toast it does nothing. Showing a second toast with a live key replaces the first instead of stacking.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-07b` passes.
- **Verify:** `bun run --cwd apps/web test -- src/stores/__tests__/toastStore.test.ts`, a new test with fake timers (lifetime, hover pause, cap, dedupe replacement, `dismissByKey` hit and miss). Live: trigger a background thread finishing (fixture repo) and an app error; swipe one away on a trackpad and with a mouse drag.

### F-08 Icon system: Lucide at 1.5px

- **Blocked by:** None (can start immediately).
- **Boards:** Iconography (`81E-0`)
- **Delivers:** Every product icon is Lucide at 1.5px; one map names the canonical concepts; Phosphor is gone.
- **Build notes:** `components/ui/icon-map.tsx` re-exports the DESIGN.md canonical mapping with `strokeWidth={1.5}` defaults. For direct imports, one CSS rule on Lucide's root class sets the stroke (lucide-react renders `class="lucide lucide-<name>"`; inferred, verify). Remove the 36 per-call `strokeWidth` props on icon components; hand-drawn SVG elements (`WorktreeModeIcon.tsx:18`, `SidebarRevealButton.tsx:22,46`, the context ring in `ContextTracker.tsx:83,92`) keep their own stroke. Rename deprecated aliases (`Loader2` goes to `Spinner` in F-10). Replace the Phosphor icons in the two files and drop the dependency. Add `no-restricted-imports` for `@phosphor-icons/react` in `.oxlintrc.json`.
- **Deletes:** ledger rows "Phosphor", "Deprecated Lucide aliases" and "Per-icon stroke widths on Lucide icons".
- **Acceptance criteria:**
  - [ ] Rendered Lucide SVGs report `stroke-width: 1.5` in computed styles.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-08` passes; lint blocks a Phosphor import.
- **Verify:** `bun run --cwd apps/web test -- src/components/ui/__tests__/icon-map.test.tsx`, a new test that renders the canonical icons from `icon-map.tsx` and checks each SVG has a stroke width of 1.5. Live: inspect a sidebar icon and a menu icon in DevTools; compare against `81E-0`.

### F-09 Tooltip primitive

- **Blocked by:** F-01b Token vocabulary rename.
- **Boards:** Overlays · Tooltips (`HZC-0`, `HZD-0`)
- **Delivers:** Tooltips match Paper: surface by default, caption text, arrow, shortcut keycaps, four placements, fade only.
- **Build notes:** Restyle `tooltip.tsx`: panel fill, 1px border, radius 8, 32px minimum height, 12px inline padding, 32rem max width, arrow 10×6. Keep an inverse variant only if a section board uses it (the 04 board shows it; no screen uses it, inferred). Move `palette/Kbd.tsx` to `ui/kbd.tsx`. Standard-duration opacity fade; no zoom or slide.
- **Deletes:** ledger rows "Inverse-default tooltip and zoom entry" and "`palette/Kbd.tsx` location".
- **Acceptance criteria:**
  - [ ] Default tooltip renders the surface recipe in both themes.
  - [ ] A tooltip with a shortcut shows keycaps.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-09` passes.
- **Verify:** New `components/ui/__tests__/tooltip.test.tsx` for the default variant and keycaps (`bun run --cwd apps/web test -- src/components/ui/__tests__/tooltip.test.tsx`; prior art `overlay-pointer-events.test.tsx`). Live: hover any icon-only button.

### F-10 Status marks, spinner, badges and notices

- **Blocked by:** F-01b Token vocabulary rename; F-08 Icon system: Lucide at 1.5px.
- **Reconciled:** Also absorbs S08F-10: rename every visible "Errored" to "Failed", toasts included; contract status values stay.
- **Boards:** Labels · Thread markers and badges (`B4I-0`, `BF4-0`), Feedback · Notices and loading (`JHK-0`, `JHP-0`); 05a (`2156-2`), 06f (`200I-2`), 08d (`207O-2`)
- **Delivers:** One `StatusMark` (8px success or error dot, 8px ring with a 1.5px amber border, neutral spinner) with accessible text; one `Spinner`; Paper badges; one `Notice` (icon, title, detail, one action; info, warning, error, success); "Failed" replaces "Errored" in every visible label.
- **Build notes:** `StatusMark({ state, label })` renders the mark and an accessible name; the row fade (0.55) is the row's job, exposed as a data attribute the sidebar uses. Spinner sizes on the 4px scale (12, 16, 20; Paper's 10 and 13 are an open question). Migrate `ThreadStateMarker` internals to `StatusMark`, `Loader2` and ad-hoc `animate-spin` to `Spinner`, and five banners to `Notice` (`CliErrorBanner`, `HandoffFallbackBanner`, `ProviderUnavailableBanner`, `ThreadWarningBanner`, `ConnectionBanner`): each has one caller, which renders `Notice` with the banner's state. `CompactingBanner` is not one of them; S05-02 turns compaction into a status-line state. Rename visible "Errored"; leave contract status values alone.
- **Deletes:** ledger rows "Visible Errored", "Spinner variants" and "Five banners".
- **Acceptance criteria:**
  - [ ] Each state renders the Paper mark and announces its label.
  - [ ] No visible "Errored" anywhere, including the sidebar filter and toasts.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-10` passes.
- **Verify:** `bun run --cwd apps/web test -- src/components/ui/__tests__/status-mark.test.tsx`, a new test for accessible names per state. Live: sidebar with one running, one failed, one finished-unseen thread on the fixture repo.

### F-11a Raw colour and shadow sweep with lint guards

- **Blocked by:** F-01b Token vocabulary rename; F-06 Provider icon and disc stack.
- **Boards:** Named color roles (`7MG-0`), Shape and elevation (`81D-0`)
- **Delivers:** No feature code paints with a raw colour or an ad-hoc shadow; lint keeps it that way.
- **Build notes:** Migrate the raw palette, hex, `rgb()`, `oklch()` and arbitrary colour classes to role tokens; status-like colours go to `success`, `error`, `warning`, `info`; terminal ANSI colours map to tokens per section 12 (`TerminalView.tsx` hex). Allowlist identity assets (`EditorIcons.tsx`, `ProviderIcons.tsx`, `lib/file-icons.tsx`, `lib/vscode-icons.ts`) and image overlays that need pure black or white (`ImageAttachmentLightbox.tsx`; inferred). Paper's ramp steps (`neutral-500`, `amber-500` and the rest) are not roles, so feature code does not use them either. Replace Tailwind shadow utilities in feature code with the three recipes; the overlay primitives are F-07a's and the tooltip is F-09's, and `Toast.tsx` is skipped because F-07b deletes it. `shadow-none` and inset marks such as the diff gutter stripe (`DiffPreviewMarkdown.tsx:100`) are not elevation and stay. Add `mcode/no-raw-color` and `mcode/no-raw-shadow` at error.
- **Deletes:** ledger rows "Raw palette colours in feature code", "Hex, `rgb()`, `oklch()` and arbitrary colour classes in TSX" and "Tailwind shadow utilities in feature code".
- **Acceptance criteria:**
  - [ ] Both rules at error, and `bun run --cwd packages/oxlint-plugin build`, then `bunx --no-install oxlint apps/web/src` passes.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-11a` passes.
  - [ ] Preview panel (largest offender) screenshots match before and after in both themes except intended token corrections.
- **Verify:** `bun run --cwd packages/oxlint-plugin test -- src/__tests__/no-raw-color.test.ts src/__tests__/no-raw-shadow.test.ts`, new rule tests for `mcode/no-raw-color` and `mcode/no-raw-shadow` (prior art `no-native-title-tooltip.test.ts`). Live: Browser panel, image lightbox, terminal colours.

### F-11b Type size, layer and motion sweep with lint guards

- **Blocked by:** F-01b Token vocabulary rename.
- **Boards:** Typography (`2-0`), States and motion (`81F-0`)
- **Delivers:** No arbitrary font sizes or numeric z-index remain; shared animations use the motion tokens.
- **Build notes:** Map `text-[10px]`, `[10.5px]`, `[11px]`, `[11.5px]` to the caption role and `[13px]`, `[14px]`, `[15px]` to body-small or label; where 10px was a deliberate micro-label, use caption and let the slot grow (Paper has no size below 12). Map numeric z-index to layer tokens. Move shared animations (`fade-up-in`, `collapsible-down`, `collapsible-up`, `chip-enter`, `popover-enter`, `composer-popup-enter`, `overview-enter`, `diff-mode-swap`, and the `animated-collapsible.tsx` transition) to `--ease-standard` and the duration tokens, so no literal duration or curve remains on them. Section-owned animations stay for their sections. Add `mcode/no-arbitrary-text-size` and `mcode/no-numeric-z-index` at error.
- **Deletes:** ledger rows "Arbitrary font sizes", "Numeric z-index" and "Off-system easing in shared animations".
- **Acceptance criteria:**
  - [ ] Both rules at error, and `bun run --cwd packages/oxlint-plugin build`, then `bunx --no-install oxlint apps/web/src` passes.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-11b` passes.
  - [ ] No text below 12px in the sidebar, composer, overview or Review header.
- **Verify:** `bun run --cwd packages/oxlint-plugin test -- src/__tests__/no-arbitrary-text-size.test.ts src/__tests__/no-numeric-z-index.test.ts`, new rule tests for `mcode/no-arbitrary-text-size` and `mcode/no-numeric-z-index` (prior art `no-native-title-tooltip.test.ts`). Live: screenshots at 100% and 200% zoom.

### F-12 Form controls

- **Blocked by:** F-01b Token vocabulary rename.
- **Boards:** Inputs (`9KK-0`, `9QI-0`), Selection controls (`9WN-0`, `A7A-0`), Pickers · Select (`AHR-0`)
- **Delivers:** Inputs, textareas, checkboxes (with mixed), radios, switches and select triggers match Paper's states and sizes in both themes.
- **Build notes:** Input: selected fill, control-border, muted border on hover, 40 default and 32 compact, offset focus ring, invalid error border plus message, read-only. New `RadioGroup`; migrate the hand-rolled radio group in `ProjectEnvironmentPanel.tsx:317,358`. The plan wizard's `OptionTile` radio retires with the wizard in S07-09, and `SegControl` keeps its radio semantics when F-04b moves it into `ui/`. Replace the 3px focus glow on `checkbox.tsx`, `select.tsx` and `textarea.tsx` with the offset focus ring. Checkbox gains `checked="mixed"` for the commit sheet's folder rows (section 10).
- **Deletes:** ledger rows "Hand-rolled radio" and "Glow focus on fields".
- **Acceptance criteria:**
  - [ ] All states on the boards render in both themes.
  - [ ] Radio group arrow-key navigation works.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run F-12` passes.
- **Verify:** `bun run --cwd apps/web test -- src/components/ui/__tests__/radio-group.test.tsx src/features/projects/environment/__tests__/ProjectEnvironmentPanel.test.tsx`. `radio-group.test.tsx` is new (keyboard); `ProjectEnvironmentPanel.test.tsx` already drives the hand-rolled radios by role and must pass on `RadioGroup`. Live: Settings forms and a dialog form.

### F-99 Dead code sweep

- **Blocked by:** Every other ticket in this program (see tickets.md).
- **Boards:** None
- **Delivers:** Proof that every retirement the program declared has happened, and a CI check that stops new dead code from landing. It is not a cleanup of code this design does not replace.
- **Build notes:**
  1. Run `node docs/plans/ready-for-build/tools/graph.mjs ledger` (every row in every section has one active owner and a runnable proof), then `node docs/plans/ready-for-build/tools/graph.mjs ledger-run` with no ticket argument, which runs every `rg` proof in every section.
  2. Investigate each FAIL before touching code. A leftover the owning ticket should have removed is a bug against that ticket: fix it here when the fix is the deletion the ledger row already names, otherwise reopen the owner. A hit on a name the design keeps on purpose means the proof is too broad: narrow the proof in its section doc and leave the code alone.
  3. `ledger-run` executes every declared proof, `rg` searches and named `bun` commands alike, and prints pass, fail, error and skip counts. Treat any failure, error or skip as unfinished work.
  4. Configure knip, a root devDependency with no config today (`package.json:27,53`): a `knip.json` with workspaces (`apps/*`, `packages/*`), entry points (web `src/main.tsx`, desktop main and preload, server entry) and ignores for generated files. Run `bun run lint:deadcode`. A finding that matches a ledger row is handled as in step 2. Anything else predates this program or sits outside it: do not delete it here. Record it in knip's ignore list with a one-line reason and list it in one follow-up issue.
  5. Add `bun run lint:deadcode` to the `lint` job in `.github/workflows/ci.yml` (beside `bun run lint`, `ci.yml:101`), so new dead code fails CI from now on.
- **Deletes:** Nothing of its own. Leftovers found in steps 1 to 3 are deleted under the ledger row that already names them.
- **Acceptance criteria:**
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger` prints ok.
  - [ ] `node docs/plans/ready-for-build/tools/graph.mjs ledger-run` exits 0; the PR pastes its output.
  - [ ] Every non-`rg` proof named in the ledgers passes; the PR lists each command with its result.
  - [ ] `bun run lint:deadcode` exits 0 with the committed config; every ignore entry has a reason and appears in the follow-up issue.
  - [ ] CI runs `bun run lint:deadcode`.
- **Verify:** `node docs/plans/ready-for-build/tools/graph.mjs ledger`, `node docs/plans/ready-for-build/tools/graph.mjs ledger-run` (no ticket id, so it runs every proof) and `bunx --no-install knip` (what `bun run lint:deadcode` runs), with output pasted in the PR, and the knip step visible in the PR's CI run.

## Tests

- **Token parity:** `apps/web/src/__tests__/design-tokens.test.ts` against `design-tokens.paper.json`. The highest-value test in this brief: it is the one place where Paper drift shows up in CI.
- **Lint rules:** one test file per new rule under `packages/oxlint-plugin/src/__tests__/`, prior art `no-native-title-tooltip.test.ts`.
- **Behaviour at the primitive seam:** button loading and split-button keyboard order, menu disabled reason and focus return (prior art `components/ui/context-menu.test.tsx`), picker paging and tab switching, toast lifetime, hover pause and cap with fake timers, status-mark accessible names, radio keyboard. Skip tests that only assert class names.
- **Live checks:** Electron harness per `.agents/skills/electorn-live-testing/SKILL.md`, both themes, fixture repo only. Every primitive ticket attaches before and after screenshots.

## Risks and open questions

Questions for the user (product or Paper calls):

1. **Icon family.** The style guide Iconography board (`81E-0`) and every screen on `p-6-0` use Lucide at 1.5px, but the Components page buttons board says "Phosphor icons" (`8O3-0`) and many component specimens still draw Phosphor glyphs (for example the loading icon in `8PO-0`). I moved DESIGN.md to Lucide. Confirm, and sweep the Components page.
2. **Overlay shadow.** The style guide says popover `0 8px 24px` at 24% black (`81D-0`), but every menu and picker on the Components page and screens uses `0 16px 40px` at 45% (`#00000073`, for example `2BSC-2`, `17RZ-2`), hover cards use `0 12px 32px` at 28%, and toasts and floating buttons use `0 8px 24px` at 40%. DESIGN.md follows the style guide for popovers and adds `floating` for toasts. Which value should menus use?
3. **Picker surface off-token values.** 03b uses radius 12, padding 6, a 34px search row and 3px segmented padding (`2BSC-2`, `2BSD-2`, `2BSH-2`); Paper tokens have no 12 radius and the grid is 4px. DESIGN.md uses radius 14, padding 8, 32px rows. Confirm.
4. **Sidebar width label.** `5-0` still says "Sidebar 256px" while `--container-sidebar` is 304. Fix the board.
5. **Terminal type.** 12a sets the terminal to mono 13/20, off the type scale (code is 14/20). Add a terminal role, or use 14 or 12?
6. **Spinner sizes.** `B4I-0` shows XS 10 and SM 13, off the 4px scale. Use 12 and 16?
7. **Inline action targets.** Paper uses 24px and 28px inline buttons (toast close, overview row Stop, per-file actions) against DESIGN.md's 32px minimum. DESIGN.md now allows them inside a larger row target with 4px spacing. Confirm.
8. **Off-scale motion.** Toast swipe exit 160ms and stack reflow 200ms sit off the 120 / 180 / 240 scale. Keep as locked, or snap to 180?
9. **Light theme selected state.** Paper sets light hover, light selected and light page all to neutral-100, so a selected row in the sidebar (on page) is invisible. Intended, or should light selected be neutral-200?
10. **One toast lane.** Implementation notes leave open whether existing app toasts move to the top-centre lane. F-07b assumes yes (one lane, one primitive). Confirm.
11. **Next-Step Slot.** 08 made Review on the changes bar neutral, not amber. DESIGN.md now says "at most one" amber next step. Does the amber Next-Step Slot still exist for finished turns, or only for failed and interrupted end notices?
12. **Stale Components boards.** Thread markers still read "Errored" with an amber running spinner (`B6V-0`); the Toasts board shows the old card style (`JRS-0`); Composer Send says "circular shape for composer Send only" (`9KI-0`), contradicting the round 32 decision. Update those boards so section authors do not copy them.
13. **Light overlay shadow.** Paper only defines one light overlay shadow (model picker). DESIGN.md uses it for every light overlay. Confirm.
14. **Right panel default width.** 07e shows a 536 panel at 1440; DESIGN.md keeps `60rem`. Section 12 should settle it.
15. **Model picker behaviour with no owner.** `189C-2` draws more than a restyle: a reasoning, context and Fast flyout beside the hovered model (today a separate `ComposerModelPreferences` control), Ctrl+1 to 4 on favourites, a folded "Legacy models" row, and a "Switch" that hands a started thread to another provider. Cross-provider switching does not exist on the server (`04-08f-thread-start-and-turn-endings.md`, open question 3). F-04c migrates the existing picker only. Should these get their own ticket in this program, or go to the design backlog?

Risks (checkable, owner noted):

- **Line-height change is global (F-01a).** `text-sm` is used on 202 lines and `text-xs` on 718; changing `text-sm` to 14/20 grows many rows by 4px. Mitigation: screenshots in F-01a and F-11b. Owner: F-01a implementer.
- **Codemod collision (F-01b).** `muted` changes meaning: old `bg-muted` is a surface, new `bg-muted` is the muted text colour. A chained rename (`bg-muted-foreground` to `bg-muted`, then `bg-muted` to `bg-hover`) would repaint 24 dots and tracks as a surface. The single-pass, exact-token map prevents it, and the "rename only" screenshot diff catches what a name-based proof cannot. Owner: F-01b implementer.
- **Overflow-only fade in CSS (F-02)** depends on scroll-driven animations; unverified in this Electron build (inferred supported in Chromium 134). Fallback: a small `ResizeObserver` hook. Owner: F-02 implementer.
- **Offline font load (inferred).** Public Sans loads from Google Fonts (`index.css:1`); a desktop app opened offline falls back to system UI. Bundling via fontsource would fix it. Owner: user decides; F-01a can carry it.
- **No dead-code baseline yet.** knip has no config and was not run here, so it will likely report unused code this ledger does not list. F-99 records such findings as knip ignores with a follow-up issue instead of deleting code outside this design. Owner: F-99.
- **Cross-section ownership.** Each row here has one owning ticket. Retirements owned by section tickets (pickers, the Pierre header, `CompactingBanner`, the wizard) are listed above the ledger and live in those sections' ledgers. A section ledger must not list a row this file owns (the identity glyph is F-06's, the old toast F-07b's). Owner: the section authors; `node docs/plans/ready-for-build/tools/graph.mjs ledger` and F-99's `ledger-run` show any gap.
