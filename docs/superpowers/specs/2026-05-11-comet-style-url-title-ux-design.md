# Comet-style URL/title omnibox

Replace the 3-row preview toolbar (URL input, icon toolbar, page title) with a 2-row layout where the URL input doubles as a page title display. When blurred and a page is loaded, the input shows the favicon and page title. When focused, it shows the editable URL with text selected. This eliminates the dedicated title row and saves vertical space.

## Decisions

| Question | Answer |
|----------|--------|
| Layout | Merge URL input and page title into a single smart omnibox |
| Favicon | Show favicon from Electron's `page-favicon-updated` alongside the title |
| Empty state | Placeholder "Search or enter URL", no icon until a page loads |
| Blur without submit | Keep the user's draft URL visible (don't revert to title) |
| Capture pill-bar | Move `[Esc] Cancel` inline into the toolbar row, remove 28px overlay extension |

## Component architecture

Two new files co-located with `PreviewPanel`:

- `apps/web/src/components/panels/SmartOmnibox.tsx` - the component
- `apps/web/src/components/panels/useOmniboxState.ts` - the state hook

### SmartOmnibox props

```ts
interface SmartOmniboxProps {
  /** Current URL from last navigation */
  url: string;
  /** Page title from last navigation */
  pageTitle: string | null;
  /** Favicon URL from page-favicon-updated */
  faviconUrl: string | null;
  /** Called when user submits a URL (Enter or Go) */
  onNavigate: (url: string) => void;
}
```

### Component tree

```
PreviewPanel
├── <form>
│   ├── SmartOmnibox            ← NEW (replaces URL input + Go button)
│   ├── Toolbar row             ← unchanged icons
│   │   └── [Esc] Cancel pill   ← inline during capture mode
│   └── Nav error <p>           ← unchanged
│
└── BrowserView surface         ← unchanged
```

The page title `<p>` row is removed entirely.

## Omnibox state machine

### useOmniboxState hook

**Inputs (from props):**

- `url` - last navigated URL
- `pageTitle` - page title or null
- `faviconUrl` - favicon URL or null

**Internal state:**

- `isFocused` - whether the input has focus
- `draftUrl` - what the user is typing (diverges from `url` on edit)
- `isDirty` - true when `draftUrl` differs from `url`

**Derived values (returned to component):**

