# Plan records

User writes never go through the canonical owner. User drafts have no assistant
message, so canonical routing cannot authorize their creation. [PlanService](../../../apps/server/src/features/agents/planning/plan-service.ts)
uses the application's sole database writer and checks busy state and revision
within its transaction.

Reload plans after every write. Canonical progress may still have a head after a
turn ends and allocates capture versions from memory. Its reload must add user
rows, take their saved content and revision, and preserve the later status in the
order draft or ready, superseded, accepted. Snapshots use the same merge.

Accepted commits only inside turn admission. The later Implement operation must
commit the accepted version with the admitted turn; a file write or prepared
request alone does not mean implementation started. There is no client status setter.

Native plan files change only with ownership proof. A provider must name the exact
file for its session and validate containment, regular-file identity, size and hash
before mutation. Captured paths remain server-side. Mcode's own plan file is a
separate projection and never authorizes touching a provider's file.

See [ADR 0023](../../adr/0023-durable-plan-versions.md) for the version and replay decisions.
