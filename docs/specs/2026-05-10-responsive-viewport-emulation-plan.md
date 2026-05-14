# Responsive Viewport Emulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add device viewport emulation to the browser preview panel so users can test responsive layouts at phone, tablet, and desktop sizes with correct DPR, user agent, and viewport dimensions.

**Architecture:** The renderer sends a `PreviewDeviceEmulationConfig` (off/preset/custom) on every `preview:sync` call. The main process resolves it to CSS dimensions, centers/scales the BrowserView inside the panel, and calls `webContents.enableDeviceEmulation()`. Helper functions in `preview-device-emulation.ts` already exist for resolution, layout, and application. The UI uses a searchable Popover+Command picker inline in the toolbar with an inline custom dimension editor (no dialog).

**Tech Stack:** Electron BrowserView, `webContents.enableDeviceEmulation()`, React, Zustand, cmdk (Command), base-ui (Popover), Tailwind CSS, lucide-react icons.

**Design spec:** `docs/specs/2026-05-10-responsive-viewport-emulation-design.md`

**Existing code to build on:**
- Contract types: `packages/contracts/src/models/preview-device-emulation.ts` (presets, schemas, types)
- Desktop helpers: `apps/desktop/src/main/preview-device-emulation.ts` (resolve, layout, apply, snapshot)
- Store state: `apps/web/src/stores/diffStore.ts` has `previewDeviceEmulationByThread` and `setPreviewDeviceEmulationForThread`
- Bridge types: `apps/web/src/transport/desktop-bridge.d.ts` already accepts `deviceEmulation` in `preview:sync` payload
- Preload: `apps/desktop/src/main/preload.ts` already passes `deviceEmulation` in sync payload (line 144)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/desktop/src/main/preview-browser.ts` | Modify | Add emulation state to PreviewSession, integrate layout+emulation in sync handler, add emulation fields to capture payloads |
| `apps/desktop/src/main/preview-device-emulation.ts` | Exists | Already has `resolvePreviewDeviceEmulation`, `layoutGuestBoundsForEmulation`, `applyPreviewDeviceEmulation`, `buildCaptureEmulationSnapshot` |
| `apps/web/src/components/panels/PreviewPanel.tsx` | Modify | Add device picker UI, inline custom editor, pass deviceEmulation in pushSync, show bg-muted when emulated |
| `packages/contracts/src/models/preview-device-emulation.ts` | Exists | Presets, schemas, types |
| `apps/web/src/stores/diffStore.ts` | Exists | Already has per-thread emulation state |
| `apps/desktop/src/main/preload.ts` | Exists | Already passes deviceEmulation in sync |
| `apps/web/src/transport/desktop-bridge.d.ts` | Exists | Already typed |

---

### Task 1: Main Process - Add Emulation State to PreviewSession

**Files:**
- Modify: `apps/desktop/src/main/preview-browser.ts` (lines 1-20 imports, lines 89-146 PreviewSession + getSession)

- [ ] **Step 1: Add imports from preview-device-emulation**

At the top of `preview-browser.ts`, add the import after the existing `@mcode/shared` import (around line 19):

```typescript
import {
  applyPreviewDeviceEmulation,
  buildCaptureEmulationSnapshot,
  buildPreviewMobileUserAgent,
  layoutGuestBoundsForEmulation,
  resolvePreviewDeviceEmulation,
} from "./preview-device-emulation.js";
```

Also add contract imports. Find the existing `from "@mcode/contracts"` import block and add:

```typescript
import {
  // ... existing imports ...
  PreviewDeviceEmulationConfigSchema,
  type McodeBrowserCaptureEmulation,
  type PreviewDeviceEmulationConfig,
} from "@mcode/contracts";
```

- [ ] **Step 2: Extend PreviewSession interface**

Find the `PreviewSession` interface (line 89). Add these fields before the closing brace:

```typescript
  /** Per-thread device emulation config from the renderer (synced on each preview:sync). */
  deviceEmulationConfig: PreviewDeviceEmulationConfig;
  /** Full shell surface rect for emulation layout (the panel bounds before centering). */
  shellBounds: Bounds | null;
  /** Default Chromium user agent captured when the view was created (restored when emulation turns off). */
  defaultGuestUserAgent: string;
  /** Structured emulation metadata included on v2 captures (null when emulation is off). */
  captureEmulationSnapshot: McodeBrowserCaptureEmulation | null;
