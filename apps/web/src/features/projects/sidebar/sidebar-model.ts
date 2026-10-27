import type { SidebarScope, SidebarView } from "./sidebar-ui-store";

/**
 * Thread identity, hierarchy and parsed timestamps used to derive sidebar order.
 */
export interface SidebarThreadFacts {
  readonly id: string;
  readonly workspaceId: string;
  /** Parent in the branch tree, or null. A child whose parent sits in another section becomes a root. */
  readonly parentId: string | null;
  readonly activityMs: number;
  /** Server-confirmed `user_completed_at`, or null. Optimistic completion is in `completions`, never here. */
  readonly completedMs: number | null;
}

/**
 * A completion this client started and the server has not settled for the row yet. `holding`
 * waits for the server's hold to end, `lingering` is confirmed but stays while the pointer rests
 * on the row, `failed` is back in Active with a reason.
 */
export interface PendingCompletion {
  readonly phase: "holding" | "lingering" | "failed";
}

/** A snapshot taken when the pointer enters the list. Reorders and Older moves wait until it clears. */
export interface FrozenOrder {
  readonly at: number;
  readonly activityMs: ReadonlyMap<string, number>;
}

/** UI state the model reads. */
export interface SidebarModelUi {
  readonly scope: SidebarScope;
  readonly view: SidebarView;
  readonly olderOpen: boolean;
  readonly collapsedProjects: ReadonlySet<string>;
  readonly collapsedOlderProjects: ReadonlySet<string>;
  readonly showMore: ReadonlySet<string>;
  readonly frozen: FrozenOrder | null;
}

/** Inputs used to derive sidebar rows, scope and aging boundaries. */
export interface SidebarInputs {
  readonly facts: readonly SidebarThreadFacts[];
  /** Workspace ids in the user's project order. */
  readonly projectOrder: readonly string[];
  /** Unsent draft ids per workspace, newest first. Shown above that project's threads in Active. */
  readonly draftsByWorkspace: ReadonlyMap<string, readonly string[]>;
  /** Threads for which `threadAttentionNeedsUser` is true. Never Older. */
  readonly needsUserIds: ReadonlySet<string>;
  /** When, in this session, each thread last stopped needing the user. */
  readonly needsUserEndedAt: ReadonlyMap<string, number>;
  readonly completions: ReadonlyMap<string, PendingCompletion>;
  readonly olderAfterDays: 7 | 14 | 30 | null;
  readonly ui: SidebarModelUi;
  readonly selectedThreadId: string | null;
  readonly now: number;
  /** Bumped each time a whole-index snapshot (hydration, reconnect) replaces the threads. */
  readonly snapshotEpoch: number;
}

/** Which part of the Active list an item sits in. */
export type SidebarSection = "recent" | "older";

/** How a pending completion marks its row. */
export type SidebarRowPending = "none" | "completing" | "failed";

/**
 * One virtual row. Keys are typed per kind so two kinds never collide in the virtual list, and a
 * thread appears under exactly one key whatever its section.
 */
export type SidebarItem =
  | { readonly kind: "project"; readonly key: `project:${string}` | `older-project:${string}`; readonly workspaceId: string; readonly section: SidebarSection; readonly collapsed: boolean; readonly count: number }
  | { readonly kind: "draft"; readonly key: `draft:${string}`; readonly draftId: string; readonly workspaceId: string }
  | { readonly kind: "thread"; readonly key: `thread:${string}`; readonly threadId: string; readonly section: SidebarSection; readonly layout: "grouped" | "flat"; readonly depth: number; readonly pending: SidebarRowPending }
  | { readonly kind: "show-more"; readonly key: `more:${string}`; readonly workspaceId: string; readonly hidden: number; readonly expanded: boolean }
  | { readonly kind: "older-bar"; readonly key: "older-bar"; readonly count: number; readonly open: boolean }
  | { readonly kind: "empty"; readonly key: "empty"; readonly scope: SidebarScope }
  | { readonly kind: "end-spacer"; readonly key: "end-spacer" };

