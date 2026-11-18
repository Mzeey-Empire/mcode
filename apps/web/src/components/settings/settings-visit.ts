import { useEffect, useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import { PartialSettingsSchema, SettingsSchema, type Settings } from "@mcode/contracts/models/settings";
import { TerminalPreferencesUpdateSchema } from "@mcode/contracts/models/terminal-settings";
import { useSettingsStore } from "@/stores/settingsStore";
import { isLocalSettingsWriteInFlight, latestLocalSettingsWriteSeq, subscribeLocalSettingsWrites } from "@/stores/settings-write-origin";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useTerminalSettingsStore } from "@/features/terminal/settings/terminalSettingsStore";
import type { SettingDef, SettingId } from "./setting-def";
import type { SettingsSection } from "./settings-sections";
import { SETTINGS_INDEX } from "./settings-nav";
import { readRevertSource, revertSourceOf, type RestoreStep, type RevertibleValue, type RevertSource } from "./setting-value";

/** A setting whose row Revert can put back. */
export type RevertibleDef = SettingDef & { readonly value: RevertibleValue };

/** A setting this visit changed: the whole source from just before the first local write that changed it. */
export interface JournalEntry {
  readonly def: RevertibleDef;
  readonly before: RevertSource;
}

/** A change the header names. */
export interface VisitChange {
  readonly id: SettingId;
  readonly label: string;
}

/** A setting the last Revert could not put back, with the reason. */
export interface RevertFailure {
  readonly id: SettingId;
  readonly label: string;
  readonly reason: string;
}

/** Who caused a source transition. */
export type WriteOrigin = "local" | "external" | "revert";

/** Writes Revert sends: at most one per sink, in sink order. */
export interface RevertPlan {
  readonly batches: readonly { readonly step: RestoreStep; readonly ids: readonly SettingId[] }[];
  readonly blocked: readonly RevertFailure[];
}

function isRevertible(def: SettingDef): def is RevertibleDef {
  return def.value.kind === "revertible";
}

const REVERTIBLE_DEFS: readonly RevertibleDef[] = SETTINGS_INDEX.map((entry) => entry.def).filter(isRevertible);
const DEF_ORDER = new Map(REVERTIBLE_DEFS.map((def, index) => [def.id, index]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameValue(a[key], b[key]));
}

function mergePlain(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = mergePlain(out[key], value);
  return out;
}

function failuresFor(ids: readonly SettingId[], reason: string): RevertFailure[] {
  return ids.map((id) => ({ id, label: REVERTIBLE_DEFS[DEF_ORDER.get(id) ?? -1]?.label ?? id, reason }));
}

// ---- pure core ----

/**
 * One source transition. Local write in flight: record `prev` as before for each revertible def whose read changed
 * and that has no entry yet. No local write in flight: drop the entry of each def whose read changed, because the value
 * now belongs to whoever wrote it. While reverting: ignore.
 */
export function journalTransition(
  journal: ReadonlyMap<SettingId, JournalEntry>,
  defs: readonly RevertibleDef[],
  prev: RevertSource,
  next: RevertSource,
  origin: WriteOrigin,
): ReadonlyMap<SettingId, JournalEntry> {
  if (origin === "revert") return journal;
  // A local write claims an untouched row; an outside write releases a claimed one. Anything else keeps the journal.
  const affected = defs.filter((def) => journal.has(def.id) === (origin === "external")
    && !sameValue(def.value.read(prev), def.value.read(next)));
  if (affected.length === 0) return journal;
  const out = new Map(journal);
  for (const def of affected) {
    if (origin === "local") out.set(def.id, { def, before: prev });
    else out.delete(def.id);
  }
  return out;
}

/** Entries whose read(current) differs from read(before), in page order. Changing a value back by hand removes it. */
export function changedEntries(journal: ReadonlyMap<SettingId, JournalEntry>, current: RevertSource): readonly JournalEntry[] {
  return [...journal.values()]
    .filter((entry) => !sameValue(entry.def.value.read(entry.before), entry.def.value.read(current)))
    .sort((a, b) => (DEF_ORDER.get(a.def.id) ?? 0) - (DEF_ORDER.get(b.def.id) ?? 0));
}

interface PlannedStep {
  readonly id: SettingId;
  readonly step: RestoreStep;
}