```

- [ ] **Step 3: Initialize new fields in getSession**

Find `getSession()` (line 127). Add the new field initializers alongside existing ones:

```typescript
      deviceEmulationConfig: { kind: "off" },
      shellBounds: null,
      defaultGuestUserAgent: "",
      captureEmulationSnapshot: null,
```

- [ ] **Step 4: Capture default UA in ensureView**

Find `ensureView()` (line 1239). After `s.view = view;` (around line 1358), add:

```typescript
    try {
      s.defaultGuestUserAgent = view.webContents.getUserAgent();
    } catch {
      s.defaultGuestUserAgent = "";
    }
```

- [ ] **Step 5: Clear emulation state in parkPreview**

Find `parkPreview()` (line 1192). After `s.view = null;` (around line 1207), add:

```typescript
    s.captureEmulationSnapshot = null;
```

- [ ] **Step 6: Verify compilation**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/preview-browser.ts
git commit -m "feat(preview): add emulation state fields to PreviewSession"
```

---

### Task 2: Main Process - Layout and Emulation in Sync Handler

**Files:**
- Modify: `apps/desktop/src/main/preview-browser.ts` (preview:sync handler around line 1632, and a new `layoutPreviewGuest` function)

- [ ] **Step 1: Add layoutPreviewGuest function**

Add this function after `getSession()` (around line 147), before any IPC handler registration:

```typescript
/**
 * Centers the guest BrowserView inside the shell surface and applies device emulation when enabled.
 */
function layoutPreviewGuest(s: PreviewSession): void {
  if (!s.view || s.view.webContents.isDestroyed() || !s.shellBounds) return;
  const sh = s.shellBounds;
  const wc = s.view.webContents;

  const resolved = resolvePreviewDeviceEmulation(s.deviceEmulationConfig);

  if (!resolved) {
    // Desktop mode: fill the panel, disable any prior emulation
    s.view.setBounds(sh);
    s.lastBounds = { ...sh };
    s.captureEmulationSnapshot = null;
    if (s.defaultGuestUserAgent) {
      try {
        wc.disableDeviceEmulation();
        wc.setUserAgent(s.defaultGuestUserAgent);
      } catch { /* view tearing down */ }
    }
    return;
  }

  try {
    const { guest, scaleToFit } = layoutGuestBoundsForEmulation(sh, resolved.cssWidth, resolved.cssHeight);
    const safeScale = Number.isFinite(scaleToFit) && scaleToFit > 0 ? Math.min(scaleToFit, 1) : 1;
    s.view.setBounds(guest);
    s.lastBounds = { ...guest };

    const chromeV = process.versions.chrome ?? "120.0.0.0";
    const mobileUa = buildPreviewMobileUserAgent(chromeV);
    applyPreviewDeviceEmulation(wc, {
      active: true,
      cssViewport: { width: resolved.cssWidth, height: resolved.cssHeight },
      deviceScaleFactor: resolved.deviceScaleFactor,
      scaleToFit: safeScale,
      mobileUserAgent: mobileUa,
      defaultUserAgent: s.defaultGuestUserAgent,
    });

    s.captureEmulationSnapshot = buildCaptureEmulationSnapshot(
      s.deviceEmulationConfig,
      resolved,
      safeScale,
      mobileUa,
    );
  } catch (err) {
    console.warn("[preview-browser] device emulation failed; falling back to desktop layout:", err);
    s.view.setBounds(sh);
    s.lastBounds = { ...sh };
    s.captureEmulationSnapshot = null;
  }
}
```

- [ ] **Step 2: Modify preview:sync handler to parse emulation config**

Find the `preview:sync` handler (line 1632). The payload type already includes `deviceEmulation?: unknown` from the preload changes.

After the line that sets `s.workspaceId` (around line 1649), add emulation config parsing:

```typescript
      const rawEmu = payload.deviceEmulation ?? { kind: "off" };
      const emParsed = PreviewDeviceEmulationConfigSchema().safeParse(rawEmu);
      s.deviceEmulationConfig = emParsed.success ? emParsed.data : { kind: "off" };
```

- [ ] **Step 3: Replace setBounds with layoutPreviewGuest in sync handler**

