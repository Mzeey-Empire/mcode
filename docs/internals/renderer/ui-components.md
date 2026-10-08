# UI Component Registry

All UI primitives live in `apps/web/src/components/ui/`. **Always use these instead of raw HTML elements with custom Tailwind.** If a component does not exist for your use case, create it in `components/ui/` with proper variants so it can be reused, then use it.

## Available Components

| Component | File | Use Instead Of |
|-----------|------|----------------|
| `Button` | `button.tsx` | `<button className="...">` |
| `Input` | `input.tsx` | `<input className="...">` |
| `Badge` | `badge.tsx` | `<span className="rounded px-1.5 py-0.5 text-xs ...">` |
| `Dialog` | `dialog.tsx` | Custom modal divs |
| `DropdownMenu` | `dropdown-menu.tsx` | Custom dropdown implementations |
| `Command` | `command.tsx` | Custom search/autocomplete inputs |
| `ContextMenu` | `context-menu.tsx` | Custom right-click menus |
| `Popover` | `popover.tsx` | Custom floating panels |
| `ProviderIcon`, `ProviderDiscStack` | `provider-icon.tsx` | Importing marks from `chat/ProviderIcons.tsx`, per-file provider maps, recoloured marks |
| `ScrollArea` | `scroll-area.tsx` | `<div className="overflow-auto">` |
| `Separator` | `separator.tsx` | `<hr>` or `<div className="border-b">` |
| `Switch` | `switch.tsx` | Custom toggle implementations |
| `Tooltip` | `tooltip.tsx` | `title` attributes or custom hover text |
| `PathText` | `path-text.tsx` | Raw path strings, rtl tricks, or code that cuts a path |

## Composer overlay layers

`ComposerOverlaySurface` renders composer popups into `document.body`. Keep its
layers below application overlay primitives:

| Layer | z-index | Surfaces |
|-------|--------:|----------|
| Composer base | 10 | Local composer surface |
| Composer status | 20 | Local queued-send toast |
| Provider notice | 30 | `ComposerProviderNoticeSurface` |
| Composer menu | 40 | Slash commands, mentions, and Add to composer |
| Application overlay primitive | 50 | Dialogs, popovers, tooltips, dropdowns, and toasts |
| Desktop title-bar root | 60 | Desktop title bar and its descendants |

The notice is also hidden while the slash or mention picker is open. Do not use
an inline Tailwind z-index utility to override this order: the CSS classes own
the shared portal layers.

## Buttons

`components/ui/button.tsx` holds `Button` and `IconButton`; `components/ui/split-button.tsx` holds `SplitButton`. Values come from Paper's button boards (DESIGN.md, Buttons).

- **Sizes.** `compact` (32), `default` (40) and `comfortable` (48), plus `icon-*` boxes of the same heights and `icon-inline` (28) and `icon-inline-sm` (24) for row actions. The call-site default is `compact` because most buttons sit in dense chrome; pass `default` in dialogs, forms and docks.
- **States.** Press draws a 2px inset ring in the variant's foreground and never moves the control. Focus is a 2px outline 2px outside the control, so the gap stays transparent on any surface. Do not reintroduce `translate-y-px` or a `ring-3` glow on buttons or button-like rows.
- **Loading.** `loading` keeps the button focusable and blocks activation in the click handler instead of disabling it, so focus is not lost and the disabled opacity does not apply. Mark a leading icon `data-icon="inline-start"` and the spinner covers just that icon while the label stays visible; otherwise the spinner covers the whole content. The covered content stays in layout at `opacity-0`, so the width never changes and the label remains the accessible name. The marker is explicit because a child's element shape cannot tell an icon from a label component.
- **IconButton.** `aria-label` is required at the type level and doubles as the tooltip. `shape="round"` is the 32px top-level and panel-header control: selected fill at rest, `control-border` fill when `pressed` (or a menu it opens is expanded). `floating` makes it 40px with the floating shadow.
- **SplitButton.** The action and the chevron are two tab stops in that order; the chevron opens a `DropdownMenu` of alternates. Use the amber `default` variant only when the action is the state's primary. `menuBeside` opens the menu beside the card holding the control, through F-07a's `sidePlacement`.
- **Composer Send and Stop.** Send is a round `default` button; Stop is the round `ink` variant, neutral by rule.

