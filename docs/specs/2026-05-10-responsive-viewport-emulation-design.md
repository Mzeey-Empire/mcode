# Responsive Viewport Emulation for Browser Preview

## Summary

Add device viewport emulation to the browser preview panel, allowing users to preview web apps at phone, tablet, and desktop sizes with correct DPR, user agent, touch emulation, and CSS media feature overrides. State is scoped per thread. The UI layers a visual device bar (primary) over a keyboard-driven command palette (power-user shortcut).

## User Personas

### 1. Frontend Web Developer

**Profile:** Builds responsive web apps with React, Vue, or similar frameworks. Tests across breakpoints daily.

**Context:** Working in Mcode on a feature branch, iterating on a component. Needs to verify that a layout works at mobile widths without leaving the editor to open Chrome DevTools or a separate browser.

**Key needs:**
- Quick switching between common phone/tablet sizes
- CSS media queries (`max-width`, `min-width`) must fire correctly at emulated dimensions
- See the actual viewport dimensions at a glance
- Custom dimension input for testing exact breakpoints (e.g., 412px for a specific snap point)

**Success criteria:** "I can check my responsive layout in the preview panel and trust that it matches what a real phone browser would render."

### 2. Mobile / Hybrid App Developer

**Profile:** Works with React Native, Capacitor, or Ionic. Builds apps that run in webviews on physical devices. Frequently tests how web content renders inside a mobile viewport.

**Key needs:**
- Accurate mobile user agent (some APIs and CSS feature detections depend on it)
- Touch emulation (`ontouchstart`, `navigator.maxTouchPoints`) for testing touch-specific code paths
- Correct `hover: none` / `pointer: coarse` media features for hiding hover-only UI
- Orientation toggle to test portrait and landscape layouts

**Success criteria:** "The preview behaves like a mobile webview, not a desktop browser at a small size."

### 3. Full-Stack Developer

**Profile:** Primarily writes backend code but occasionally touches frontend templates, responsive emails, or admin dashboards. Not a daily responsive testing user.

**Context:** Needs to verify a UI change looks reasonable on mobile before pushing. Does not need pixel-perfect fidelity.

**Key needs:**
- Discoverability: obvious how to switch to a phone view without reading docs
- One-click presets: pick "iPhone" from a list, done
- Easy reset: get back to normal desktop view quickly

**Success criteria:** "I found the mobile preview button, checked the page, and went back to desktop in under 10 seconds."

### 4. Designer-Developer

**Profile:** Works on pixel-perfect responsive implementations. Cares about device-specific rendering details like DPR, safe areas, and accurate viewport dimensions.

**Key needs:**
- Correct `devicePixelRatio` (2x, 3x) for testing retina rendering
- Precise viewport dimensions matching real device CSS viewports
- v2 interest: device chrome (notch, dynamic island) for design presentations

**Success criteria:** "The emulated viewport matches the real device closely enough to catch layout bugs before deploying to a physical device."

---

## Goals

1. Emulate phone, tablet, and desktop viewports with correct dimensions, DPR, user agent, touch, and CSS media features.
2. Provide a discoverable UI-first device picker with a power-user keyboard shortcut.
3. Scope device state per thread so switching threads restores the correct viewport.
4. Integrate cleanly with existing preview features (capture, page context, navigation, idle parking).

## Non-Goals

- Device chrome / bezels / notch rendering (deferred to v2)
- Network throttling (3G, offline simulation)
- Persisting device state to disk across app restarts
- Multi-viewport side-by-side comparison
- WebRTC or geolocation emulation

---

## Shared Types

All types live in `packages/contracts/src/models/browser-preview.ts` as Zod schemas using the existing `lazySchema` pattern.

```typescript
/** Device form factor category. */
type DeviceCategory = "phone" | "tablet" | "desktop";

/** Screen orientation. */
type DeviceOrientation = "portrait" | "landscape";

/** A device preset definition. */
interface DevicePreset {
  id: string;                    // e.g. "iphone-14-pro"
  name: string;                  // e.g. "iPhone 14 Pro"
  category: DeviceCategory;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;     // e.g. 2, 3
  mobile: boolean;               // maps to screenPosition: "mobile" | "desktop"
  hasTouch: boolean;             // triggers CDP touch emulation
  userAgent: string;             // full UA string
}

/** Payload sent from renderer to main for setDeviceEmulation. */
interface DeviceEmulationPayload {
  preset: DevicePreset | null;   // null = reset to desktop
  orientation: DeviceOrientation;
  customViewport?: { width: number; height: number; dpr: number };
}

/** Emulation state pushed from main to renderer after apply/reset. */
interface DeviceEmulationState {
  presetId: string | null;       // null = desktop (no emulation)
  orientation: DeviceOrientation;
  effectiveViewport: { width: number; height: number };
}
```

