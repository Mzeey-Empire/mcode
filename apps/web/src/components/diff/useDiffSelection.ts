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
import { unifiedDiffText } from "./diff-text";
import { holdsSelection, SourceSelection } from "./source-selection";

interface ActiveSelection {
  readonly file: FileDiffMetadata;
  readonly selection: SourceSelection;
}

interface CachedText {
  readonly isPartial: boolean;
  readonly hunks: FileDiffMetadata["hunks"];
  readonly additionLines: readonly string[];
  readonly deletionLines: readonly string[];
  readonly text: string;
}

const cachedTexts = new WeakMap<FileDiffMetadata, CachedText>();

/**
 * Hydrating a diff mutates its metadata in place and swaps its line arrays, so the text is keyed on
 * those arrays and not on the metadata object alone.
 */
function diffTextOf(file: FileDiffMetadata): string {
  const cached = cachedTexts.get(file);
  if (
    cached &&
    cached.isPartial === file.isPartial &&
    cached.hunks === file.hunks &&
    cached.additionLines === file.additionLines &&
    cached.deletionLines === file.deletionLines
  ) {
    return cached.text;
  }
  const text = unifiedDiffText(file);
  cachedTexts.set(file, {
    isPartial: file.isPartial,
    hunks: file.hunks,
    additionLines: file.additionLines,
    deletionLines: file.deletionLines,
    text,
  });
  return text;
}

function unifiedIndexOf(row: HTMLElement): number {
  return Number(row.dataset.lineIndex?.split(",")[0]);
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
 * is kept as offsets into the file's text and drawn back after each render. One selection is active at
 * a time, in the file whose rows hold the browser's selection.
 */
export function useDiffSelection(
  scrollerRef: RefObject<HTMLElement | null>,
  renderMode: "unified" | "side-by-side",
): DiffSelection {
  // Split mode lays rows out in two columns that share unified indices, so one text cannot address
  // them; the browser keeps its own selection there.
  const enabled = renderMode === "unified";
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

  const track = useCallback(() => {
    if (!enabled) return;
    const holder = diffRoots().find(holdsSelection);
    if (!holder) {
      // A file item that unmounts moves the selection out of every diff too, so only a press ends it.
      if (state.press) state.active = undefined;
      return;
    }
    const file = roots.get(holder);
    if (!file) return;
    if (state.active?.file !== file) {
      const selection = new SourceSelection(unifiedIndexOf);
      if (state.press) selection.press(state.press.extending);
      state.active = { file, selection };
    }
    state.active.selection.sync(holder, diffTextOf(file));
  }, [diffRoots, enabled, roots, state]);

  const release = useCallback(() => {
    state.press = undefined;
    const active = state.active;
    const root = active && diffRoots().find((candidate) => roots.get(candidate) === active.file);
    if (active && root) active.selection.release(root, diffTextOf(active.file));
  }, [diffRoots, roots, state]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const extending = event.button !== 0 || event.shiftKey;
      state.press = { extending };
      state.active?.selection.press(extending);
    },
    [enabled, state],
  );

  const onCopy = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const active = state.active;
      const root =
        event.target instanceof Element
          ? event.target.closest("diffs-container")?.shadowRoot
          : undefined;
      if (!enabled || !active || !root || roots.get(root) !== active.file) return;
      const copied = active.selection.copy(root, diffTextOf(active.file));
      if (copied === undefined) return;
      event.clipboardData.setData("text/plain", copied);
      event.preventDefault();
    },
    [enabled, roots, state],
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
      if (enabled && state.active?.file === file) {
        state.active.selection.render(root, diffTextOf(file));
      }
    },
    [enabled, roots, state],
  );

  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, release, state, track]);

  // Scrolling unmounts rows, and a selection made in the same task has not been reported yet.
  return { wrapperProps: { onPointerDown, onScrollCapture: track, onCopy }, onPostRender };
}