function planSettings(steps: readonly PlannedStep[], current: Settings, blocked: RevertFailure[]): RevertPlan["batches"] {
  let pending = [...steps];
  for (;;) {
    const merged = pending.reduce<unknown>((acc, { step }) => (step.sink === "settings" ? mergePlain(acc, step.patch) : acc), {});
    const next = SettingsSchema().safeParse(mergePlain(current, merged));
    const patch = PartialSettingsSchema().safeParse(merged);
    const ids = pending.map((planned) => planned.id);
    if (!next.success || !patch.success) {
      blocked.push(...failuresFor(ids, "the saved value is no longer valid"));
      return [];
    }
    // One refusal at a time: dropping it changes the merged result the remaining checks run on.
    const refusal = pending
      .map((planned) => ({ planned, reason: planned.step.sink === "settings" ? planned.step.blockedBy?.(next.data) ?? null : null }))
      .find(({ reason }) => reason !== null);
    if (refusal?.reason == null) return ids.length === 0 ? [] : [{ step: { sink: "settings", patch: patch.data }, ids }];
    blocked.push(...failuresFor([refusal.planned.id], refusal.reason));
    pending = pending.filter((planned) => planned !== refusal.planned);
  }
}

function planTerminalPreferences(steps: readonly PlannedStep[], blocked: RevertFailure[]): RevertPlan["batches"] {
  if (steps.length === 0) return [];
  const merged = steps.reduce<unknown>((acc, { step }) => (step.sink === "terminalPreferences" ? mergePlain(acc, step.patch) : acc), {});
  const patch = TerminalPreferencesUpdateSchema().safeParse(merged);
  const ids = steps.map((planned) => planned.id);
  if (!patch.success) {
    blocked.push(...failuresFor(ids, "the saved value is no longer valid"));
    return [];
  }
  return [{ step: { sink: "terminalPreferences", patch: patch.data }, ids }];
}

/** At most one write per sink (settings and terminal patches deep-merged); blocked entries move to `blocked` and are merged out. */
export function planRevert(changed: readonly JournalEntry[], current: RevertSource): RevertPlan {
  const steps = changed.map((entry): PlannedStep => ({ id: entry.def.id, step: entry.def.value.restore(entry.before, current) }));
  const ofSink = (sink: RestoreStep["sink"]) => steps.filter((planned) => planned.step.sink === sink);
  const blocked: RevertFailure[] = [];
  const batches = [
    ...planSettings(ofSink("settings"), current.settings, blocked),
    ...planTerminalPreferences(ofSink("terminalPreferences"), blocked),
    ...ofSink("terminalGlobalDefault").map(({ id, step }) => ({ step, ids: [id] })),
    ...ofSink("terminalProjectDefault").map(({ id, step }) => ({ step, ids: [id] })),
  ];
  return { batches, blocked };
}

// ---- visit store ----

interface Visit {
  /** New per visit, so a revert or write that outlives its visit cannot touch the next one. */
  readonly id: number;
  readonly page: SettingsSection;
  readonly journal: ReadonlyMap<SettingId, JournalEntry>;
  /** Local writes up to this sequence started before the visit and never count as its changes. */
  readonly startSeq: number;
  readonly reverting: boolean;
  /** Settings the last Revert could not put back. Cleared by the next journal change. */
  readonly failures: readonly RevertFailure[];
}

const useVisitStore = create<{ readonly visit: Visit | null }>(() => ({ visit: null }));

let nextVisitId = 0;
let lastSource: RevertSource | null = null;
let stopListening: (() => void) | null = null;

function sameSource(a: RevertSource, b: RevertSource): boolean {
  return a.settings === b.settings
    && a.projectDefault.workspaceId === b.projectDefault.workspaceId
    && a.projectDefault.profileId === b.projectDefault.profileId;
}

function patchVisit(id: number, change: Partial<Pick<Visit, "journal" | "reverting" | "failures">>): void {
  const visit = useVisitStore.getState().visit;
  if (visit?.id === id) useVisitStore.setState({ visit: { ...visit, ...change } });
}

function onSourceChange(): void {
  const visit = useVisitStore.getState().visit;
  if (visit === null || lastSource === null) return;
  const next = readRevertSource();
  if (sameSource(lastSource, next)) return;
  const origin: WriteOrigin = visit.reverting ? "revert" : isLocalSettingsWriteInFlight(visit.startSeq) ? "local" : "external";
  const journal = journalTransition(visit.journal, REVERTIBLE_DEFS, lastSource, next, origin);
  lastSource = next;
  if (journal !== visit.journal) patchVisit(visit.id, { journal, failures: [] });
}