/** The derived sidebar. */
export interface SidebarModel {
  /** Effective scope: Active when nothing is completed, so the hidden bar never strands the user. */
  readonly scope: SidebarScope;
  readonly scopeBar: { readonly visible: boolean; readonly completedCount: number };
  readonly items: readonly SidebarItem[];
  /** Null when no thread is Older (the bar exists only then) or the scope is Completed. */
  readonly olderBar: { readonly count: number; readonly open: boolean } | null;
  /** Thread ids in Older, for the motion layer's clock-crossing diff. */
  readonly olderIds: ReadonlySet<string>;
  /** Server-confirmed completed thread ids, for the motion layer's completion diff. */
  readonly completedIds: ReadonlySet<string>;
  /** Earliest future time an Active thread crosses into Older, or null. */
  readonly nextBoundaryAt: number | null;
}

/** Project row cap before Show more; a family crossing the cap remains whole. */
export const PROJECT_ROW_CAP = 6;

const DAY_MS = 86_400_000;

interface Placed {
  readonly fact: SidebarThreadFacts;
  readonly key: number;
  readonly pending: SidebarRowPending;
}

interface FamilyRow {
  readonly placed: Placed;
  readonly depth: number;
}

interface Family {
  readonly rows: readonly FamilyRow[];
  readonly key: number;
}

function pendingOf(entry: PendingCompletion | undefined): SidebarRowPending {
  if (!entry) return "none";
  return entry.phase === "failed" ? "failed" : "completing";
}

function isInCompletedScope(fact: SidebarThreadFacts, inputs: SidebarInputs): boolean {
  return !inputs.completions.has(fact.id) && fact.completedMs !== null;
}

function activityKey(fact: SidebarThreadFacts, frozen: FrozenOrder | null): number {
  return frozen?.activityMs.get(fact.id) ?? fact.activityMs;
}

function olderSince(fact: SidebarThreadFacts, activity: number, inputs: SidebarInputs): number {
  return Math.max(activity, inputs.needsUserEndedAt.get(fact.id) ?? Number.NEGATIVE_INFINITY);
}

function canAge(fact: SidebarThreadFacts, inputs: SidebarInputs): boolean {
  return inputs.olderAfterDays !== null && !inputs.needsUserIds.has(fact.id) && !inputs.completions.has(fact.id);
}

function isOlder(fact: SidebarThreadFacts, inputs: SidebarInputs): boolean {
  if (!canAge(fact, inputs) || inputs.olderAfterDays === null) return false;
  const frozen = inputs.ui.frozen;
  const clock = frozen?.at ?? inputs.now;
  return clock - olderSince(fact, activityKey(fact, frozen), inputs) >= inputs.olderAfterDays * DAY_MS;
}

