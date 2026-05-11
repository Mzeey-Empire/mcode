# Comet-style URL/title omnibox - Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3-row preview toolbar with a 2-row layout where the URL input shows the page title + favicon when blurred, and the editable URL when focused.

**Architecture:** Extract URL bar into a `SmartOmnibox` component with a `useOmniboxState` hook managing focus/blur/draft transitions. Pipe favicon data from Electron's `page-favicon-updated` through a dedicated IPC channel. Move the capture-mode cancel pill from the overlay into the React toolbar row via a new `preview:cancel-capture` IPC handler.

**Tech Stack:** React, TypeScript, Electron IPC, Tailwind CSS

---

## File structure

### New files

| File | Responsibility |
|------|---------------|
| `apps/web/src/components/panels/useOmniboxState.ts` | Hook: focus/blur/draft/dirty state machine, derived display values |
| `apps/web/src/components/panels/SmartOmnibox.tsx` | Component: renders Input with favicon, title/URL switching, Go button |

### Modified files

| File | Changes |
|------|---------|
| `apps/web/src/components/ui/input.tsx` | Add ref forwarding so SmartOmnibox can call `select()` on focus |
| `apps/desktop/src/main/preview-browser.ts` | Add `lastFavicons` to `PreviewSession`, add `page-favicon-updated` listener + `preview:did-update-favicon` IPC push, add `preview:cancel-capture` handler, add `page-favicon-updated` to `detachViewListeners` |
| `apps/desktop/src/main/preload.ts` | Add `onDidUpdateFavicon` bridge method, add `cancelCapture` bridge method, update `onDidNavigate` payload type |
| `apps/web/src/transport/desktop-bridge.d.ts` | Add `onDidUpdateFavicon` and `cancelCapture` to `PreviewBridge` |
| `apps/web/src/components/panels/PreviewPanel.tsx` | Replace URL bar with SmartOmnibox, add `faviconUrl` state + IPC subscription, delete title `<p>` row, add inline cancel pill to toolbar |

---

## Chunk 1: Foundation (Input ref, hook, component)

### Task 1: Add ref forwarding to Input component

**Files:**
- Modify: `apps/web/src/components/ui/input.tsx`

The `Input` component spreads `...props` onto a native `<input>` but does not forward refs. SmartOmnibox needs an `inputRef` to call `select()` on focus.

- [ ] **Step 1: Add ref parameter to Input**

In `apps/web/src/components/ui/input.tsx`, change the `Input` function to accept and forward a `ref`:

```tsx
function Input({
  className,
  type,
  size = "default",
  ref,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants> & {
    ref?: React.Ref<HTMLInputElement>;
  }) {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(inputVariants({ size, className }))}
      {...props}
    />
  );
}
```

- [ ] **Step 2: Verify existing Input consumers still work**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors. Adding an optional `ref` prop is backwards-compatible.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/input.tsx
git commit -m "refactor: add ref forwarding to Input component"
```

---

### Task 2: Create useOmniboxState hook

**Files:**
- Create: `apps/web/src/components/panels/useOmniboxState.ts`

- [ ] **Step 1: Create the hook file**

Create `apps/web/src/components/panels/useOmniboxState.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseOmniboxStateOptions {
  /** Current URL from last navigation. */
  url: string;
  /** Page title from last navigation. */
  pageTitle: string | null;
  /** Favicon URL from page-favicon-updated. */
  faviconUrl: string | null;
}

export interface OmniboxState {
  /** Value to display in the input. */
  displayValue: string;
  /** Whether the favicon should be visible. */
  showFavicon: boolean;
  /** Whether the input is displaying the page title (controls font weight, cursor). */
  showAsTitle: boolean;
  /** Ref to attach to the input element for programmatic select(). */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Placeholder text for the input. */
  placeholder: string;
  /** Call on input focus. */
  onFocus: () => void;
  /** Call on input blur. */
  onBlur: () => void;
  /** Call on input value change. */
  onChange: (value: string) => void;
  /** Call on form submit (Enter or Go button). Returns the URL to navigate to. */
  onSubmit: () => string;
}

