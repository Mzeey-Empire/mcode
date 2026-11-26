import type {
  File as FileInstance,
  FileDiff,
  FileDiffMetadata,
  PostRenderPhase,
} from "@pierre/diffs";
import {
  type ClipboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { type DiffColumn, type DiffText, splitColumnText, unifiedDiffText } from "./diff-text";
import { rangeHeldBy, SourceSelection, type SourceRows } from "./source-selection";

interface ActiveSelection {
  readonly file: FileDiffMetadata;
  readonly column: DiffColumn;
  readonly selection: SourceSelection;
}

interface CachedTexts {
  readonly isPartial: boolean;
  readonly hunks: FileDiffMetadata["hunks"];
  readonly additionLines: readonly string[];
  readonly deletionLines: readonly string[];
  readonly byColumn: Partial<Record<DiffColumn, DiffText>>;
}

const cachedTexts = new WeakMap<FileDiffMetadata, CachedTexts>();

function isCurrent(cached: CachedTexts, file: FileDiffMetadata) {
  return (
    cached.isPartial === file.isPartial &&
    cached.hunks === file.hunks &&
    cached.additionLines === file.additionLines &&
    cached.deletionLines === file.deletionLines
  );
}

function buildText(file: FileDiffMetadata, column: DiffColumn): DiffText {
  return column === "unified" ? unifiedDiffText(file) : splitColumnText(file, column);
}

/**
 * Hydrating a diff mutates its metadata in place and swaps its line arrays, so the text is keyed on
 * those arrays and not on the metadata object alone.
 */
function diffTextOf(file: FileDiffMetadata, column: DiffColumn): DiffText {
  let cached = cachedTexts.get(file);
  if (!cached || !isCurrent(cached, file)) {
    cached = {
      isPartial: file.isPartial,
      hunks: file.hunks,
      additionLines: file.additionLines,
      deletionLines: file.deletionLines,
      byColumn: {},
    };
    cachedTexts.set(file, cached);
  }
  return (cached.byColumn[column] ??= buildText(file, column));
}

const COLUMNS: readonly DiffColumn[] = ["unified", "deletions", "additions"];

function columnAt(node: Node): DiffColumn | undefined {
  const element = node instanceof Element ? node : node.parentElement;
  const code = element?.closest<HTMLElement>("[data-code]");
  if (!code) return undefined;
  return COLUMNS.find((column) => column in code.dataset);
}

/** A file with one code column has no other for a selection to belong to. */
function soleColumnOf(root: ShadowRoot): DiffColumn | undefined {
  const columns = root.querySelectorAll("[data-code]");
  const [only] = columns;
  return columns.length === 1 && only ? columnAt(only) : undefined;
}

/**
 * The column a selection is kept in: the one it starts in, else the one it ends in. A selection whose
 * ends sit in two columns belongs to none, and the browser keeps it. A selection with an end in no column
 * stays in the column it was kept in, because the rows around an end unmount and leave it on a parent.
 */
function columnOf(root: ShadowRoot, range: StaticRange, kept: DiffColumn | undefined) {
  const start = columnAt(range.startContainer);
  const end = columnAt(range.endContainer);
  if (start && end && start !== end) return undefined;
  return start ?? end ?? kept ?? soleColumnOf(root);
}

/** Split columns share split indices, so a column's selection only maps the rows of its own column. */
function rowsOfColumn(column: DiffColumn): SourceRows {
  const rows = `[data-code][data-${column}] [data-line]`;
  const indexPart = column === "unified" ? 0 : 1;
  return {
    rowsOf: (root) => root.querySelectorAll<HTMLElement>(rows),
    lineOf: (row) => Number(row.dataset.lineIndex?.split(",")[indexPart]),
  };
}

function heldBy(roots: readonly ShadowRoot[]) {
  for (const root of roots) {
    const range = rangeHeldBy(root);
    if (range) return { root, range };
  }
  return undefined;
}

/** What the Review diff scroller needs to keep a text selection across Pierre's row virtualization. */
export interface DiffSelection {
  /** Props for the element that wraps the scroller. */
  readonly wrapperProps: {
    readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    readonly onScrollCapture: () => void;
    readonly onCopy: (event: ClipboardEvent<HTMLDivElement>) => void;
  };
  /** Pierre's `onPostRender` option: draws the selection back after a file renders. */
  readonly onPostRender: <Annotation>(
    node: HTMLElement,
    instance: FileInstance<Annotation, undefined> | FileDiff<Annotation, undefined>,
    phase: PostRenderPhase,
  ) => void;
}

/**
 * Keeps a text selection in the Review diff when its rows scroll out of view. Pierre rewrites the rows
 * it mounts on every scroll step, which detaches the text nodes a selection ends in, so the selection
 * is kept as offsets into the text of one column of a file and drawn back after each render. One
 * selection is active at a time, in the column whose rows hold the browser's selection.
 */
export function useDiffSelection(scrollerRef: RefObject<HTMLElement | null>): DiffSelection {
  const roots = useRef(new WeakMap<ShadowRoot, FileDiffMetadata>()).current;
  const state = useRef<{ active?: ActiveSelection; press?: { readonly extending: boolean } }>(
    {},
  ).current;

  const diffRoots = useCallback(
    () =>
      [...(scrollerRef.current?.querySelectorAll("diffs-container") ?? [])].flatMap(
        (host) => host.shadowRoot ?? [],
      ),
    [scrollerRef],
  );

  const activate = useCallback(
    (file: FileDiffMetadata, column: DiffColumn) => {
      const { active } = state;
      if (active?.file === file && active.column === column) return active;
      const selection = new SourceSelection(rowsOfColumn(column));
      if (state.press) selection.press(state.press.extending);
      return (state.active = { file, column, selection });
    },
    [state],
  );

  const track = useCallback(() => {
    const held = heldBy(diffRoots());
    if (!held) {
      // A file item that unmounts moves the selection out of every diff too, so only a press ends it.
      if (state.press) state.active = undefined;
      return;
    }
    const file = roots.get(held.root);
    if (!file) return;
    const kept = state.active?.file === file ? state.active.column : undefined;
    const column = columnOf(held.root, held.range, kept);
    if (!column) {
      state.active = undefined;
      return;
    }
    activate(file, column).selection.sync(held.root, diffTextOf(file, column).text);
  }, [activate, diffRoots, roots, state]);

  const release = useCallback(() => {
    state.press = undefined;
    const active = state.active;
    const root = active && diffRoots().find((candidate) => roots.get(candidate) === active.file);
    if (active && root) {
      active.selection.release(root, diffTextOf(active.file, active.column).text);
    }
  }, [diffRoots, roots, state]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const extending = event.button !== 0 || event.shiftKey;
      state.press = { extending };
      state.active?.selection.press(extending);
    },
    [state],
  );

  const onCopy = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const active = state.active;
      const root =
        event.target instanceof Element
          ? event.target.closest("diffs-container")?.shadowRoot
          : undefined;
      if (!active || !root || roots.get(root) !== active.file) return;
      const { text, unknown } = diffTextOf(active.file, active.column);
      const copied = active.selection.copy(root, text, unknown);
      if (copied === undefined) return;
      event.clipboardData.setData("text/plain", copied);
      event.preventDefault();
    },
    [roots, state],
  );

  const onPostRender = useCallback(
    <Annotation>(
      node: HTMLElement,
      instance: FileInstance<Annotation, undefined> | FileDiff<Annotation, undefined>,
      phase: PostRenderPhase,
    ) => {
      const file = "fileDiff" in instance ? instance.fileDiff : undefined;
      const root = node.shadowRoot;
      if (phase === "unmount" || !file || !root) return;
      roots.set(root, file);
      // Only the active file's host draws it, so a host reused for another file leaves the selection alone.
      const active = state.active;
      if (active?.file === file) active.selection.render(root, diffTextOf(file, active.column).text);
    },
    [roots, state],
  );

  useEffect(() => {
    document.addEventListener("selectionchange", track);
    // A drag that autoscrolls is usually released outside the diff.
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      document.removeEventListener("selectionchange", track);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      state.active = undefined;
      state.press = undefined;
    };
  }, [release, state, track]);

  // Scrolling unmounts rows, and a selection made in the same task has not been reported yet.
  return { wrapperProps: { onPointerDown, onScrollCapture: track, onCopy }, onPostRender };
}
