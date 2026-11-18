import { useEffect, useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import { PartialSettingsSchema, SettingsSchema, type Settings } from "@mcode/contracts/models/settings";
import { TerminalPreferencesUpdateSchema } from "@mcode/contracts/models/terminal-settings";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  isLocalSettingsWriteInFlight,
  latestLocalSettingsWriteSeq,
  localSettingsWrites,
  subscribeFailedLocalSettingsWrites,
  subscribeLocalSettingsWrites,
  type LocalWrite,
  type LocalWriteScope,
} from "@/stores/settings-write-origin";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useTerminalSettingsStore } from "@/features/terminal/settings/terminalSettingsStore";
import type { SettingDef, SettingId } from "./setting-def";
import { SETTINGS_INDEX } from "./settings-nav";
import { readRevertSource, revertSourceOf, type RestoreStep, type RevertibleValue, type RevertSource } from "./setting-value";

/** A setting whose row Revert can put back. */
export type RevertibleDef = SettingDef & { readonly value: RevertibleValue };

/** A setting this visit changed: the whole source from just before the first local write that changed it. */
export interface JournalEntry {
  readonly def: RevertibleDef;
  readonly before: RevertSource;
  /**
   * A Revert wrote the value back but its `afterWrite` failed, so the change stays listed (and retryable) even though
   * the saved value already equals `before`. A later local change to the setting clears it.
   */
  readonly afterWriteFailed?: true;
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

/** One write Revert sends, and each setting's `afterWrite` to run once it succeeds. */
export interface RevertBatch {
  readonly step: RestoreStep;
  readonly ids: readonly SettingId[];
  readonly afterWrites?: readonly { readonly id: SettingId; readonly run: () => Promise<string | null> }[];
}

/** Writes Revert sends: at most one per sink, in sink order. */
export interface RevertPlan {
  readonly batches: readonly RevertBatch[];
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

function leafPaths(value: unknown, prefix: readonly string[] = []): (readonly string[])[] {
  if (!isRecord(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...prefix, key]));
}

function isPrefix(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((key, index) => key === b[index]);
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), value);
}

/** Leaf paths whose values differ between two patches. */
function changedPaths(a: unknown, b: unknown): (readonly string[])[] {
  const unique = new Map([...leafPaths(a), ...leafPaths(b)].map((path) => [path.join("\0"), path]));
  return [...unique.values()].filter((path) => !sameValue(valueAt(a, path), valueAt(b, path)));
}

/** True when `patch` writes `path` (or a path inside or around it) with the value `target` has there. */
function patchSendsPath(patch: unknown, path: readonly string[], target: unknown): boolean {
  return leafPaths(patch).some((leaf) => isPrefix(leaf, path) || isPrefix(path, leaf))
    && sameValue(valueAt(patch, path), valueAt(target, path));
}

function sendsProfile(scope: LocalWriteScope, step: RestoreStep): boolean {
  if (step.sink === "terminalGlobalDefault") return scope.sink === step.sink && sameValue(step.profileId, scope.profileId);
  if (step.sink === "terminalProjectDefault") {
    return scope.sink === step.sink && step.workspaceId === scope.workspaceId && sameValue(step.profileId, scope.profileId);
  }
  return false;
}

/**
 * Indexes into `scopes` of the in-flight writes that explain how `def` changed from `prev` to `next`, or null when
 * some changed field is not sent, with its new value, by any of them. `restore(x, x)` names what writing a value sends,
 * so the fields that differ between the two steps are what changed. Matching each changed field and its value, not the
 * whole value, keeps a pending write to one field of a grouped row (both Fast flags) from claiming an outside change
 * to another; the window's own push can arrive before its RPC response, so arrival path alone cannot tell them apart.
 */
function explainingWrites(def: RevertibleDef, scopes: readonly LocalWriteScope[], prev: RevertSource, next: RevertSource): number[] | null {
  const before = def.value.restore(prev, prev);
  const after = def.value.restore(next, next);
  if (after.sink !== "settings" && after.sink !== "terminalPreferences") {
    const index = scopes.findIndex((scope) => sendsProfile(scope, after));
    return index === -1 ? null : [index];
  }
  const paths = before.sink === after.sink ? changedPaths(before.patch, after.patch) : leafPaths(after.patch);
  if (paths.length === 0) return null;
  const used = new Set<number>();
  for (const path of paths) {
    const index = scopes.findIndex((scope) => scope.sink === after.sink && patchSendsPath(scope.patch, path, after.patch));
    if (index === -1) return null;
    used.add(index);
  }
  return [...used];
}