---

## Device Presets

Curated, not exhaustive. Sourced from Playwright's canonical device descriptors.

### Phones

| ID | Name | Viewport | DPR | UA Base |
|----|------|----------|-----|---------|
| `iphone-se` | iPhone SE | 375x667 | 2 | Safari/Mobile |
| `iphone-14-pro` | iPhone 14 Pro | 393x852 | 3 | Safari/Mobile |
| `galaxy-s24` | Galaxy S24 | 360x780 | 3 | Chrome/Mobile |
| `pixel-7` | Pixel 7 | 412x915 | 2.625 | Chrome/Mobile |

### Tablets

| ID | Name | Viewport | DPR | UA Base |
|----|------|----------|-----|---------|
| `ipad-air` | iPad Air | 820x1180 | 2 | Safari/Mobile |
| `ipad-pro-11` | iPad Pro 11" | 834x1194 | 2 | Safari/Mobile |
| `galaxy-tab-s9` | Galaxy Tab S9 | 640x1024 | 2.5 | Chrome |

### Desktop

| ID | Name | Viewport | DPR | UA Base |
|----|------|----------|-----|---------|
| `desktop-hd` | HD | 1280x720 | 1 | Default Chromium |
| `desktop-fhd` | Full HD | 1920x1080 | 1 | Default Chromium |

User agent strings template the Chrome version from Electron's bundled Chromium to stay consistent with the shell.

### Custom

When preset ID is `"custom"`, the user provides width, height, and DPR manually. Defaults: `mobile = false`, `hasTouch = false`, `userAgent = default Chromium`.

**Validation constraints:**
- Width: 120 - 3840 (integer)
- Height: 120 - 3840 (integer)
- DPR: 1 - 5 (one decimal allowed, e.g. 2.5)

---

## Architecture

### Technical Approach

**Electron-native `enableDeviceEmulation` + CDP for gaps.**

| Capability | API |
|------------|-----|
| Viewport, DPR, screen type | `webContents.enableDeviceEmulation(params)` |
| User agent | `webContents.setUserAgent(ua)` |
| Touch emulation | CDP `Emulation.setTouchEmulationEnabled` via `webContents.debugger` |
| CSS media features (`hover`, `pointer`) | CDP `Emulation.setEmulatedMedia` via `webContents.debugger` |
| Reset | `webContents.disableDeviceEmulation()` + UA revert + CDP disable + debugger detach |

CDP debugger is attached only when a mobile/tablet device with `hasTouch: true` or `mobile: true` is selected. Desktop mode has zero CDP overhead.

### Emulation State (Main Process)

Tracked per `PreviewSession`:

```typescript
interface EmulationState {
  preset: DevicePreset | null;       // null = desktop
  orientation: DeviceOrientation;
  debuggerAttached: boolean;
}
```

### Apply Sequence

When a device is selected:

1. **Reset** current emulation (full reset sequence below)
2. Call `webContents.enableDeviceEmulation()` with viewport, DPR, `screenPosition`
3. Call `webContents.setUserAgent()` with preset UA
4. If `preset.hasTouch` or `preset.mobile`: attach `webContents.debugger` (if not already)
5. If `preset.hasTouch`: send CDP `Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 })`
6. If `preset.mobile`: send CDP `Emulation.setEmulatedMedia({ features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] })`
7. Update `session.emulationState`
8. Fire `onDeviceEmulationChanged` push event to renderer

### Reset Sequence

Always runs before applying a new device, and when returning to desktop:

1. `webContents.disableDeviceEmulation()`
2. `webContents.setUserAgent('')` (revert to Chromium default)
3. If debugger attached:
   a. Send CDP `Emulation.setTouchEmulationEnabled({ enabled: false })`
   b. Send CDP `Emulation.setEmulatedMedia({ features: [] })`
   c. `webContents.debugger.detach()`