Find the line `s.lastBounds = { ... }` followed by `view.setBounds(s.lastBounds)` in the sync handler (around lines 1656-1658). Replace with:

```typescript
      s.shellBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      const view = ensureView(win, s);
      layoutPreviewGuest(s);
```

Remove the old `s.lastBounds = ...` and `view.setBounds(s.lastBounds)` lines that were there.

- [ ] **Step 4: Re-apply emulation after page loads**

Find the `did-finish-load` listener in `ensureView()` (around line 1336). Add emulation re-apply after the scrollbar injection:

```typescript
  view.webContents.on("did-finish-load", () => {
    void injectPreviewScrollbarStyles(s);
    // Re-apply deferred emulation after the guest loads a real document
    if (s.deviceEmulationConfig.kind !== "off" && !s.captureEmulationSnapshot) {
      layoutPreviewGuest(s);
    }
  });
```

- [ ] **Step 5: Verify compilation**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/preview-browser.ts
git commit -m "feat(preview): integrate device emulation layout in sync handler"
```

---

### Task 3: Main Process - Emulation Metadata in Captures

**Files:**
- Modify: `apps/desktop/src/main/preview-browser.ts` (capture handlers and `buildBrowserCapturePayload`)

- [ ] **Step 1: Add emulation field to buildBrowserCapturePayload extras**

Find `buildBrowserCapturePayload()` (search for `async function buildBrowserCapturePayload`). In the `extras` parameter type, add:

```typescript
    emulation?: McodeBrowserCaptureEmulation;
```

Inside the function body, after the `captureKind` assignment, add:

```typescript
  if (extras?.emulation) {
    out.emulation = { ...extras.emulation };
  }
```

- [ ] **Step 2: Pass emulation snapshot in capture calls**

Find each capture handler (`preview:capture-picture-reference`, `preview:capture-picture-reference-region`, `preview:capture-picture-reference-element-pick`, `preview:capture-page-context`). In the `buildBrowserCapturePayload` call's extras object, add:

```typescript
          emulation: s.captureEmulationSnapshot ?? undefined,
```

There are 4 capture handlers to update. Search for `captureKind:` to find them all.

- [ ] **Step 3: Verify compilation**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/preview-browser.ts
git commit -m "feat(preview): include emulation metadata in capture payloads"
```

---

### Task 4: Renderer - Pass Emulation Config in pushSync

**Files:**
- Modify: `apps/web/src/components/panels/PreviewPanel.tsx` (pushSync callback, around line 142)

- [ ] **Step 1: Import emulation types and store selector**

Add to the existing `@mcode/contracts` import block:

```typescript
import {
  MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
  PREVIEW_DEVICE_EMULATION_OFF,
  type PreviewDeviceEmulationConfig,
} from "@mcode/contracts";
```

- [ ] **Step 2: Add emulation store selector**

After the existing `storedUrl` selector (around line 120), add:

```typescript
  const deviceEmu = useDiffStore(
    (s) => s.previewDeviceEmulationByThread[threadId] ?? PREVIEW_DEVICE_EMULATION_OFF,
  );
  const setDeviceEmu = useDiffStore((s) => s.setPreviewDeviceEmulationForThread);
```

- [ ] **Step 3: Pass deviceEmulation in pushSync**

Find `pushSync` (around line 142). In both the `visible: false` and `visible: true` calls to `preview.sync()`, add `deviceEmulation`:

```typescript
        await preview.sync({
          visible: false,
          bounds: null,
          threadId,
          resumeUrlHint: hint,
          workspaceId: workspaceId ?? null,
          deviceEmulation: deviceEmu,
        });
```

And for the visible path:

```typescript
        await preview.sync({
          visible: true,
          bounds: { ... },
          threadId,
          resumeUrlHint: hint,
          workspaceId: workspaceId ?? null,
          deviceEmulation: deviceEmu,
        });
```

- [ ] **Step 4: Add deviceEmu to pushSync dependency array**

The `pushSync` useCallback currently depends on `[threadId, storedUrl, workspaceId]`. Add `deviceEmu`:

```typescript
    [threadId, storedUrl, workspaceId, deviceEmu],
```

- [ ] **Step 5: Add bg-muted to surface div when emulation is active**

Find the BrowserView surface div (search for `data-testid="preview-surface"` or the surface `<div>` with `ref={surfaceRef}`). Add conditional background:

```typescript
        className={cn(
          "... existing classes ...",
          deviceEmu.kind !== "off" && "bg-muted",
        )}
```

- [ ] **Step 6: Verify compilation**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/panels/PreviewPanel.tsx
git commit -m "feat(preview): pass device emulation config through pushSync"
```

---

### Task 5: Renderer - Device Picker UI

**Files:**
- Modify: `apps/web/src/components/panels/PreviewPanel.tsx` (toolbar section, around line 390)

- [ ] **Step 1: Add UI component imports**

Add these imports at the top of PreviewPanel.tsx:

```typescript
import {
  Check,
  ChevronsUpDown,
  MonitorSmartphone,
  Pencil,
  Repeat2,
  Settings2,
  X,
} from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandEmpty,
} from "@/components/ui/command";
import {
  BROWSER_PREVIEW_DEVICE_PRESETS,
  findBrowserPreviewDevicePreset,
} from "@mcode/contracts";
```

- [ ] **Step 2: Add display label helper**

Before the component function, add:

```typescript
function previewDeviceDisplayLabel(cfg: PreviewDeviceEmulationConfig): string {
  if (cfg.kind === "off") return "Desktop";
  if (cfg.kind === "custom") return `${cfg.width}x${cfg.height}`;
  const p = findBrowserPreviewDevicePreset(cfg.presetId);
  if (!p) return cfg.presetId;
  const w = cfg.orientation === "landscape" ? p.height : p.width;
  const h = cfg.orientation === "landscape" ? p.width : p.height;
  return `${p.label} ${w}x${h}`;
}
```

- [ ] **Step 3: Add picker state**

Inside the component, after the `setDeviceEmu` line, add:

```typescript
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const [customEditing, setCustomEditing] = useState(false);
  const [customW, setCustomW] = useState("390");
  const [customH, setCustomH] = useState("844");
  const customWRef = useRef<HTMLInputElement>(null);
