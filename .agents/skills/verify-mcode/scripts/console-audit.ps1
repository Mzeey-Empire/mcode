# Reports visible windows owned by descendants of the given root PIDs, plus
# (in --watch mode) newly appearing console windows anywhere in the session.
#
# A console-subsystem child spawned without windowsHide under a console-less
# parent allocates a visible console window. Classic conhost-hosted consoles
# are attributed through the conhost -> client parent link. Windows
# Terminal-hosted consoles cannot be attributed by parentage, so watch mode
# records every new console-class window (class + title) as a sighting for
# manual correlation with the action under test.
param(
  [int[]]$RootPids,
  [int]$WatchSeconds = 0,
  [string[]]$AllowedWindowOwners = @("electron", "mcode", "Mcode")
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class McodeWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder cls, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  public struct WindowHit { public IntPtr Hwnd; public uint Pid; public string Class; public string Title; }

  // Returns the handle, owning PID, class, and title of every visible window.
  public static List<WindowHit> VisibleWindows() {
    var hits = new List<WindowHit>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256);
      GetClassNameW(h, cls, cls.Capacity);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == 0) return true;
      var title = new StringBuilder(512);
      GetWindowTextW(h, title, title.Capacity);
      hits.Add(new WindowHit { Hwnd = h, Pid = pid, Class = cls.ToString(), Title = title.ToString() });
      return true;
    }, IntPtr.Zero);
    return hits;
  }
}
'@

$consoleClasses = @("ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS")
$deadline = (Get-Date).AddSeconds([Math]::Max(1, $WatchSeconds))
$findings = @{}
$seenConsoleWindows = @{}
$consoleSightings = @{}

# Baseline: windows already open when the watch starts are not sightings.
foreach ($hit in [McodeWin32]::VisibleWindows()) {
  if ($consoleClasses -contains $hit.Class) { $seenConsoleWindows[[string]$hit.Hwnd] = $true }
}

do {
  $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name
  $byId = @{}
  $children = @{}
  foreach ($p in $all) {
    $byId[[int]$p.ProcessId] = $p
    $parent = [int]$p.ParentProcessId
    if (-not $children.ContainsKey($parent)) { $children[$parent] = [System.Collections.Generic.List[object]]::new() }
    $children[$parent].Add($p)
  }

  $descendants = @{}
  $queue = [System.Collections.Generic.Queue[int]]::new()
  foreach ($rootPid in $RootPids) { $queue.Enqueue($rootPid) }
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    if ($descendants.ContainsKey($current)) { continue }
    $descendants[$current] = $true
    foreach ($child in $children[$current]) { $queue.Enqueue([int]$child.ProcessId) }
  }

  foreach ($hit in [McodeWin32]::VisibleWindows()) {
    $ownerPid = [int]$hit.Pid
    # A classic console window is owned by conhost; attribute it to the client.
    if ($hit.Class -eq "ConsoleWindowClass" -and $byId.ContainsKey($ownerPid)) {
      $ownerPid = [int]$byId[$ownerPid].ParentProcessId
    }
    if ($descendants.ContainsKey($ownerPid) -and -not ($RootPids -contains $ownerPid)) {
      $owner = $byId[$ownerPid]
      if ($null -ne $owner -and -not ($AllowedWindowOwners -contains ($owner.Name -replace '\.exe$',''))) {
        if (-not $findings.Contains($ownerPid)) {
          $findings[$ownerPid] = [pscustomobject]@{
            pid = $ownerPid
            name = $owner.Name
            windowClass = $hit.Class
            title = $hit.Title
            firstSeenAt = (Get-Date).ToString("o")
          }
        }
      }
    }
    # In watch mode, record console windows that newly appear session-wide.
    if ($WatchSeconds -gt 0 -and $consoleClasses -contains $hit.Class) {
      $key = [string]$hit.Hwnd
      if (-not $seenConsoleWindows.ContainsKey($key)) {
        $seenConsoleWindows[$key] = $true
        $ownerName = if ($byId.ContainsKey([int]$hit.Pid)) { $byId[[int]$hit.Pid].Name } else { "" }
        $consoleSightings[$key] = [pscustomobject]@{
          pid = [int]$hit.Pid
          owner = $ownerName
          windowClass = $hit.Class
          title = $hit.Title
          firstSeenAt = (Get-Date).ToString("o")
        }
      }
    }
  }

  if ($WatchSeconds -le 0) { break }
  Start-Sleep -Milliseconds 200
} while ((Get-Date) -lt $deadline)

[pscustomobject]@{
  findings = @($findings.Values)
  consoleWindowSightings = @($consoleSightings.Values)
} | ConvertTo-Json -Compress -Depth 4