4. Set `session.emulationState = { preset: null, orientation: 'portrait', debuggerAttached: false }`

**Key rule:** Device-to-device switch always runs reset-then-apply. No partial updates.

### Orientation Toggle

Swaps width and height in the emulation params and re-runs the apply sequence from step 2 (skip reset since `enableDeviceEmulation` overwrites previous params).

### Graceful Degradation

If CDP debugger fails to attach (e.g., another debugger is connected), apply viewport and UA only. Surface a toast: "Touch emulation unavailable." The viewport and media query behavior still works correctly.

---

## IPC Contract

### Renderer to Main

```typescript
/** Apply a device preset, or null to reset to desktop. */
preview.setDeviceEmulation(payload: DeviceEmulationPayload):
  Promise<{ ok: true } | { ok: false; error: string }>

/** Query current emulation state (for restoring after thread switch). */
preview.getDeviceEmulation():
  Promise<DeviceEmulationState | null>
```

### Main to Renderer (Push Event)

```typescript
/** Fired after emulation applies or resets. Keeps UI in sync. */
preview.onDeviceEmulationChanged(
  callback: (state: DeviceEmulationState) => void
): () => void  // returns unsubscribe
```

### Integration with Existing IPC

The `preview:sync` payload is unchanged. When device emulation is active, the main process uses emulated dimensions for bounds calculation instead of filling the full panel rect. The `resumeUrlHint` and `threadId` fields continue to work as before.

---

## Per-Thread State

### Renderer (Zustand)

```typescript
interface ThreadDeviceState {
  presetId: string | null;
  orientation: DeviceOrientation;
  customViewport?: { width: number; height: number; dpr: number };
}

// In the preview store, keyed by threadId
deviceStateByThread: Record<string, ThreadDeviceState>
```

### Thread Switch Flow

