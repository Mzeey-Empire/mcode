# Server Shutdown Before Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the detached server process before the NSIS installer runs, so it cannot hold file locks that cause "Failed to uninstall old application files" errors.

**Architecture:** Add a `setBeforeInstallHook()` to `auto-updater.ts` so `main.ts` can inject `serverManager.forceReplace()` as a pre-install callback. Replace all `autoUpdater.quitAndInstall()` calls with an async wrapper that calls the hook first. Handle `autoInstallOnAppQuit` via a `before-quit` handler in `main.ts`.

**Tech Stack:** Electron, electron-updater, TypeScript, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/desktop/src/main/auto-updater.ts` | Modify | Add hook registration + safe quit wrapper |
| `apps/desktop/src/main/main.ts` | Modify | Wire hook + add before-quit handler |
| `apps/desktop/src/main/__tests__/server-manager.test.ts` | Modify | Add test for forceReplace being called before install |

---

### Task 1: Add pre-install hook to auto-updater

**Files:**
- Modify: `apps/desktop/src/main/auto-updater.ts`

- [ ] **Step 1: Add hook state and registration function**

In `apps/desktop/src/main/auto-updater.ts`, add after the `isPrompting` variable (line 88):

```typescript
/** Hook called before quitAndInstall to allow cleanup (e.g., stopping the server). */
let beforeInstallHook: (() => Promise<void>) | null = null;

/**
 * Register a callback that runs before every quitAndInstall.
 * Used by main.ts to inject server shutdown so the installer
 * does not hit locked files from the detached server process.
 */
export function setBeforeInstallHook(hook: () => Promise<void>): void {
  beforeInstallHook = hook;
}
```

- [ ] **Step 2: Add safe quit-and-install wrapper**

Add after the `setBeforeInstallHook` function:

```typescript
/**
 * Stop the server (if hook registered), then run the installer.
 * All code paths that previously called autoUpdater.quitAndInstall()
 * must use this instead.
 */
async function quitAndInstallSafely(): Promise<void> {
  if (beforeInstallHook) {
    try {
      await beforeInstallHook();
    } catch (err) {
      console.error("[auto-updater] beforeInstallHook failed, proceeding with install:", err);
    }
  }
  autoUpdater.quitAndInstall();
}
```

- [ ] **Step 3: Replace quitAndInstall call in installUpdate()**

Change `installUpdate()` (currently lines 147-152) from:

```typescript
export function installUpdate(): boolean {
  if (!app.isPackaged) return false;
  if (lastStatus.state !== "downloaded") return false;
  autoUpdater.quitAndInstall();
  return true;
}
```

To:

```typescript
export async function installUpdate(): Promise<boolean> {
  if (!app.isPackaged) return false;
  if (lastStatus.state !== "downloaded") return false;
  await quitAndInstallSafely();
  return true;
}
```

- [ ] **Step 4: Replace quitAndInstall call in promptRestart()**

Change line 298-300 in `promptRestart()` from:

```typescript
  if (response === 0 && app.isPackaged) {
    autoUpdater.quitAndInstall();
  }
```

To:

```typescript
  if (response === 0 && app.isPackaged) {
    await quitAndInstallSafely();
  }
```

- [ ] **Step 5: Verify types compile**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: No errors (the return type change from `boolean` to `Promise<boolean>` on `installUpdate` is compatible with the IPC handler in main.ts since `ipcMain.handle` already accepts async handlers).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/auto-updater.ts
git commit -m "feat(desktop): add pre-install hook to stop server before quitAndInstall

All quitAndInstall calls now go through quitAndInstallSafely() which
invokes an optional hook first. This lets main.ts inject server shutdown
so the NSIS installer does not encounter locked files from the detached
server process."
```

---

### Task 2: Wire hook and before-quit handler in main.ts

**Files:**
- Modify: `apps/desktop/src/main/main.ts`

- [ ] **Step 1: Import setBeforeInstallHook**

In the existing auto-updater import block in `main.ts`, add `setBeforeInstallHook`:

Find the import from `./auto-updater.js` and add `setBeforeInstallHook` to it.

- [ ] **Step 2: Wire the hook after server starts**

After `await serverManager.start()` (line 616) and before the `onUnexpectedExit` callback registration (line 621), add:

```typescript
    // Stop the detached server before any quitAndInstall so the NSIS
    // installer does not hit locked files under the install directory.
    setBeforeInstallHook(() => serverManager.forceReplace());
```

- [ ] **Step 3: Add before-quit handler for autoInstallOnAppQuit**

The existing `will-quit` handler (lines 702-704) only cleans up the auto-updater. Add a `before-quit` handler BEFORE the `will-quit` handler that stops the server when an update is pending:

```typescript
  // When autoInstallOnAppQuit is true, electron-updater runs the installer
  // during the quit sequence. Stop the server first so the installer can
  // replace files without hitting locks from the detached process.
  let isQuittingForUpdate = false;
  app.on("before-quit", async (e) => {
    if (isQuittingForUpdate) return; // re-entrant guard after we call app.quit()
    const status = getUpdateStatus();
    if (status.state === "downloaded") {
      e.preventDefault();
      isQuittingForUpdate = true;
      try {
        await serverManager.forceReplace();
      } catch (err) {
        console.error("[main] Failed to stop server before update install:", err);
      }
      app.quit();
    }
  });
```

- [ ] **Step 4: Import getUpdateStatus**

Add `getUpdateStatus` to the auto-updater import if not already imported.

- [ ] **Step 5: Verify types compile**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/main.ts
git commit -m "feat(desktop): stop server before installer in all quit paths

Wires setBeforeInstallHook so installUpdate and promptRestart stop the
server before quitAndInstall. Adds before-quit handler so the
autoInstallOnAppQuit path also stops the server first."
```

---

### Task 3: Add tests

**Files:**
- Modify: `apps/desktop/src/main/__tests__/server-manager.test.ts`

- [ ] **Step 1: Add test for forceReplace stopping server before install**

The existing test "forceReplace sends POST /shutdown to the running server" (line 465) already validates the core mechanism. Add a complementary test that validates the full sequence (POST → poll → exit):

```typescript
  it("forceReplace polls PID until process exits", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);

    // process.kill: first call = POST check (alive), second = poll (alive),
    // third = poll (dead), fourth = final check (dead)
    const killSpy = vi.spyOn(process, "kill")
      .mockImplementationOnce(() => true as never) // alive for POST
      .mockImplementationOnce(() => true as never) // alive during poll
      .mockImplementationOnce(() => { throw new Error("ESRCH"); }); // dead

    await manager.forceReplace();

    // Verify POST was sent
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19600/shutdown",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer test-auth-token" },
      }),
    );

    // Verify PID was polled
    expect(killSpy).toHaveBeenCalledWith(12345, 0);

    killSpy.mockRestore();
  });

  it("forceReplace force-kills server if it does not exit within timeout", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);

    // Always report alive so we hit the SIGKILL fallback.
    // Mock Date.now to fast-forward past the 10s deadline.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    let now = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 5000; // jump 5s each call to exceed 10s deadline quickly
      return now;
    });

    await manager.forceReplace();

    // Should have attempted SIGKILL
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGKILL");

    killSpy.mockRestore();
    dateSpy.mockRestore();
  });
```

- [ ] **Step 2: Run tests**

Run: `cd apps/desktop && bun run test`
Expected: All tests pass including the new ones.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/__tests__/server-manager.test.ts
git commit -m "test(desktop): add forceReplace PID polling and SIGKILL fallback tests

Validates the full shutdown sequence that runs before the installer:
POST /shutdown with Bearer auth, PID polling, and SIGKILL fallback
when the server does not exit within the timeout."
```

---

### Task 4: Verify everything

- [ ] **Step 1: Run full verification pipeline**

Run: `node scripts/agent/verify-tests.mjs`

Expected: Typecheck, lint, and all unit tests pass.

- [ ] **Step 2: Verify no cross-package breakage**

The `installUpdate()` return type changed from `boolean` to `Promise<boolean>`. Verify no callers break:

Run: `cd apps/desktop && npx tsc --noEmit`

The IPC handler `ipcMain.handle("app:install-update", () => installUpdate())` returns a Promise, which `ipcMain.handle` already supports (it awaits the handler's return value).

- [ ] **Step 3: Report results**

Document:
- verify-tests.mjs: PASS/FAIL
- Typecheck: PASS/FAIL
- Unit test count and results
