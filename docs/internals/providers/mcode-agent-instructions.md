# Mcode runtime agent instructions

Runtime guidance derives from the toolkits attached to the provider session.
The shared builder selects short, self-contained sections so unrelated guidance
cannot crowd out repository search or provider-native collaboration rules.
Authorization and Browser leases remain authoritative; instruction text grants
no permissions.

Each section stays under 4,000 UTF-8 bytes because Codex silently truncates the
middle of longer `additionalContext` values. Codex receives one `application`
entry per section on every main-thread `turn/start`, preserving Codex's own
configured developer instructions. Codex deduplicates unchanged entries, but
drops their messages during compaction without resending them. After main-thread
compaction, Mcode restores the sections as tagged developer messages through
`thread/inject_items`. Restore failures warn and leave the turn running.

Claude joins sections in its `systemPrompt` append, Copilot in `systemMessage`,
and Cursor in the first normal prompt of its logical ACP session. Ephemeral
Codex completions receive no runtime sections.

A harness that loads tools lazily shows only tool names until the model
searches, so a rule that lives only in a tool description arrives after the
model has chosen a tool. MCP initialization carries no instructions, and there
are no guide tools.

The thread-control section therefore carries its full operating rules, and the
tool descriptions repeat them. The Browser section carries only routing rules:
which browser to choose, how to confirm it is unavailable, and when to switch
after failures. Those decisions happen before any Browser tool loads. The
Browser tool descriptions own the operating rules, and the rules every Browser
flow needs, such as finalizing tabs before replying, appear on `browser_open`
and `browser_inspect` because a flow may never load `browser_tabs`.
`browser_open` also repeats the failure and switch rule, so edit both places
when that rule changes.