/**
 * State machine for the smart omnibox.
 *
 * Blurred + clean: shows page title (or URL if no title).
 * Blurred + dirty: shows the user's draft URL.
 * Focused: shows the editable URL with text selected.
 */
export function useOmniboxState({
  url,
  pageTitle,
  faviconUrl,
}: UseOmniboxStateOptions): OmniboxState {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [draftUrl, setDraftUrl] = useState(url);
  const [isDirty, setIsDirty] = useState(false);

  // Sync draftUrl when a navigation completes (new URL arrives from IPC).
  useEffect(() => {
    setDraftUrl(url);
    setIsDirty(false);
  }, [url]);

  const onFocus = useCallback(() => {
    setIsFocused(true);
    // Populate draft from current URL (not the stale draft).
    if (!isDirty) {
      setDraftUrl(url);
    }
    // Select all text after React re-renders with the URL value.
    requestAnimationFrame(() => {
      inputRef.current?.select();
    });
  }, [url, isDirty]);

  const onBlur = useCallback(() => {
    setIsFocused(false);
  }, []);

  const onChange = useCallback((value: string) => {
    setDraftUrl(value);
    setIsDirty(true);
  }, []);

  const onSubmit = useCallback((): string => {
    setIsDirty(false);
    return draftUrl;
  }, [draftUrl]);

  // Derive display value.
  let displayValue: string;
  if (isFocused) {
    displayValue = draftUrl;
  } else if (isDirty) {
    displayValue = draftUrl;
  } else if (pageTitle) {
    displayValue = pageTitle;
  } else {
    displayValue = url;
  }

  const showFavicon = !isFocused && !isDirty && !!pageTitle && !!faviconUrl;
  const showAsTitle = !isFocused && !isDirty && !!pageTitle;
  const placeholder = "Search or enter URL";

  return {
    displayValue,
    showFavicon,
    showAsTitle,
    inputRef,
    placeholder,
    onFocus,
    onBlur,
    onChange,
    onSubmit,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/panels/useOmniboxState.ts
git commit -m "feat: add useOmniboxState hook for smart omnibox"
```

---

### Task 3: Create SmartOmnibox component

**Files:**
- Create: `apps/web/src/components/panels/SmartOmnibox.tsx`

- [ ] **Step 1: Create the component file**

Create `apps/web/src/components/panels/SmartOmnibox.tsx`:

```tsx
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  useOmniboxState,
  type UseOmniboxStateOptions,
} from "./useOmniboxState";

export interface SmartOmniboxProps extends UseOmniboxStateOptions {
  /** Called when user submits a URL (Enter or Go button). */
  onNavigate: (url: string) => void;
}

/**
 * Smart omnibox that shows page title + favicon when blurred,
 * and the editable URL when focused. Replaces the plain URL input + title row.
 */
export function SmartOmnibox({
  url,
  pageTitle,
  faviconUrl,
  onNavigate,
}: SmartOmniboxProps) {
  const {
    displayValue,
    showFavicon,
    showAsTitle,
    inputRef,
    placeholder,
    onFocus,
    onBlur,
    onChange,
    onSubmit,
  } = useOmniboxState({ url, pageTitle, faviconUrl });

  const [faviconError, setFaviconError] = useState(false);

  // Reset favicon error when a new favicon URL arrives (new page load).
  useEffect(() => {
    setFaviconError(false);
  }, [faviconUrl]);

  const faviconVisible = showFavicon && !faviconError;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        {faviconVisible && faviconUrl ? (
          <img
            src={faviconUrl}
            alt=""
            width={14}
            height={14}
            loading="eager"
            className="pointer-events-none absolute top-1/2 left-2 z-10 -translate-y-1/2 rounded-sm"
            onError={() => setFaviconError(true)}
          />
        ) : null}
        <Input
          ref={inputRef}
          value={displayValue}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          size="sm"
          className={cn(
            "min-w-0 font-mono",
            faviconVisible && "pl-7",
            showAsTitle && "cursor-default font-medium",
          )}
          aria-label="Preview URL"
          title={url || undefined}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <Button
        type="submit"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2.5 text-xs"
        onClick={(e) => {
          e.preventDefault();
          const target = onSubmit();
          if (target.trim()) onNavigate(target);
        }}
      >
        Go
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/panels/SmartOmnibox.tsx
git commit -m "feat: add SmartOmnibox component with title/URL switching"
```

---

## Chunk 2: Electron IPC (favicon + cancel capture)

### Task 4: Add favicon to PreviewSession and IPC flow

**Files:**
- Modify: `apps/desktop/src/main/preview-browser.ts:84-135` (PreviewSession interface + getSession)
- Modify: `apps/desktop/src/main/preview-browser.ts:1010-1018` (detachViewListeners)
- Modify: `apps/desktop/src/main/preview-browser.ts:1222-1236` (forwardNav + listener wiring)

- [ ] **Step 1: Add `lastFavicons` to `PreviewSession`**

In `apps/desktop/src/main/preview-browser.ts`, add to the `PreviewSession` interface (after `workspaceId` field, around line 110):

```ts
  /** Favicon URLs from the last page-favicon-updated event. */
  lastFavicons: string[];
```

In the `getSession` factory default object (around line 134), add:

```ts
      lastFavicons: [],
```

- [ ] **Step 2: Add favicon to `forwardNav` payload**

In `apps/desktop/src/main/preview-browser.ts`, update the `forwardNav` function (around line 1222) to include `favicon`:

```ts
  const forwardNav = () => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    const url = view.webContents.getURL();
    if (isAllowedHttpUrl(url)) {
      s.resumePreviewUrl = url;
    }
    win.webContents.send("preview:did-navigate", {
      url,
      title: view.webContents.getTitle(),
      // Best-effort: lastFavicons is populated by page-favicon-updated which fires
      // after did-navigate, so this is often null on initial load. The dedicated
      // preview:did-update-favicon push (Step 3) is the canonical delivery path.
      favicon: s.lastFavicons[0] ?? null,
    });
  };
```

- [ ] **Step 3: Add `page-favicon-updated` listener and dedicated IPC push**

After the existing `view.webContents.on("page-title-updated", forwardNav);` line (around line 1236), add:

```ts
  view.webContents.on("page-favicon-updated", (_e, urls: string[]) => {
    s.lastFavicons = urls;
    if (!win.isDestroyed()) {
      win.webContents.send("preview:did-update-favicon", {
        favicon: urls[0] ?? null,
      });
    }
  });
```

- [ ] **Step 4: Add `page-favicon-updated` to `detachViewListeners`**

In `apps/desktop/src/main/preview-browser.ts`, inside the `detachViewListeners` function (around line 1010), add after the `page-title-updated` removal:

```ts
  view.webContents.removeAllListeners("page-favicon-updated");
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/preview-browser.ts
git commit -m "feat: pipe favicon from BrowserView via IPC"
```

---

### Task 5: Add `preview:cancel-capture` IPC handler

**Files:**
- Modify: `apps/desktop/src/main/preview-browser.ts:1665` (near existing cancel handlers)

- [ ] **Step 1: Add the handler**

In `apps/desktop/src/main/preview-browser.ts`, near the existing `preview:region-overlay-cancel` handler (around line 1665), add:

```ts
  ipcMain.handle("preview:cancel-capture", (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    if (!s.selectionOverlay) return;
    abortOverlayCapture(s, "cancelled");
  });
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/preview-browser.ts
git commit -m "feat: add preview:cancel-capture IPC for shell-originated cancel"
```

---

### Task 6: Update preload bridge and type declarations

**Files:**
- Modify: `apps/desktop/src/main/preload.ts:184-195`
- Modify: `apps/web/src/transport/desktop-bridge.d.ts:61-91`

- [ ] **Step 1: Update `onDidNavigate` payload type in preload.ts**

In `apps/desktop/src/main/preload.ts`, update the `onDidNavigate` method (around line 184) to include the optional `favicon` field:

```ts
    onDidNavigate(callback: (payload: { url: string; title: string; favicon?: string | null }) => void) {
      const listener = (_event: unknown, payload: { url: string; title: string; favicon?: string | null }) =>
        callback(payload);
      ipcRenderer.on("preview:did-navigate", listener);
      return () => ipcRenderer.removeListener("preview:did-navigate", listener);
    },
```

- [ ] **Step 2: Add `onDidUpdateFavicon` to preload.ts**

After the `onLoadingState` method (around line 195), add:

```ts
    onDidUpdateFavicon(callback: (payload: { favicon: string | null }) => void) {
      const listener = (_event: unknown, payload: { favicon: string | null }) =>
        callback(payload);
      ipcRenderer.on("preview:did-update-favicon", listener);
      return () => ipcRenderer.removeListener("preview:did-update-favicon", listener);
    },
```

- [ ] **Step 3: Add `cancelCapture` to preload.ts**

In the same `preview` object in preload.ts, add:

```ts
    cancelCapture(): Promise<void> {
      return ipcRenderer.invoke("preview:cancel-capture");
    },
```

- [ ] **Step 4: Update `PreviewBridge` in desktop-bridge.d.ts**

In `apps/web/src/transport/desktop-bridge.d.ts`, update the `PreviewBridge` interface:

Update `onDidNavigate` signature (around line 82):
```ts
  onDidNavigate(callback: (payload: { url: string; title: string; favicon?: string | null }) => void): () => void;
```

Add after `onLoadingState` (around line 83):
```ts
  onDidUpdateFavicon(callback: (payload: { favicon: string | null }) => void): () => void;
  cancelCapture(): Promise<void>;
```

- [ ] **Step 5: Typecheck desktop and web**

Run: `cd apps/desktop && npx tsc --noEmit && cd ../web && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/preload.ts apps/web/src/transport/desktop-bridge.d.ts
git commit -m "feat: add favicon and cancel-capture bridge methods"
```

---

## Chunk 3: Wire up PreviewPanel

### Task 7: Integrate SmartOmnibox into PreviewPanel

**Files:**
- Modify: `apps/web/src/components/panels/PreviewPanel.tsx:0-10` (imports)
- Modify: `apps/web/src/components/panels/PreviewPanel.tsx:102-112` (state)
- Modify: `apps/web/src/components/panels/PreviewPanel.tsx:164-180` (onDidNavigate handler)
- Modify: `apps/web/src/components/panels/PreviewPanel.tsx:431-606` (form JSX)

- [ ] **Step 1: Add imports**

In `apps/web/src/components/panels/PreviewPanel.tsx`, add to the imports:

```tsx
import { SmartOmnibox } from "./SmartOmnibox";
```

Remove `Input` from the `@/components/ui/input` import (it's no longer used directly in PreviewPanel).

- [ ] **Step 2: Add `faviconUrl` state**

After the `pageTitle` state declaration (line 112), add:

```tsx
const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
```

- [ ] **Step 3: Update `onDidNavigate` handler to set favicon**

In the `onDidNavigate` handler (around line 164-180), add `setFaviconUrl` inside the URL validity check:

```tsx
useEffect(() => {
  const preview = window.desktopBridge?.preview;
  if (!preview) return;
  const unsub = preview.onDidNavigate((p) => {
    if (
      p.url &&
      !p.url.startsWith("chrome-error://") &&
      !p.url.startsWith("about:")
    ) {
      useDiffStore.getState().setPreviewUrlForThread(threadId, p.url);
      setInputUrl(p.url);
      setPageTitle(p.title ?? null);
      setFaviconUrl(p.favicon ?? null);
    }
    void refreshNav();
  });
  return unsub;
}, [threadId, refreshNav]);
```

- [ ] **Step 4: Add `onDidUpdateFavicon` subscription**

After the `onDidNavigate` effect, add a new effect:

```tsx
useEffect(() => {
  const preview = window.desktopBridge?.preview;
  if (!preview?.onDidUpdateFavicon) return;
  return preview.onDidUpdateFavicon((p) => {
    setFaviconUrl(p.favicon);
  });
}, []);
```

- [ ] **Step 5: Replace URL bar with SmartOmnibox and delete title row**

Replace the URL bar `<div>` (lines 436-451) with:

```tsx
<SmartOmnibox
  url={inputUrl}
  pageTitle={pageTitle}
  faviconUrl={faviconUrl}
  onNavigate={(target) => {
    setInputUrl(target);
    void preview.navigate(target).then((r) => {
      if (!r.ok) setNavError(formatNavError(r.error));
    });
  }}
/>
```

Delete the page title `<p>` block (lines 594-599):

```tsx
// DELETE:
{pageTitle ? (
  <p className="truncate px-0.5 font-mono text-[10px] tracking-wide text-muted-foreground/60" title={pageTitle}>
    {pageTitle}
  </p>
) : null}
```

- [ ] **Step 6: Handle Enter key and form submission**

Two changes:

1. In `SmartOmnibox.tsx`, add an `onKeyDown` handler to the `<Input>` so Enter submits directly:

```tsx
onKeyDown={(e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const target = onSubmit();
    if (target.trim()) onNavigate(target);
  }
}}
```

2. In `PreviewPanel.tsx`, change the `<form>` `onSubmit` to a no-op since SmartOmnibox handles submission internally:

```tsx
<form
  onSubmit={(e) => e.preventDefault()}
  className="flex-none space-y-1.5 border-b border-border/40 px-2 pt-2 pb-1.5"