function startVisit(page: SettingsSection): number {
  stopListening?.();
  const id = ++nextVisitId;
  lastSource = readRevertSource();
  useVisitStore.setState({ visit: { id, page, journal: new Map(), startSeq: latestLocalSettingsWriteSeq(), reverting: false, failures: [] } });
  const unsubscribers = [
    useSettingsStore.subscribe(onSourceChange),
    useWorkspaceStore.subscribe(onSourceChange),
    useTerminalSettingsStore.subscribe(onSourceChange),
  ];
  stopListening = () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
  return id;
}

function endVisit(id: number): void {
  if (useVisitStore.getState().visit?.id !== id) return;
  stopListening?.();
  stopListening = null;
  lastSource = null;
  useVisitStore.setState({ visit: null });
}

/** Starts a visit for `page` and ends it when the page changes or the canvas unmounts. */
export function useSettingsVisit(page: SettingsSection): void {
  useEffect(() => {
    const id = startVisit(page);
    return () => endVisit(id);
  }, [page]);
}

/** What the header shows for the current visit. */
export interface VisitSummary {
  readonly changes: readonly VisitChange[];
  readonly reverting: boolean;
  /** A local settings write is in flight, so Revert would plan against a source about to change. */
  readonly writing: boolean;
  readonly failures: readonly RevertFailure[];
}

const NO_FAILURES: readonly RevertFailure[] = [];

/** Changes the header shows: journal entries whose current value differs from their before value, in page order. */
export function useVisitChanges(): VisitSummary {
  const visit = useVisitStore((state) => state.visit);
  const settings = useSettingsStore((state) => state.settings);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const override = useTerminalSettingsStore((state) => state.workspaceOverride);
  const writing = useSyncExternalStore(subscribeLocalSettingsWrites, () => isLocalSettingsWriteInFlight());
  const changes = useMemo(() => {
    if (visit === null) return [];
    const current = revertSourceOf(settings, activeWorkspaceId, override);
    return changedEntries(visit.journal, current).map((entry) => ({ id: entry.def.id, label: entry.def.label }));
  }, [visit, settings, activeWorkspaceId, override]);
  return { changes, reverting: visit?.reverting ?? false, writing, failures: visit?.failures ?? NO_FAILURES };
}

async function runStep(step: RestoreStep): Promise<string | null> {
  const terminal = useTerminalSettingsStore.getState();
  const terminalReason = (ok: boolean) => (ok ? null : useTerminalSettingsStore.getState().error ?? "Terminal settings could not be updated.");
  switch (step.sink) {
    case "settings":
      return (await useSettingsStore.getState().update(step.patch)) ?? null;
    case "terminalPreferences":
      return terminalReason(await terminal.updatePreferences(step.patch));
    case "terminalGlobalDefault":
      return terminalReason(await terminal.setGlobalDefault(step.profileId));
    case "terminalProjectDefault":
      if (step.workspaceId === null) return "no project is open";
      return terminalReason(step.profileId === null
        ? await terminal.resetWorkspaceDefault(step.workspaceId)
        : await terminal.setWorkspaceDefault(step.workspaceId, step.profileId));
  }
}

async function runBatches(plan: RevertPlan): Promise<{ readonly done: readonly SettingId[]; readonly failures: readonly RevertFailure[] }> {
  const failures: RevertFailure[] = [...plan.blocked];
  const done: SettingId[] = [];
  for (const batch of plan.batches) {
    const reason = await runStep(batch.step);
    if (reason === null) done.push(...batch.ids);
    else failures.push(...failuresFor(batch.ids, reason));
  }
  return { done, failures };
}

/** Puts back every change of the current visit. Idempotent: a second call finds nothing to do. */
export async function revertVisit(): Promise<{ readonly failures: readonly RevertFailure[] }> {
  const visit = useVisitStore.getState().visit;
  if (visit === null || visit.reverting || isLocalSettingsWriteInFlight()) return { failures: visit?.failures ?? NO_FAILURES };
  const plan = planRevert(changedEntries(visit.journal, readRevertSource()), readRevertSource());
  patchVisit(visit.id, { reverting: true });
  const { done, failures } = await runBatches(plan);
  const latest = useVisitStore.getState().visit;
  if (latest?.id === visit.id) {
    const journal = new Map(latest.journal);
    for (const id of done) journal.delete(id);
    patchVisit(visit.id, { journal, reverting: false, failures });
  }
  return { failures };
}