```tsx
<Button variant="ghost">Cancel</Button>
<Button size="default" variant="destructive" loading={deleting}>Delete thread</Button>
<IconButton shape="round" aria-label="Wrap lines" pressed={wrap} onClick={toggleWrap}><WrapText /></IconButton>
```

## Input Sizes

```tsx
// Sizes: xs/sm/default = small (h-8, text-sm), md = medium (h-12, text-base), lg = large (h-14, text-lg)
<Input placeholder="Default input" />
<Input size="sm" placeholder="Compact search input" />
<Input size="md" placeholder="Dialog input" />
```

## Badge Variants

```tsx
// Variants: default, secondary, destructive, outline, ghost, link
// Sizes: default (h-5, text-xs, px-2), sm (h-4, text-xs, px-1)
// Badge is a passive-label exception: compact caption sizing is allowed here, not for interactive controls.
<Badge variant="secondary">Status</Badge>
<Badge variant="secondary" size="sm">Tag</Badge>
```

## Rules

1. **Never use raw `<button>` with Tailwind classes.** Use `<Button>` with the appropriate variant and size.
2. **Never use raw `<input>` with Tailwind classes.** Use `<Input>` with the appropriate size.
3. **Never use styled `<span>` for status labels or counts.** Use `<Badge>` with the appropriate variant and size.
4. **If no existing component fits**, create a new one in `components/ui/` with CVA variants following the existing pattern. Then use it wherever needed.
5. **Stick to the documented Tailwind text scale** (`text-xs` through `text-5xl`). Do not use arbitrary values like `text-[10px]` or `text-[11px]` unless the value is an audited exception.
6. **Fade overflowing text with `text-fade`** (or `text-fade-lines-N` for a vertical clamp). `mcode/no-ellipsis-truncation` rejects `truncate`, `text-ellipsis` and `line-clamp-*`. The fade is a mask over the element's whole box, so put `text-fade` on a text element without its own fill, border or shadow, and wrap the text in an inner span when it has one. The mask only applies while the element overflows: it rides a scroll-driven animation, so do not add another `animation` to the same element.

## Testing UI Changes

Vitest and Testing Library protect component behavior and store logic. State, layout, and visual regressions also need live inspection because they depend on the running browser or Electron renderer.

### Focused test scope

Start with focused Vitest or Testing Library coverage when you touch:

- **Interactive chat/sidebar components:** `Composer.tsx`, `MessageList.tsx`, `HeaderActions.tsx`, `RightPanel*`, `ProjectTree.tsx`, `ChatView.tsx`, `DiffToolbar.tsx`.
- **Responsive layout:** anything that flips behaviour at a breakpoint or on container width, including consumers of `useElementWidth` / `useMediaQuery`, popover-vs-inline switches, and CSS `md:` / `lg:` branches.
- **Accessibility semantics:** `role`, `aria-*`, focus traps, `dialog` wiring, keyboard shortcuts, command-registry entries.
- **Theme or token surfaces:** `index.css`, OKLCH token values, `--page` / `--background` / font-stack changes.
- **Floating panels, overlays, modals:** anything that renders into a portal or depends on z-index stacking.
- **State persistence that affects first paint:** localStorage-backed state like thread-list expansion, sidebar width, panel visibility.

### When live UI verification can be skipped

- Pure type or contract refactors with no DOM change.
- Server-only edits (`apps/server/**`) that the web layer doesn't surface in the current change set.
- Store or reducer logic with no rendered behavior change.
- Comment-, docstring-, or doc-only edits.
- Backend-only test additions.

### Minimum check

Add or update the nearest focused test. Run it.

Use `$electorn-live-testing` when the user requests live proof or the focused
test cannot cover an Electron-only boundary. Check the exact state, interaction,
accessibility data, console output, and viewport. Store temporary scripts under
`.dev/playwright-scratch` and evidence under `.dev/verification/`.