```

- [ ] **Step 4: Add device picker group to the toolbar**

Find the toolbar `<div>` (search for `{/* Navigation group */}`). Before the navigation group, add the device emulation group with a separator after it:

```tsx
          {/* Device emulation group */}
          <div className="flex items-center gap-0.5">
            {customEditing ? (
              <div className="flex h-7 items-center gap-1 rounded-md border border-primary/50 bg-background px-1.5 font-mono text-xs text-primary animate-fade-up-in">
                <MonitorSmartphone className="size-3 shrink-0" aria-hidden />
                <input
                  ref={customWRef}
                  type="text"
                  inputMode="numeric"
                  className="h-5 w-12 rounded border-none bg-muted px-1 text-center text-xs outline-none focus:ring-1 focus:ring-primary/50"
                  value={customW}
                  onChange={(e) => setCustomW(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const w = Number.parseInt(customW, 10);
                      const h = Number.parseInt(customH, 10);
                      if (w >= 100 && h >= 100) {
                        setDeviceEmu(threadId, { kind: "custom", width: Math.min(w, 8192), height: Math.min(h, 8192), deviceScaleFactor: 2 });
                        setCustomEditing(false);
                      }
                    }
                    if (e.key === "Escape") setCustomEditing(false);
                  }}
                  aria-label="Viewport width"
                />
                <span className="text-muted-foreground">x</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="h-5 w-12 rounded border-none bg-muted px-1 text-center text-xs outline-none focus:ring-1 focus:ring-primary/50"
                  value={customH}
                  onChange={(e) => setCustomH(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const w = Number.parseInt(customW, 10);
                      const h = Number.parseInt(customH, 10);
                      if (w >= 100 && h >= 100) {
                        setDeviceEmu(threadId, { kind: "custom", width: Math.min(w, 8192), height: Math.min(h, 8192), deviceScaleFactor: 2 });
                        setCustomEditing(false);
                      }
                    }
                    if (e.key === "Escape") setCustomEditing(false);
                  }}
                  aria-label="Viewport height"
                />
                <Button type="button" variant="ghost" size="icon-xs" className="shrink-0 text-primary"
                  onClick={() => {
                    const w = Number.parseInt(customW, 10);
                    const h = Number.parseInt(customH, 10);
                    if (w >= 100 && h >= 100) {
                      setDeviceEmu(threadId, { kind: "custom", width: Math.min(w, 8192), height: Math.min(h, 8192), deviceScaleFactor: 2 });
                      setCustomEditing(false);
                    }
                  }}
                  aria-label="Apply custom dimensions"
                >
                  <Check size={14} aria-hidden />
                </Button>
                <Button type="button" variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground"
                  onClick={() => setCustomEditing(false)} aria-label="Cancel"
                >
                  <X size={14} aria-hidden />
                </Button>
              </div>
            ) : (
              <>
                <Popover open={devicePickerOpen} onOpenChange={setDevicePickerOpen}>
                  <PopoverTrigger
                    render={
                      <Button type="button" variant="outline" size="sm"
                        className={cn(
                          "h-7 max-w-[13rem] justify-between gap-1 px-2 font-mono text-xs",
                          deviceEmu.kind !== "off" && "border-primary/50 text-primary glow-primary",
                        )}
                        aria-label="Preview device frame"
                      >
                        <MonitorSmartphone className="size-3 shrink-0" aria-hidden />
                        <span className="truncate">{previewDeviceDisplayLabel(deviceEmu)}</span>
                        <ChevronsUpDown className="size-3 shrink-0 opacity-50" aria-hidden />
                      </Button>
                    }
                  />
                  <PopoverContent side="bottom" sideOffset={6} className="w-[15rem] p-0 font-mono text-xs">
                    <Command>
                      <CommandInput placeholder="Search devices..." className="h-8 text-xs" />
                      <CommandList>
                        <CommandEmpty>No device found.</CommandEmpty>
                        <CommandGroup>
                          <CommandItem onSelect={() => {
                            setDeviceEmu(threadId, { kind: "off" });
                            setDevicePickerOpen(false);
                          }}>
                            <Check className={cn("size-3", deviceEmu.kind === "off" ? "opacity-100" : "opacity-0")} />
                            Desktop
                          </CommandItem>
                          {BROWSER_PREVIEW_DEVICE_PRESETS.map((p) => {
                            const active = deviceEmu.kind === "preset" && deviceEmu.presetId === p.id;
                            return (
                              <CommandItem key={p.id} onSelect={() => {
                                const orientation = deviceEmu.kind === "preset" && deviceEmu.presetId === p.id
                                  ? deviceEmu.orientation : "portrait";
                                setDeviceEmu(threadId, { kind: "preset", presetId: p.id, orientation });
                                setDevicePickerOpen(false);
                              }}>
                                <Check className={cn("size-3", active ? "opacity-100" : "opacity-0")} />
                                <span className="flex-1 truncate">{p.label}</span>
                                <span className="text-muted-foreground">{p.width}x{p.height}</span>
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                        <CommandSeparator />
                        <CommandGroup>
                          <CommandItem onSelect={() => {
                            setDevicePickerOpen(false);
                            if (deviceEmu.kind === "custom") {
                              setCustomW(String(deviceEmu.width));
                              setCustomH(String(deviceEmu.height));
                            } else {
                              setCustomW("390");
                              setCustomH("844");
                            }
                            setCustomEditing(true);
                            requestAnimationFrame(() => customWRef.current?.select());
                          }}>
                            <Settings2 className="size-3" />
                            Custom...
                          </CommandItem>
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                {deviceEmu.kind === "preset" && (
                  <Tooltip>
                    <TooltipTrigger render={
                      <Button type="button" variant="ghost" size="icon-xs" className="shrink-0 text-primary"
                        onClick={() => {
                          setDeviceEmu(threadId, {
                            kind: "preset", presetId: deviceEmu.presetId,
                            orientation: deviceEmu.orientation === "portrait" ? "landscape" : "portrait",
                          });
                        }}
                        aria-label="Rotate device frame"
                      >
                        <Repeat2 size={14} aria-hidden />
                      </Button>
                    } />
                    <TooltipContent side="bottom" sideOffset={6} className="text-xs">Toggle portrait / landscape</TooltipContent>
                  </Tooltip>
                )}
                {deviceEmu.kind === "custom" && (
                  <Tooltip>
                    <TooltipTrigger render={
                      <Button type="button" variant="ghost" size="icon-xs" className="shrink-0 text-primary"
                        onClick={() => {
                          setCustomW(String(deviceEmu.width));
                          setCustomH(String(deviceEmu.height));
                          setCustomEditing(true);
                          requestAnimationFrame(() => customWRef.current?.select());
                        }}
                        aria-label="Edit custom dimensions"
                      >
                        <Pencil size={14} aria-hidden />
                      </Button>
                    } />
                    <TooltipContent side="bottom" sideOffset={6} className="text-xs">Edit dimensions</TooltipContent>
                  </Tooltip>
                )}
              </>
            )}
          </div>

          {/* Separator: device | nav */}
          <div className="mx-1 h-4 w-px bg-border/40" aria-hidden />
```

- [ ] **Step 5: Verify compilation**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Manually test in the app**

Start the dev server (`bun run dev` from project root). Open the preview panel, click the device picker, select a preset, toggle orientation, try custom dimensions, switch threads and verify state is preserved.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/panels/PreviewPanel.tsx
git commit -m "feat(preview): add searchable device picker and inline custom editor"
```

---

### Task 6: Integration Testing and Edge Cases

**Files:**
- Test: Manual testing across the full feature surface

- [ ] **Step 1: Test preset selection with loaded page**

1. Navigate to `https://example.com` in the preview
2. Select "iPhone SE" from the device picker
3. Verify: BrowserView centers in the panel with bg-muted background visible around it
4. Verify: Page renders at 375px width (responsive layout should change)
5. Verify: Trigger button shows "iPhone SE 375x667" with primary accent styling

- [ ] **Step 2: Test orientation toggle**

1. With "iPhone SE" selected, click the rotate button
2. Verify: Viewport swaps to 667x375
3. Verify: Display label updates
4. Click rotate again, verify it returns to portrait

- [ ] **Step 3: Test custom dimensions**

1. Click the device picker, select "Custom..."
2. Verify: Inline editor appears with two input fields
3. Type 412 x 900, press Enter
4. Verify: Emulation applies at those dimensions
5. Click the pencil icon to re-edit
6. Press Escape to cancel without changes

- [ ] **Step 4: Test reset to desktop**

1. With a device active, open the picker and select "Desktop"
2. Verify: BrowserView fills the panel again, bg-muted background disappears
3. Verify: Trigger returns to default styling (no primary accent)

- [ ] **Step 5: Test thread switching**

1. Select a device preset in Thread A
2. Switch to Thread B (should be desktop by default)
3. Switch back to Thread A (should restore the device preset)

- [ ] **Step 6: Test emulation on empty BrowserView**

1. Open a fresh preview with no URL loaded
2. Select a device preset
3. Verify: No crash (emulation deferred until page loads)
4. Navigate to a URL
5. Verify: Emulation applies after the page loads

- [ ] **Step 7: Test capture with emulation active**

1. With a device preset active and a page loaded
2. Capture a viewport screenshot
3. Verify: Capture succeeds and includes emulation metadata

- [ ] **Step 8: Verify no console errors**

Check the terminal running the dev server for any Electron deprecation warnings or errors during all tests above.

- [ ] **Step 9: Full type-check**

```bash
cd apps/desktop && npx tsc --noEmit
cd apps/web && npx tsc --noEmit
```
Expected: No errors in either package

- [ ] **Step 10: Commit any fixes**

If any issues were found and fixed during testing:

```bash
git add -A
git commit -m "fix(preview): address edge cases in device emulation"
```

---

## Execution Notes

- **Task ordering matters:** Tasks 1-3 are main process (desktop). Task 4-5 are renderer (web). Task 6 is integration testing. Tasks 1-3 can be done in sequence; tasks 4-5 depend on task 1-3 being done for the emulation to actually work end-to-end.
- **The helper functions already exist:** `preview-device-emulation.ts` has all the math and Electron API calls. The tasks wire them into the existing sync flow and add UI.
- **No new IPC channels needed for v1:** The `deviceEmulation` field is already in the `preview:sync` payload. The main process reads it on every sync and applies/resets accordingly. Separate `setDeviceEmulation` / `getDeviceEmulation` IPC methods from the spec are deferred; the sync-based approach is simpler and sufficient.
- **The spec mentions CDP touch emulation and media features.** These are intentionally omitted from this plan for v1 simplicity. The `applyPreviewDeviceEmulation()` function in `preview-device-emulation.ts` currently uses only `enableDeviceEmulation()` and `setUserAgent()`. CDP integration can be added in a follow-up without changing the architecture.
