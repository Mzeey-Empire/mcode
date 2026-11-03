import * as NodeChildProcess from "node:child_process";

// SW_SHOWMINNOACTIVE and SW_SHOWNOACTIVATE: neither takes focus from the window the user is in.
const SHOW_COMMANDS = { minimized: 7, normal: 4 };

const WINDOW_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class LiveTestingWindow {
  delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);

  public static string Set(uint processId, int command) {
    var appWindows = new List<IntPtr>();
    EnumWindows((window, data) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner != processId || !IsWindowVisible(window)) return true;
      var title = new StringBuilder(512);
      GetWindowText(window, title, title.Capacity);
      // DevTools opens as a second top-level window of the same process.
      if (!title.ToString().StartsWith("Developer Tools")) appWindows.Add(window);
      return true;
    }, IntPtr.Zero);
    if (appWindows.Count != 1) {
      throw new InvalidOperationException("Expected one app window for process " + processId + ", found " + appWindows.Count);
    }
    ShowWindow(appWindows[0], command);
    return IsIconic(appWindows[0]) ? "minimized" : "normal";
  }
}
`;

/**
 * Minimizes or restores the app window of the Electron process that start-electron.mjs owns,
 * and returns the state the window reports afterwards. Pass the session's `pid`.
 *
 * Electron's CDP has no Browser window methods, so this asks Windows directly.
 */
export function setElectronWindowState(pid, windowState) {
  if (process.platform !== "win32") throw new Error("setElectronWindowState supports Windows only");
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Pass the Electron session's PID");
  const command = SHOW_COMMANDS[windowState];
  if (command === undefined) throw new Error(`windowState must be one of ${Object.keys(SHOW_COMMANDS).join(", ")}`);

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -TypeDefinition @'\n${WINDOW_SOURCE}\n'@`,
    `[LiveTestingWindow]::Set(${pid}, ${command})`,
  ].join("\n");
  const result = NodeChildProcess.spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim() || "PowerShell could not change the window state");
  return result.stdout.trim();
}