- `displayValue` - what the `<Input>` shows:
  - Focused: `draftUrl`
  - Blurred + dirty: `draftUrl` (preserve user's draft)
  - Blurred + clean + has title: `pageTitle`
  - Blurred + clean + no title: `url`
- `showFavicon` - true when blurred + clean + has title + has favicon
- `showAsTitle` - true when displaying title (applies `font-medium cursor-default` vs `cursor-text`)

**Handlers:**

- `onFocus` - set `isFocused`, populate `draftUrl` from `url`, select all text
- `onBlur` - clear `isFocused` (keep `draftUrl` as-is)
- `onChange` - update `draftUrl`, mark dirty
- `onSubmit` - call `onNavigate(draftUrl)`, clear dirty flag

### State transitions

```
Empty (no page)          ──navigate──>  Blurred (page loaded)
"Search or enter URL"                   favicon + "Page Title"
no icon, editable                       read-only appearance

Blurred (page loaded)    ──click/focus──>  Focused (editing)
favicon + "Page Title"                     full URL, selected, focus ring
cursor: default

Focused (editing)        ──blur──>  Blurred OR Draft
                                    if dirty: shows draftUrl
                                    if clean: shows title + favicon

Focused (editing)        ──submit──>  Blurred (page loaded)
                                      navigation fires, dirty clears
                                      title/favicon update on did-navigate
```

### Blur-preserves-draft behavior

When the user types in the omnibox but doesn't submit (clicks away), the field keeps showing their draft URL. They can click back to resume editing. When a navigation completes (new `preview:did-navigate` event), `draftUrl` syncs to the new URL, dirty clears, and the field reverts to showing the title.

## Favicon IPC flow

### Main process (preview-browser.ts)

Add a `page-favicon-updated` listener alongside the existing navigation listeners. Electron fires this event with a `string[]` of all declared favicon URLs. Store the array on the preview session state object (`s.lastFavicons`), pick `[0]` (the smallest icon, typically 16x16 or 32x32), and send it via a dedicated IPC channel.

Add `lastFavicons: string[]` to the `PreviewSession` interface. Also add `page-favicon-updated` to the `detachViewListeners` helper to avoid listener leaks when a view is parked.

**Separate IPC channel for favicon:** Electron's `page-favicon-updated` fires after `did-navigate`. If we piggyback on `forwardNav`, the first `did-navigate` call sends `favicon: null` (favicons not yet loaded), and the favicon only arrives on a second call. Instead, use a dedicated `preview:did-update-favicon` IPC push:

```
view.webContents.on("page-favicon-updated", (_e, urls) => {
  s.lastFavicons = urls;
  if (!win.isDestroyed()) {
    win.webContents.send("preview:did-update-favicon", {
      favicon: urls[0] ?? null,
    });
  }
});
```

The `forwardNav` function still includes `favicon: s.lastFavicons?.[0] ?? null` in the `preview:did-navigate` payload as a best-effort (covers in-page navigations where favicons are already cached). But the dedicated channel is the primary delivery path for fresh page loads.

### Preload bridge (preload.ts)

Add an `onDidUpdateFavicon` listener alongside the existing `onDidNavigate`:

```ts
onDidUpdateFavicon: (cb: (p: { favicon: string | null }) => void) => {
  const handler = (_e: IpcRendererEvent, p: { favicon: string | null }) => cb(p);
  ipcRenderer.on("preview:did-update-favicon", handler);
  return () => ipcRenderer.removeListener("preview:did-update-favicon", handler);
},
```

### React renderer (PreviewPanel.tsx)

Add `faviconUrl` local state. Set it from two sources:
1. `p.favicon ?? null` in the `onDidNavigate` handler (best-effort, may be null on first load)
2. `p.favicon` in a new `onDidUpdateFavicon` handler (primary path, fires after favicon loads)

Pass as prop to `SmartOmnibox`.

### Favicon rendering

- 14x14 `<img>` with `rounded-sm` and `loading="eager"`, shown only when `showFavicon` is true
- `onError` hides the image silently (no fallback icon)
- No favicon in empty state or when focused

## Capture mode cancel pill

### Current state

The overlay templates (`REGION_OVERLAY_DATA_URL` and `ELEMENT_OVERLAY_DATA_URL`) contain inline `<div>` elements with an Esc/Cancel click handler that invoke `preview:region-overlay-cancel` or `preview:element-pick-cancel` via `ipcRenderer.invoke`. These handlers validate that `event.sender` belongs to the overlay `BrowserWindow` (checking `s.selectionOverlay?.id === overlayWin.id`). The overlay also handles the Esc keyboard shortcut.

No pill-bar strip or `OVERLAY_PILL_HEIGHT` constant exists in the current codebase - the Esc UI is part of the overlay content itself.

### New IPC channel for shell-originated cancel

The existing cancel handlers (`preview:region-overlay-cancel`, `preview:element-pick-cancel`) validate that the sender is the overlay window. A cancel from the React toolbar would come from the main renderer window, so those handlers would reject it.

Add a new `preview:cancel-capture` IPC handler that accepts calls from the main renderer window:

```ts
ipcMain.handle("preview:cancel-capture", (event): void => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const s = getSession(win);
  if (!s.selectionOverlay || !s.overlayPending) return;
  abortOverlayCapture(s, "cancelled");
});
```

This validates the sender is the parent window (not the overlay) and calls the same `abortOverlayCapture` function. Add the corresponding `cancelCapture` method to the preload bridge.

### Overlay Esc handling unchanged

The overlay's keyboard Esc handler and inline cancel UI stay as-is. They still work via the existing overlay-scoped IPC channels. The inline toolbar pill is an additional cancel path, not a replacement.

### Add inline toolbar pill

When `anyCaptureActive` is true (specifically `regionBusy || elementPickBusy`), render a cancel pill right-aligned in the toolbar row:

- Subtle red tint: `bg-destructive/10 border-destructive/20 text-destructive/80`
- Contains `Esc Cancel` text
- Click handler calls `preview.cancelCapture()` via the new IPC channel
- Only shown for `regionBusy` or `elementPickBusy` (overlay-based captures). Not shown for `captureBusy` (instant viewport screenshot) or `contextBusy` (async text extraction with no overlay - no cancellation path exists)

The pill uses a flex spacer to push it to the right edge of the toolbar, away from the icon groups.

### Net effect

- Cancel action lives where the user's eyes already are (the toolbar)
- Overlay cancel UI stays as a redundant path (user can click either)
- No changes to overlay window sizing or coordinate math

## Files changed

### New files

| File | Purpose |
|------|---------|
| `apps/web/src/components/panels/SmartOmnibox.tsx` | Smart omnibox component |
| `apps/web/src/components/panels/useOmniboxState.ts` | Focus/blur/draft state hook |

### Modified files

| File | Changes |
|------|---------|
| `apps/web/src/components/panels/PreviewPanel.tsx` | Replace URL input with SmartOmnibox, add `faviconUrl` state, delete title `<p>` row, add inline capture cancel pill to toolbar |
| `apps/desktop/src/main/preview-browser.ts` | Add `lastFavicons` to `PreviewSession` interface, add `page-favicon-updated` listener, add `preview:did-update-favicon` IPC push, include favicon in `forwardNav` payload, add `preview:cancel-capture` IPC handler |
| `apps/desktop/src/main/preload.ts` | Add `onDidUpdateFavicon` listener, add `cancelCapture` method, update `preview:did-navigate` payload type to include optional `favicon` field |

### No changes needed

- `packages/contracts/` - IPC payloads are not in the contracts package
- `apps/web/src/stores/diffStore.ts` - favicon is transient display state, not persisted
- Overlay keyboard Esc handling - stays on the overlay, unaffected
