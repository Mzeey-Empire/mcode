# Open in editor

## Sub-features

- The chat-header menu lists each detected editor.
- A selected editor opens the active thread workspace.
- Windows command shims and executable launches do not show a console window.

## How to get to it (user or client POV)

1. Start the worktree runtime and the owned Electron app.
2. Open a thread for `.dev/fixture-repo`.
3. Select **Choose app to open in** in the chat header.
4. Select VS Code or Zed.

## Driving it with Electron live testing

1. Run `runtime health` before proof collection.
2. Use the Electron live-testing skill to open the chat-header menu.
3. Confirm that detected VS Code and Zed menu items are visible.
4. Select each editor and inspect the retained screenshot.
5. Use focused desktop tests to inspect the resolved command and Windows spawn options.

## Gotchas

- Test only `.dev/fixture-repo`. Do not open a user workspace.
- A native console window is outside Playwright's DOM. The focused spawn tests prove `windowsHide: true` for `where.exe`, `cmd.exe`, and direct `.exe` launches.
- Record an unavailable editor or a blocked native launch as a coverage gap.

## Proof

The normal entry is the chat-header menu for a fixture thread. Select each detected editor. Capture a screenshot that shows the menu and its editor entries. Retain focused test output that proves VS Code selects `code.cmd` when `where.exe` lists an extensionless shim first, Zed selects `Zed.exe`, and every Windows process uses `windowsHide: true`. Inspect the launched editor or its process side effect when the installed editor permits it. Remove only fixture threads and processes that this verification created.
