import { useMemo } from "react";
import {
  decodeCanonicalSubagentDetailTarget,
  decodeSubagentAliasDetailTarget,
  type CanonicalSubagentRosterRow,
} from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import { projectSubagents } from "./subagent-projection";
import type { ProjectedSubagentRow, SubagentRoster } from "./subagent-projection";

/** Resolves a canonical child without guessing across provider-native alias collisions. */
export function resolveCanonicalSubagentSelection(
  selectionId: string,
  rows: readonly CanonicalSubagentRosterRow[],
): CanonicalSubagentRosterRow | undefined {
  const sourceItemId = `toolCall:${selectionId}`;
  const directChild = rows.find((row) => row.id === selectionId);
  if (directChild) return directChild;
  const sourceItem = rows.find((row) => row.sourceItemId === sourceItemId);
  if (sourceItem) return sourceItem;

  // Legacy aliases contain only a value, not the provider/scope tuple required
  // to disambiguate a shared native identifier.
  const providerAliasMatches = rows.filter((row) =>
    [...row.providerIdentities, ...row.sourceProviderIdentities].some(
      (identity) => identity.value === selectionId,
    ));
  return providerAliasMatches.length === 1 ? providerAliasMatches[0] : undefined;
}

/**
 * The identities a projected row could resolve to inside the canonical roster:
 * its own call id (source-item link), a canonical child target, or a provider
 * alias. Mirrors the click path in `SubagentRow.participantDetailTarget`.
 */
function canonicalRepresentationKeys(row: ProjectedSubagentRow): string[] {
  // Live rows keep the raw provider-native identity; persisted rows keep the
  // encoded storage form, so both the raw value and its decodes are checked.
  return [
    row.id,
    row.logicalIdentityKey,
    decodeCanonicalSubagentDetailTarget(row.logicalIdentityKey),
    decodeSubagentAliasDetailTarget(row.logicalIdentityKey),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

/**
 * True when the canonical roster already represents this projected row. Rows
 * for in-thread providers (Devin, Claude Task) never match and remain visible.
 */
export function isCanonicallyRepresented(
  row: ProjectedSubagentRow,
  canonicalRows: readonly CanonicalSubagentRosterRow[],
): boolean {
  return canonicalRepresentationKeys(row)
    .some((key) => resolveCanonicalSubagentSelection(key, canonicalRows) !== undefined);
}

/** Drops projected rows the canonical roster already lists. */
export function dedupeNarrativeRoster(
  roster: SubagentRoster,
  canonicalRows: readonly CanonicalSubagentRosterRow[],
): SubagentRoster {
  return {
    active: roster.active.filter((row) => !isCanonicallyRepresented(row, canonicalRows)),
    finished: roster.finished.filter((row) => !isCanonicallyRepresented(row, canonicalRows)),
  };
}

/**
 * Resolves a detail selection to a projected narrative row. Selection ids are
 * the row id itself, a grouped member's call id, or a persisted alias target.
 */
export function resolveNarrativeSubagentSelection(
  selectionId: string,
  roster: SubagentRoster,
): ProjectedSubagentRow | undefined {
  const rows = [...roster.active, ...roster.finished];
  return rows.find((row) =>
    row.id === selectionId
    || row.memberCallIds.includes(selectionId)
    || row.logicalIdentityKey === selectionId
    || decodeSubagentAliasDetailTarget(row.logicalIdentityKey) === selectionId
    || decodeCanonicalSubagentDetailTarget(row.logicalIdentityKey) === selectionId);
}

/** Status copy for one projected row, matching the canonical detail labels. */
export function narrativeRowStatus(row: ProjectedSubagentRow): string {
  if (!("status" in row)) return "Active";
  if (row.status === "cancelled") return "Interrupted";
  return row.status === "failed" ? "Failed" : "Completed";
}

export function narrativeRowTab(row: ProjectedSubagentRow): "active" | "finished" {
  return "status" in row ? "finished" : "active";
}

/** Match the chat card glyph, which seeds from the identity/alias target. */
export function narrativePaletteSeed(row: ProjectedSubagentRow): string {
  return row.logicalIdentityKey ?? row.id;
}

/**
 * Projects the thread's live calls and persisted narrative into a sub-agent
 * roster. In-thread subagents (Devin, Claude Task) have no canonical child
 * threads, so this is their only roster source.
 */
export function useNarrativeSubagentRoster(threadId: string): SubagentRoster {
  const toolCalls = useThreadStore((state) => state.records.get(threadId)?.toolCalls);
  const narrative = useThreadStore((state) => state.records.get(threadId)?.narrativeByMessage);
  return useMemo(
    () => projectSubagents(
      toolCalls,
      narrative ? Object.values(narrative).map((entry) => entry?.tools) : undefined,
    ),
    [toolCalls, narrative],
  );
}

export type { ProjectedSubagentRow };