/**
 * One source transition, attributed per setting. A def whose read changed and that an in-flight local write in
 * `scopes` addresses is this visit's own: record `prev` as before if it has no entry yet. Any other def whose read
 * changed now belongs to whoever wrote it, so drop its entry.
 */
export function journalTransition(
  journal: ReadonlyMap<SettingId, JournalEntry>,
  defs: readonly RevertibleDef[],
  prev: RevertSource,
  next: RevertSource,
  scopes: readonly LocalWriteScope[],
): ReadonlyMap<SettingId, JournalEntry> {
  const changed = defs.filter((def) => !sameValue(def.value.read(prev), def.value.read(next)));
  // A local write claims an untouched row; an outside write releases a claimed one. Anything else keeps the journal.
  // A local change to a row whose switch-back failed also clears that mark.
  const affected = changed
    .map((def) => ({ def, local: explainingWrites(def, scopes, prev, next) !== null }))
    .filter(({ def, local }) => journal.has(def.id) !== local || (local && journal.get(def.id)?.afterWriteFailed));
  if (affected.length === 0) return journal;
  const out = new Map(journal);
  for (const { def, local } of affected) {
    if (local) out.set(def.id, { def, before: journal.get(def.id)?.before ?? prev });
    else out.delete(def.id);
  }
  return out;
}

/**
 * Entries whose read(current) differs from read(before), or whose last switch-back failed, in page order. Changing a
 * value back by hand removes it.
 */
