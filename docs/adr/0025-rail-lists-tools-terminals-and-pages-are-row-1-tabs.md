---
status: accepted
---

# The rail lists tools; terminals and Browser pages are row-1 tabs

ADR-0020 gave every shell session its own entry in the right-panel rail. Browser
pages then grew their own rail group as well, so the rail mixed two levels: tools
(Review, Plan, Files) and items inside tools (shells, Project Action runs, pages).
A thread with several shells and pages pushed the tools themselves out of view,
and closing a rail entry meant different things depending on what it held.

The rail now has one entry per open tool. Terminal and Browser each appear once,
however many records or pages they hold. Inside the tool, row 1 of the panel
header shows one tab per item, followed by a round + that adds one:

- Terminal tabs list every terminal record in the scope: shells and Project
  Action runs. A Project Action tab shows that action's transcript view.
- Browser tabs list the scope's open pages and mark pages under agent control.

Closing a Terminal tab terminates that record's process tree, as ADR-0020
decided. This now includes Project Action runs, which previously only hid their
view. Closing the last Terminal tab closes the Terminal tool. Closing the
Terminal rail entry only hides the tool; its records keep running, and the tool
reopens when a new record appears. Closing the last Browser page closes the
Browser tool.

The server cap of eight terminal records per scope counts every record, shells
and action runs alike. At the cap, the Terminal + is disabled and its tooltip
says why.

Panel state follows ADR-0012: each thread owns its record, and the workspace
fallback covers the threadless shell and untouched threads. A saved record that
still lists per-terminal rail entries migrates in memory to one Terminal entry at
the position of the first one. An untouched thread does not inherit the
workspace's Terminal entry, because terminal records belong to one scope.

This supersedes ADR-0020's one-rail-entry-per-shell decision. Its process-tree
kill on close stands. ADR-0010's one-renderer bound also stands: only the active
shell tab has a terminal view.

The trade-off is a second level of tabs inside two tools. In return, the rail
stays short and uniform, and every tool follows one rule: the rail picks the
tool, and row 1 picks the item.
