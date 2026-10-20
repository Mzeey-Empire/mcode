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

Runtime sections provide routing decisions. Detailed operating rules live in
the descriptions of the tools they govern, so Browser guidance has one delivery
path. MCP initialization carries no instructions, and there are no guide tools.