export function changedEntries(journal: ReadonlyMap<SettingId, JournalEntry>, current: RevertSource): readonly JournalEntry[] {
  return [...journal.values()]
    .filter((entry) => entry.afterWriteFailed || !sameValue(entry.def.value.read(entry.before), entry.def.value.read(current)))
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
    if (refusal?.reason == null) {
      if (ids.length === 0) return [];
      const afterWrites = pending.flatMap(({ id, step }) => (step.sink === "settings" && step.afterWrite ? [{ id, run: step.afterWrite }] : []));
      return [{ step: { sink: "settings", patch: patch.data }, ids, ...(afterWrites.length > 0 && { afterWrites }) }];
    }
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

interface Visit {
  /** New per visit, so a revert or write that outlives its visit cannot touch the next one. */
  readonly id: number;
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
/** For each claimed setting, every in-flight write its local attributions relied on to land. */
let reliedOn = new Map<SettingId, readonly number[]>();

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
  // A revert's own writes are local writes too, so the same per-setting attribution covers it.
  const writes = localSettingsWrites(visit.startSeq);
  const journal = journalTransition(visit.journal, REVERTIBLE_DEFS, lastSource, next, writes.map((write) => write.scope));
  recordReliance(journal, lastSource, next, writes);
  lastSource = next;
  if (journal !== visit.journal) patchVisit(visit.id, { journal, failures: [] });
}

function recordReliance(journal: ReadonlyMap<SettingId, JournalEntry>, prev: RevertSource, next: RevertSource, writes: readonly LocalWrite[]): void {
  const scopes = writes.map((write) => write.scope);
  for (const def of REVERTIBLE_DEFS) {
    if (sameValue(def.value.read(prev), def.value.read(next))) continue;
    const explaining = journal.has(def.id) ? explainingWrites(def, scopes, prev, next) : null;
    if (explaining === null) {
      reliedOn.delete(def.id);
      continue;
    }
    // Keep earlier writes: a grouped row (both Fast flags) can rely on a pending write to one field while a write to
    // the other lands. A write that already landed never fails, so keeping it is harmless.
    const seqs = explaining.map((index) => writes[index]?.seq ?? 0);
    reliedOn.set(def.id, [...new Set([...(reliedOn.get(def.id) ?? []), ...seqs])]);
  }
}

/** A failed write landed nothing, so a setting claimed on the assumption it would was changed by someone else. */
function onWriteFailed(seq: number): void {
  const visit = useVisitStore.getState().visit;
  if (visit === null) return;
  const released = [...reliedOn].filter(([, seqs]) => seqs.includes(seq)).map(([id]) => id);
  if (released.length === 0) return;
  const journal = new Map(visit.journal);
  for (const id of released) {
    reliedOn.delete(id);
    journal.delete(id);
  }
  patchVisit(visit.id, { journal, failures: [] });
}

function startVisit(): number {
  stopListening?.();
  const id = ++nextVisitId;
  lastSource = readRevertSource();
  reliedOn = new Map();
  useVisitStore.setState({ visit: { id, journal: new Map(), startSeq: latestLocalSettingsWriteSeq(), reverting: false, failures: [] } });
  const unsubscribers = [
    useSettingsStore.subscribe(onSourceChange),
    useWorkspaceStore.subscribe(onSourceChange),
    useTerminalSettingsStore.subscribe(onSourceChange),
    subscribeFailedLocalSettingsWrites(onWriteFailed),
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

/** Starts a visit and ends it when `pageVisit` changes (page navigation, not an opened search hit) or the canvas unmounts. */
export function useSettingsVisit(pageVisit: number): void {
  useEffect(() => {
    const id = startVisit();
    return () => endVisit(id);
  }, [pageVisit]);
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

/**
 * Plans `planned` again from the visit's journal as it is now, so a setting an outside write released while an
 * earlier batch ran is not written.
 */
function replanBatch(visitId: number, planned: RevertPlan["batches"][number]): RevertPlan {
  const visit = useVisitStore.getState().visit;
  if (visit?.id !== visitId) return { batches: [], blocked: [] };
  const current = readRevertSource();
  const entries = changedEntries(visit.journal, current).filter((entry) => planned.ids.includes(entry.def.id));
  return planRevert(entries, current);
}

async function runBatches(
  visitId: number,
  plan: RevertPlan,
): Promise<{ readonly done: readonly SettingId[]; readonly afterWriteFailed: readonly SettingId[]; readonly failures: readonly RevertFailure[] }> {
  const failures: RevertFailure[] = [...plan.blocked];
  const done: SettingId[] = [];
  const afterWriteFailed: SettingId[] = [];
  for (const planned of plan.batches) {
    const { batches, blocked } = replanBatch(visitId, planned);
    failures.push(...blocked);
    for (const batch of batches) {
      const reason = await runStep(batch.step);
      if (reason !== null) {
        failures.push(...failuresFor(batch.ids, reason));
        continue;
      }
      const failed = new Set<SettingId>();
      for (const after of batch.afterWrites ?? []) {
        const afterReason = await after.run();
        if (afterReason === null) continue;
        failed.add(after.id);
        failures.push(...failuresFor([after.id], afterReason));
      }
      done.push(...batch.ids.filter((id) => !failed.has(id)));
      afterWriteFailed.push(...failed);
    }
  }
  return { done, afterWriteFailed, failures };
}

function journalAfterRevert(
  journal: ReadonlyMap<SettingId, JournalEntry>,
  done: readonly SettingId[],
  afterWriteFailed: readonly SettingId[],
  current: RevertSource,
): ReadonlyMap<SettingId, JournalEntry> {
  const out = new Map(journal);
  // A local change made while the Revert ran moved the value off `before` again; that change stays offered.
  for (const id of done) {
    const entry = out.get(id);
    if (entry && sameValue(entry.def.value.read(entry.before), entry.def.value.read(current))) out.delete(id);
  }
  for (const id of afterWriteFailed) {
    const entry = out.get(id);
    if (entry) out.set(id, { ...entry, afterWriteFailed: true });
  }
  return out;
}

/** Puts back every change of the current visit. Idempotent: a second call finds nothing to do. */
export async function revertVisit(): Promise<{ readonly failures: readonly RevertFailure[] }> {
  const visit = useVisitStore.getState().visit;
  if (visit === null || visit.reverting || isLocalSettingsWriteInFlight()) return { failures: visit?.failures ?? NO_FAILURES };
  const plan = planRevert(changedEntries(visit.journal, readRevertSource()), readRevertSource());
  patchVisit(visit.id, { reverting: true });
  const { done, afterWriteFailed, failures } = await runBatches(visit.id, plan);
  const latest = useVisitStore.getState().visit;
  if (latest?.id === visit.id) {
    patchVisit(visit.id, { journal: journalAfterRevert(latest.journal, done, afterWriteFailed, readRevertSource()), reverting: false, failures });
  }
  return { failures };
}