1. User switches from Thread A to Thread B
2. Existing `pushSync` fires with new `threadId`
3. Main process runs full reset (clears Thread A's emulation)
4. Renderer reads `deviceStateByThread[threadB.id]`
5. If Thread B has a stored device: renderer calls `preview.setDeviceEmulation()` with that state
6. If Thread B has no stored device: stays in desktop mode (reset already happened)

### No Disk Persistence

Thread device state lives in memory only. Closing the app resets all threads to desktop. This avoids stale device configs and keeps the feature lightweight.

---

## Bounds Calculation and Scaling

When device emulation is active, the BrowserView is positioned within the panel rather than filling it.

### Logic (Main Process)

```
panelBounds   = bounds from ResizeObserver (renderer sends via preview:sync)
emulatedSize  = effective viewport from active preset

IF no emulation active:
    view.setBounds(panelBounds)                      // current behavior

IF emulatedSize fits inside panelBounds:
    // Center at native CSS pixel size
    offsetX = floor((panelBounds.width - emulatedSize.width) / 2)
    offsetY = floor((panelBounds.height - emulatedSize.height) / 2)
    view.setBounds({
      x: panelBounds.x + offsetX,
      y: panelBounds.y + offsetY,
      width: emulatedSize.width,
      height: emulatedSize.height
    })
    enableDeviceEmulation({ ..., scale: 1 })

IF emulatedSize exceeds panelBounds:
    // Scale down to fit, maintain aspect ratio
    scaleFactor = min(
      panelBounds.width  / emulatedSize.width,
      panelBounds.height / emulatedSize.height
    )
    scaledW = floor(emulatedSize.width  * scaleFactor)
    scaledH = floor(emulatedSize.height * scaleFactor)
    offsetX = floor((panelBounds.width  - scaledW) / 2)
    offsetY = floor((panelBounds.height - scaledH) / 2)
    view.setBounds({
      x: panelBounds.x + offsetX,
      y: panelBounds.y + offsetY,
      width: scaledW,
      height: scaledH
    })
    enableDeviceEmulation({ ..., scale: scaleFactor })
```

The `scale` parameter in `enableDeviceEmulation` handles visual scaling. The emulated viewport stays at full CSS pixel resolution (e.g., 1920x1080), but Chromium renders it scaled down. Media queries fire at the emulated size, not the physical size.

### Background Fill

The renderer draws a `bg-muted` fill behind the surface div. The gap between the centered BrowserView and panel edges shows this background, giving a clear visual boundary around the emulated device.

---

## UI Design

### Layer 1: Device Icon (Toolbar)

A device icon button added to the preview toolbar between the capture group and the external link button.

- **No emulation:** Icon is in default/inactive style
- **Emulation active:** Icon shows a small accent dot badge

Clicking the icon opens the device dropdown.

### Layer 2: Device Dropdown

A `DropdownMenu` (shadcn) anchored to the device icon:

```
PHONES
  iPhone SE                375x667
  iPhone 14 Pro            393x852
  Galaxy S24               360x780
  Pixel 7                  412x915

TABLETS
  iPad Air                 820x1180
  iPad Pro 11"             834x1194
  Galaxy Tab S9            640x1024

DESKTOP
  HD                       1280x720
  Full HD                  1920x1080

Custom...
```

- Category headers as non-interactive labels
- Each item shows name and dimensions
- Active device shows a checkmark
- "Custom..." opens an inline form with width, height, and DPR fields
- Selecting a preset immediately applies emulation and closes the menu

### Layer 3: Device Bar (Below Toolbar)

Appears only when emulation is active. Single compact row:

```
[icon] iPhone 14 Pro   393x852   [orientation toggle]   [reset x]
```

- Device icon + name + dimensions: clickable area that re-opens the dropdown
- Orientation toggle: rotates between portrait/landscape (hidden for desktop presets)
- Reset button: clears emulation, hides the bar, returns to fill-panel behavior
- Subtle `bg-muted` background to visually separate from the toolbar

### Layer 4: Keyboard Shortcut (Power User)

`Ctrl+Shift+D` (`Cmd+Shift+D` on Mac) opens a cmdk `Command` palette scoped to device selection. Type-to-filter across all presets. Same data source as the dropdown.

### UI States

| State | Toolbar Icon | Device Bar | Panel Background |
|-------|-------------|------------|------------------|
| Desktop (no emulation) | Default | Hidden | Not visible (view fills panel) |
| Device active | Accent dot | Visible with device info | `bg-muted` fill around centered view |
| Custom active | Accent dot | Shows "Custom" + dimensions | `bg-muted` fill around centered view |

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `enableDeviceEmulation` throws | Toast: "Device emulation failed", revert to desktop, log error |
| CDP debugger fails to attach | Apply viewport + UA only (graceful degradation), toast: "Touch emulation unavailable" |
| Invalid custom dimensions | Inline validation, apply button disabled until valid |
| BrowserView destroyed during apply | No-op; next `pushSync` recreates view and re-applies thread state |
| Orientation toggle on desktop preset | Toggle is hidden; no-op if reached programmatically |

## Integration with Existing Features

| Feature | Behavior |
|---------|----------|
| Thread switch | Reset current emulation, apply new thread's stored state |
| Idle parking (`parkPreview`) | Emulation state preserved in `session.emulationState`; re-applied after `ensureView` on wake |
| Panel resize | Recalculate centering/scaling; no emulation reset needed |
| Panel hide (`pushSync(false)`) | View parked as before; emulation state preserved in memory |
| Panel show (`pushSync(true)`) | View recreated; emulation re-applied from thread state |
| Screenshot capture | Captures emulated viewport; metadata includes device name and dimensions |
| Page context extraction | `layoutWidth`/`layoutHeight` reflect emulated viewport (correct behavior) |
| Navigation / reload | Emulation persists across navigations; no re-apply needed |

---

## v2: Device Chrome (Deferred)

Future work to render visual device frames (bezels, notch, dynamic island, punch-hole cutout) around the emulated viewport. This benefits mobile developers and designer-developers who want presentation-quality previews.

Planned approach: CSS pseudo-elements or overlay SVGs rendered by the shell around the BrowserView bounds. The emulated viewport shrinks by the frame insets. Device chrome data (inset dimensions, notch type) added to `DevicePreset`.

---

## Open Questions

1. **User agent Chrome version:** Should the UA string dynamically template the Chrome version from `process.versions.chrome` (Electron's bundled Chromium), or use static strings? Dynamic keeps UAs truthful as Electron upgrades; static is simpler.
2. **Preset extensibility:** Should users be able to add custom named presets via settings in a future iteration, or is "Custom dimensions" sufficient?
3. **Capture metadata format:** How should device info appear in capture fences sent to the agent? e.g., `[device: iPhone 14 Pro, 393x852, 3x]` prepended to the fence?
