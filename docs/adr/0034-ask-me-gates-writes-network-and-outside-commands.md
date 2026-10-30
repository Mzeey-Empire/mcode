# 0034: Ask me gates writes, network, and commands outside the project

Status: Accepted

Date: 2026-10-30

## Context

Chat QA ticket 15 found that Codex created files, ran curl, and ran
`git -C .. status` without approval while Ask me was selected. Claude presented
approval requests. Codex used `on-request` with `workspace-write`, which allowed
workspace writes and left command approval to the model.

## Decision

Ask me gates file writes, network access, and commands outside the project on
every provider. Provider adapters translate this policy into native permissions
and route requests through the existing approval UI.

Codex Ask me uses the protocol's `untrusted` approval policy and `read-only`
sandbox, both defined in [the adapter protocol types](../../packages/providers/src/private/codex/codex-types.ts).
Read-only removes implicit workspace write permission and keeps network
access restricted. Untrusted requires approval for commands outside Codex's
trusted command policy instead of leaving escalation to the model. These are
separate controls: a read-only sandbox alone still permits read commands.
The [upstream protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
defines these native approval and sandbox semantics.

## Consequences

Codex file edits and untrusted commands reach the canonical approval path;
approval permits the action and denial is returned to Codex. Changing between
Ask me and a broader mode replaces the native session so its old sandbox cannot
remain active. Approve for me and Don't ask retain their existing mappings.

The native trusted-command policy remains a provider boundary. Live verification
must include an outside-project read command as well as writes and network use.