>
```

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/panels/PreviewPanel.tsx
git commit -m "feat: replace URL bar with SmartOmnibox, remove title row"
```

---

### Task 8: Add inline cancel pill to toolbar

**Files:**
- Modify: `apps/web/src/components/panels/PreviewPanel.tsx:454-592` (toolbar row)

- [ ] **Step 1: Add cancel pill after the external link button**

In the toolbar `<div>` (around line 454), after the external link `<Tooltip>` group and before the closing `</div>`, add:

```tsx
{/* Cancel capture pill (visible during region/element-pick capture) */}
{(regionBusy || elementPickBusy) ? (
  <>
    <div className="flex-1" />
    <button
      type="button"
      className="flex shrink-0 items-center gap-1 rounded border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive/80 transition-colors hover:bg-destructive/15"
      onClick={() => void window.desktopBridge?.preview.cancelCapture()}
    >
      <kbd className="rounded border border-destructive/15 bg-destructive/5 px-1 py-px text-[10px] font-medium">
        Esc
      </kbd>
      Cancel
    </button>
  </>
) : null}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/panels/PreviewPanel.tsx
git commit -m "feat: add inline cancel pill to toolbar during capture"
```

---

### Task 9: Typecheck all packages and test

- [ ] **Step 1: Typecheck all packages**

Run:
```bash
cd apps/server && npx tsc --noEmit
cd ../web && npx tsc --noEmit
cd ../desktop && npx tsc --noEmit
```
Expected: No errors in any package.

- [ ] **Step 2: Run unit tests**

Run: `cd apps/web && bun run test`
Expected: All existing tests pass.

- [ ] **Step 3: Manual verification**

Start the dev server and verify in the browser:
1. Empty state shows "Search or enter URL" placeholder, no icon
2. Navigate to a page - omnibox shows favicon + page title when blurred
3. Click the omnibox - switches to editable URL, text selected
4. Type a partial URL, click away - draft URL preserved
5. Submit a URL via Enter or Go - navigates, title appears after load
6. Start a region capture - cancel pill appears in toolbar
7. Click the cancel pill - capture cancels via new IPC handler
8. Start a region capture again - press Esc while overlay is active - capture cancels via overlay handler
9. Element pick capture - cancel pill appears, both cancel paths work

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -u
git commit -m "fix: address review findings from manual testing"
```