function byKeyDesc(a: { readonly key: number; readonly id: string }, b: { readonly key: number; readonly id: string }): number {
  return b.key - a.key || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function comparePlaced(a: Placed, b: Placed): number {
  return byKeyDesc({ key: a.key, id: a.fact.id }, { key: b.key, id: b.fact.id });
}

function buildFamilies(placed: readonly Placed[]): Family[] {
  const ids = new Set(placed.map((entry) => entry.fact.id));
  const children = new Map<string, Placed[]>();
  const roots: Placed[] = [];
  for (const entry of placed) {
    const parentId = entry.fact.parentId;
    if (parentId !== null && parentId !== entry.fact.id && ids.has(parentId)) {
      const siblings = children.get(parentId);
      if (siblings) siblings.push(entry);
      else children.set(parentId, [entry]);
    } else {
      roots.push(entry);
    }
  }
  const families = roots.map((root) => collectFamily(root, children));
  return families.sort((a, b) => byKeyDesc({ key: a.key, id: firstId(a) }, { key: b.key, id: firstId(b) }));
}

function firstId(family: Family): string {
  return family.rows[0]?.placed.fact.id ?? "";
}

function collectFamily(root: Placed, children: ReadonlyMap<string, Placed[]>): Family {
  const rows: FamilyRow[] = [];
  const visited = new Set<string>();
  let key = Number.NEGATIVE_INFINITY;
  const walk = (entry: Placed, depth: number): void => {
    if (visited.has(entry.fact.id)) return;
    visited.add(entry.fact.id);
    rows.push({ placed: entry, depth });
    key = Math.max(key, entry.key);
    for (const child of [...(children.get(entry.fact.id) ?? [])].sort(comparePlaced)) walk(child, depth + 1);
  };
  walk(root, 0);
  return { rows, key };
}

function threadItem(row: FamilyRow, section: SidebarSection, layout: "grouped" | "flat"): SidebarItem {
  return {
    kind: "thread",
    key: `thread:${row.placed.fact.id}`,
    threadId: row.placed.fact.id,
    section,
    layout,
    depth: layout === "flat" ? 0 : row.depth,
    pending: row.placed.pending,
  };
}

function groupByWorkspace(placed: readonly Placed[]): Map<string, Placed[]> {
  const map = new Map<string, Placed[]>();
  for (const entry of placed) {
    const list = map.get(entry.fact.workspaceId);
    if (list) list.push(entry);
    else map.set(entry.fact.workspaceId, [entry]);
  }
  return map;
}

interface Partitioned {
  readonly recent: readonly Placed[];
  readonly older: readonly Placed[];
  readonly completed: readonly Placed[];
}

function partition(inputs: SidebarInputs): Partitioned {
  const recent: Placed[] = [];
  const older: Placed[] = [];
  const completed: Placed[] = [];
  for (const fact of inputs.facts) {
    if (isInCompletedScope(fact, inputs)) {
      completed.push({ fact, key: fact.completedMs ?? 0, pending: "none" });
      continue;
    }
    const placed: Placed = { fact, key: activityKey(fact, inputs.ui.frozen), pending: pendingOf(inputs.completions.get(fact.id)) };
    if (isOlder(fact, inputs)) older.push(placed);
    else recent.push(placed);
  }
  return { recent, older, completed };
}

interface SectionContext {
  readonly inputs: SidebarInputs;
  readonly section: SidebarSection;
}

function capFamilies(families: readonly Family[]): { shown: Family[]; hiddenRows: number } {
  const shown: Family[] = [];
  let rows = 0;
  let hiddenRows = 0;
  for (const family of families) {
    if (rows < PROJECT_ROW_CAP) {
      shown.push(family);
      rows += family.rows.length;
    } else {
      hiddenRows += family.rows.length;
    }
  }
  return { shown, hiddenRows };
}

function selectedRow(families: readonly Family[], selectedId: string | null): FamilyRow | null {
  if (selectedId === null) return null;
  for (const family of families) {
    const row = family.rows.find((candidate) => candidate.placed.fact.id === selectedId);
    if (row) return { placed: row.placed, depth: 0 };
  }
  return null;
}

function cappedProjectRows(workspaceId: string, families: readonly Family[], ctx: SectionContext): SidebarItem[] {
  const expanded = ctx.inputs.ui.showMore.has(workspaceId);
  const { shown, hiddenRows } = capFamilies(families);
  if (hiddenRows === 0) return families.flatMap((family) => family.rows.map((row) => threadItem(row, ctx.section, "grouped")));
  const visible = expanded ? families : shown;
  const items = visible.flatMap((family) => family.rows.map((row) => threadItem(row, ctx.section, "grouped")));
  const cutSelected = expanded ? null : selectedRow(families.slice(shown.length), ctx.inputs.selectedThreadId);
  if (cutSelected) items.push(threadItem(cutSelected, ctx.section, "grouped"));
  const hidden = expanded ? 0 : hiddenRows - (cutSelected ? 1 : 0);
  items.push({ kind: "show-more", key: `more:${workspaceId}`, workspaceId, hidden, expanded });
  return items;
}

function projectHeader(workspaceId: string, section: SidebarSection, collapsed: boolean, count: number): SidebarItem {
  const key = section === "older" ? (`older-project:${workspaceId}` as const) : (`project:${workspaceId}` as const);
  return { kind: "project", key, workspaceId, section, collapsed, count };
}

function draftItems(workspaceId: string, inputs: SidebarInputs): SidebarItem[] {
  return (inputs.draftsByWorkspace.get(workspaceId) ?? []).map((draftId) => ({ kind: "draft", key: `draft:${draftId}`, draftId, workspaceId }));
}

interface ProjectGroupOptions {
  readonly collapsedSet: ReadonlySet<string>;
  readonly capped: boolean;
  readonly drafts: boolean;
}

function projectGroup(workspaceId: string, placed: readonly Placed[], ctx: SectionContext, options: ProjectGroupOptions): SidebarItem[] {
  const families = buildFamilies(placed);
  const collapsed = options.collapsedSet.has(workspaceId);
  const header = projectHeader(workspaceId, ctx.section, collapsed, placed.length);
  if (collapsed) {
    const selected = selectedRow(families, ctx.inputs.selectedThreadId);
    return selected ? [header, threadItem(selected, ctx.section, "grouped")] : [header];
  }
  const drafts = options.drafts ? draftItems(workspaceId, ctx.inputs) : [];
  const rows = options.capped
    ? cappedProjectRows(workspaceId, families, ctx)
    : families.flatMap((family) => family.rows.map((row) => threadItem(row, ctx.section, "grouped")));
  return [header, ...drafts, ...rows];
}

function recentProjectsView(parts: Partitioned, inputs: SidebarInputs): SidebarItem[] {
  const recentByWorkspace = groupByWorkspace(parts.recent);
  const olderWorkspaces = new Set(parts.older.map((entry) => entry.fact.workspaceId));
  const ctx: SectionContext = { inputs, section: "recent" };
  const options: ProjectGroupOptions = { collapsedSet: inputs.ui.collapsedProjects, capped: true, drafts: true };
  return inputs.projectOrder.flatMap((workspaceId) => {
    const placed = recentByWorkspace.get(workspaceId) ?? [];
    const hasDrafts = (inputs.draftsByWorkspace.get(workspaceId)?.length ?? 0) > 0;
    if (placed.length === 0 && !hasDrafts && olderWorkspaces.has(workspaceId)) return [];
    return projectGroup(workspaceId, placed, ctx, options);
  });
}

function flatRows(placed: readonly Placed[], section: SidebarSection): SidebarItem[] {
  return [...placed].sort(comparePlaced).map((entry) => threadItem({ placed: entry, depth: 0 }, section, "flat"));
}

function recentThreadsView(parts: Partitioned, inputs: SidebarInputs): SidebarItem[] {
  const drafts = inputs.projectOrder.flatMap((workspaceId) => draftItems(workspaceId, inputs));
  return [...drafts, ...flatRows(parts.recent, "recent")];
}

function olderOpenItems(older: readonly Placed[], inputs: SidebarInputs): SidebarItem[] {
  if (inputs.ui.view === "threads") return flatRows(older, "older");
  const byWorkspace = groupByWorkspace(older);
  const ctx: SectionContext = { inputs, section: "older" };
  const options: ProjectGroupOptions = { collapsedSet: inputs.ui.collapsedOlderProjects, capped: false, drafts: false };
  return inputs.projectOrder.flatMap((workspaceId) => {
    const placed = byWorkspace.get(workspaceId);
    return placed ? projectGroup(workspaceId, placed, ctx, options) : [];
  });
}

function olderSectionItems(older: readonly Placed[], inputs: SidebarInputs): SidebarItem[] {
  if (older.length === 0) return [];
  const bar: SidebarItem = { kind: "older-bar", key: "older-bar", count: older.length, open: inputs.ui.olderOpen };
  if (inputs.ui.olderOpen) return [bar, ...olderOpenItems(older, inputs)];
  const selected = older.find((entry) => entry.fact.id === inputs.selectedThreadId);
  return selected ? [bar, threadItem({ placed: selected, depth: 0 }, "older", "flat")] : [bar];
}

function completedItems(parts: Partitioned, inputs: SidebarInputs): SidebarItem[] {
  if (parts.completed.length === 0) return [{ kind: "empty", key: "empty", scope: "completed" }];
  if (inputs.ui.view === "threads") return flatRows(parts.completed, "recent");
  const byWorkspace = groupByWorkspace(parts.completed);
  const ctx: SectionContext = { inputs, section: "recent" };
  const options: ProjectGroupOptions = { collapsedSet: inputs.ui.collapsedProjects, capped: false, drafts: false };
  return inputs.projectOrder.flatMap((workspaceId) => {
    const placed = byWorkspace.get(workspaceId);
    return placed ? projectGroup(workspaceId, placed, ctx, options) : [];
  });
}

function activeItems(parts: Partitioned, inputs: SidebarInputs): SidebarItem[] {
  const recent = inputs.ui.view === "threads" ? recentThreadsView(parts, inputs) : recentProjectsView(parts, inputs);
  const items = [...recent, ...olderSectionItems(parts.older, inputs)];
  return items.length === 0 ? [{ kind: "empty", key: "empty", scope: "active" }] : items;
}

function nextBoundary(parts: Partitioned, inputs: SidebarInputs): number | null {
  if (inputs.olderAfterDays === null) return null;
  const span = inputs.olderAfterDays * DAY_MS;
  let next: number | null = null;
  for (const { fact } of parts.recent) {
    if (!canAge(fact, inputs)) continue;
    const at = olderSince(fact, fact.activityMs, inputs) + span;
    if (at > inputs.now && (next === null || at < next)) next = at;
  }
  return next;
}

/**
 * Derives sidebar rows, effective scope and aging boundaries without side effects.
 * Pending completions stay Active; an empty Completed scope falls back to Active.
 */
export function deriveSidebarModel(inputs: SidebarInputs): SidebarModel {
  const parts = partition(inputs);
  const completedCount = parts.completed.length;
  const scope: SidebarScope = completedCount === 0 ? "active" : inputs.ui.scope;
  const active = scope === "active";
  const body = active ? activeItems(parts, inputs) : completedItems(parts, inputs);
  return {
    scope,
    scopeBar: { visible: completedCount > 0, completedCount },
    items: [...body, { kind: "end-spacer", key: "end-spacer" }],
    olderBar: active && parts.older.length > 0 ? { count: parts.older.length, open: inputs.ui.olderOpen } : null,
    olderIds: new Set(active ? parts.older.map((entry) => entry.fact.id) : []),
    completedIds: new Set(parts.completed.map((entry) => entry.fact.id)),
    nextBoundaryAt: nextBoundary(parts, inputs),
  };
}

/**
 * Records when threads stop needing the user. Returns `previous` itself when nothing ended.
 */
export function trackNeedsUserEnds(
  previous: ReadonlyMap<string, number>,
  wasNeeding: ReadonlySet<string>,
  isNeeding: ReadonlySet<string>,
  now: number,
): ReadonlyMap<string, number> {
  let next: Map<string, number> | null = null;
  for (const id of wasNeeding) {
    if (isNeeding.has(id)) continue;
    next ??= new Map(previous);
    next.set(id, now);
  }
  return next ?? previous;
}

function sameItem(a: SidebarItem, b: SidebarItem): boolean {
  if (a === b) return true;
  const aFields = Object.entries(a);
  if (aFields.length !== Object.keys(b).length) return false;
  const bRecord: Readonly<Record<string, unknown>> = b;
  return aFields.every(([field, value]) => bRecord[field] === value);
}

/**
 * Reuses field-for-field equal items. Returns `prev` itself when nothing changed.
 */
export function reconcileItems(prev: readonly SidebarItem[], next: readonly SidebarItem[]): readonly SidebarItem[] {
  const prevByKey = new Map(prev.map((item) => [item.key, item]));
  let changed = prev.length !== next.length;
  const merged = next.map((item, index) => {
    const old = prevByKey.get(item.key);
    const kept = old && sameItem(old, item) ? old : item;
    if (kept !== prev[index]) changed = true;
    return kept;
  });
  return changed ? merged : prev;
}

/**
 * What made the model change. `snapshot` (hydration, reconnect) places without motion, `layout`
 * (scope, view, threshold, Older open) re-lays out without FLIP, `clock` is time alone, and
 * `push` is live data, the only cause that animates.
 */
export type ModelCause = "snapshot" | "layout" | "clock" | "push";
