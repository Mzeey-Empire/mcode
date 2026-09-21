import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parsePatchFiles,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewItem,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import { ChevronRight, MessageCircle } from "lucide-react";
import { useDiffStore, type SelectedFile } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import {
  usePreviewAnnotationStore,
  type SavedDiffAnnotation,
} from "@/features/preview/state/previewAnnotationStore";
import type { ReviewFileChange } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { loadFileDiff } from "@/lib/load-file-diff";
import { parseDiffLines, isMarkdownFile } from "@/lib/diff-parser";
import { parseFirstHunkLine } from "@/lib/parse-first-hunk-line";
import { useShikiTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";
import { FileActionBar } from "./FileActionBar";
import { DiffCommentEditor } from "./DiffCommentEditor";
import { DiffPreview } from "./DiffPreview";

/** Line-annotation payloads rendered inside a diff item. */
type DiffRowMeta =
  | { readonly kind: "saved"; readonly annotationId: string }
  | { readonly kind: "draft" }
  | { readonly kind: "status"; readonly status: "loading" | "empty" | "binary" }
  | { readonly kind: "preview"; readonly patch: string };

type DiffItem = CodeViewItem<DiffRowMeta>;

const EMPTY_ANNOTATIONS: SavedDiffAnnotation[] = [];

/** Comparison sources whose old/new contents can be read from git refs. */
const HYDRATABLE_SOURCES: ReadonlySet<SelectedFile["source"]> = new Set([
  "unstaged",
  "staged",
  "commit",
  "branch",
]);

type RefReader = (ref: string, path: string) => Promise<FileContents>;

/**
 * Resolves the old/new file pair pierre needs to expand collapsed context.
 * Each git source maps to the refs git itself compared; snapshot and turn
 * diffs have no git ref, so they stay partial and their context bands render
 * collapsed without expansion.
 */
async function resolveHydrationFiles(
  source: SelectedFile["source"],
  id: string,
  fileDiff: FileDiffMetadata,
  at: RefReader,
  worktree: (path: string) => Promise<FileContents>,
): Promise<{ oldFile: FileContents | null; newFile: FileContents }> {
  const name = fileDiff.name;
  const prevName = fileDiff.prevName ?? name;
  const pair = await (async () => {
    switch (source) {
    // git diff compares the index against the working tree.
    case "unstaged":
      return { oldFile: await at("", prevName), newFile: await worktree(name) };
    // git diff --cached compares HEAD against the index.
    case "staged":
      return { oldFile: await at("HEAD", prevName), newFile: await at("", name) };
    case "commit":
      return { oldFile: await at(`${id}~1`, prevName), newFile: await at(id, name) };
    case "branch": {
      const sep = id.indexOf("...");
      const base = sep >= 0 ? id.slice(0, sep) : "";
      const target = sep >= 0 ? id.slice(sep + 3) || "HEAD" : "HEAD";
      return { oldFile: await at(`${base}...${target}`, prevName), newFile: await at(target, name) };
    }
    default:
      throw new Error(`Diff hydration is unsupported for source "${source}"`);
    }
  })();
  // Pure renames carry no content change; pierre requires oldFile to be null.
  if (fileDiff.type === "rename-pure") {
    return { oldFile: null, newFile: pair.newFile };
  }
  return pair;
}

/** Placeholder shown while a file's patch is loading or absent. */
function placeholderFileDiff(file: ReviewFileChange): FileDiffMetadata {
  return {
    name: file.path,
    prevName: file.previousPath ?? undefined,
    type:
      file.changeType === "added"
        ? "new"
        : file.changeType === "deleted"
          ? "deleted"
          : file.changeType === "renamed" || file.changeType === "copied"
            ? "rename-changed"
            : "change",
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  };
}

/** Resolves the patch-side text of one line so comments carry context. */
function lineContentAt(fileDiff: FileDiffMetadata, side: "left" | "right", line: number): string {
  for (const hunk of fileDiff.hunks) {
    if (side === "right" && line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount) {
      return fileDiff.additionLines[hunk.additionLineIndex + (line - hunk.additionStart)] ?? "";
    }
    if (side === "left" && line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount) {
      return fileDiff.deletionLines[hunk.deletionLineIndex + (line - hunk.deletionStart)] ?? "";
    }
  }
  return "";
}

/** Builds one CodeView item, folding status/preview rows into annotations. */
function buildItem({
  file,
  isExpanded,
  patch,
  fileDiff,
  annotations,
  previewMode,
}: {
  readonly file: ReviewFileChange;
  readonly isExpanded: boolean;
  readonly patch: string | undefined;
  readonly fileDiff: FileDiffMetadata | undefined;
  readonly annotations: DiffLineAnnotation<DiffRowMeta>[];
  readonly previewMode: boolean;
}): DiffItem {
  const loaded = patch !== undefined;
  const rows = [...annotations];

  if (isExpanded && previewMode && loaded) {
    return {
      type: "diff",
      id: file.path,
      collapsed: false,
      fileDiff: placeholderFileDiff(file),
      annotations: [
        { side: "additions", lineNumber: 0, metadata: { kind: "preview", patch } },
        ...rows,
      ],
    };
  }

  const status = statusOf(file, isExpanded, loaded, fileDiff);
  if (status) {
    rows.push({ side: "additions", lineNumber: 0, metadata: { kind: "status", status } });
  }

  return {
    type: "diff",
    id: file.path,
    collapsed: !isExpanded,
    fileDiff: fileDiff ?? placeholderFileDiff(file),
    annotations: rows,
  };
}

/** Change signature for one item; drives the CodeView `version` bump. */
function itemSignature(
  item: DiffItem,
  patch: string | undefined,
  noteById: ReadonlyMap<string, string>,
  editingAnnotationId: string | undefined,
): string {
  const rows =
    item.type !== "diff"
      ? ""
      : (item.annotations ?? [])
          .map((a) => {
            const meta = a.metadata;
            const note =
              meta?.kind === "saved" ? noteById.get(meta.annotationId) ?? "" : "";
            const editing = meta?.kind === "saved" && meta.annotationId === editingAnnotationId;
            return `${a.side}:${a.lineNumber}:${meta?.kind ?? ""}:${editing ? "E" : ""}:${note}`;
          })
          .join(";");
  return `${item.collapsed ? 1 : 0}|${patch ?? ""}|${rows}`;
}

/** Per-file terminal state shown inside an expanded item. */
function statusOf(
  file: ReviewFileChange,
  isExpanded: boolean,
  loaded: boolean,
  fileDiff: FileDiffMetadata | undefined,
): "loading" | "empty" | "binary" | undefined {
  if (!isExpanded) return undefined;
  if (!loaded) return "loading";
  if (file.binary) return "binary";
  return (fileDiff?.hunks.length ?? 0) === 0 ? "empty" : undefined;
}

function joinPaths(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return base.endsWith(sep) ? base + rel : base + sep + rel;
}

/** Props for the Review comparison diff surface. */
interface ReviewDiffViewProps {
  readonly files: ReviewFileChange[];
  readonly source: SelectedFile["source"];
  readonly id: string;
  readonly threadId: string;
  readonly cacheVersion?: string | number;
  readonly defaultFilesExpanded: boolean;
  /** File to expand and scroll to; cleared through onJumpSettled. */
  readonly jumpTarget: { readonly path: string; readonly token: number } | null;
  readonly onJumpSettled: (token: number) => void;
  /** Path currently showing the jump confirmation flash. */
  readonly highlightPath: string | null;
  readonly renderMode: "unified" | "side-by-side";
  readonly lineWrap: boolean;
}

/**
 * Whole-comparison diff surface backed by pierre's CodeView. Owns per-file
 * expand state, lazy patch loading, markdown preview, and comment rows; the
 * library owns virtualization, collapsed context bands, and highlighting.
 */
export function ReviewDiffView({
  files,
  source,
  id,
  threadId,
  cacheVersion = 0,
  defaultFilesExpanded,
  jumpTarget,
  onJumpSettled,
  highlightPath,
  renderMode,
  lineWrap,
}: ReviewDiffViewProps) {
  const handleRef = useRef<CodeViewHandle<DiffRowMeta, undefined>>(null);
  const bulkDiffExpand = useDiffStore((s) => s.bulkDiffExpand);
  const shikiTheme = useShikiTheme();


  const [patches, setPatches] = useState<Record<string, string>>(() => {
    const cache = useDiffStore.getState().inlineDiffCache;
    const seeded: Record<string, string> = {};
    for (const file of files) {
      const cached = cache[`${threadId}:${source}:${id}:${file.path}`];
      if (cached !== undefined) seeded[file.path] = cached;
    }
    return seeded;
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set((bulkDiffExpand?.expand ?? defaultFilesExpanded) ? files.map((f) => f.path) : []),
  );
  const [previewPaths, setPreviewPaths] = useState<ReadonlySet<string>>(new Set());
  const savedAnnotations =
    usePreviewAnnotationStore((s) => s.diffByThread[threadId]) ?? EMPTY_ANNOTATIONS;
  const editTarget = usePreviewAnnotationStore((s) => s.diffEditTargets[threadId]);

  const basePath = useWorkspaceStore((s) => {
    const thread = s.threads.find((t) => t.id === threadId);
    if (thread?.worktree_path) return thread.worktree_path;
    const ws = s.workspaces.find((w) => w.id === thread?.workspace_id);
    return ws?.path ?? null;
  });
  const workspaceId = useWorkspaceStore((s) => {
    const thread = s.threads.find((t) => t.id === threadId);
    return thread?.workspace_id ?? s.activeWorkspaceId ?? undefined;
  });
  const providerId = useWorkspaceStore(
    (s) => s.threads.find((t) => t.id === threadId)?.provider,
  );

  // Editing can start from the composer chip while the file sits collapsed;
  // derive the expanded set so the inline editor row actually mounts.
  const editingAnnotation =
    editTarget?.kind === "edit"
      ? savedAnnotations.find((a) => a.id === editTarget.annotationId)
      : undefined;
  const effectiveExpanded = useMemo(
    () =>
      editingAnnotation && !expanded.has(editingAnnotation.filePath)
        ? new Set(expanded).add(editingAnnotation.filePath)
        : expanded,
    [expanded, editingAnnotation],
  );

  const fileDiffs = useMemo(() => {
    const out: Record<string, FileDiffMetadata> = {};
    for (const [path, patch] of Object.entries(patches)) {
      const parsed = parsePatchFiles(patch).flatMap((p) => p.files);
      if (parsed.length > 0) {
        const fileDiff = parsed[0]!;
        fileDiff.cacheKey = `${threadId}:${source}:${id}:${cacheVersion}:${path}:${patch.length}`;
        out[path] = fileDiff;
      }
    }
    return out;
  }, [patches, id, source, threadId, cacheVersion]);

  // Lazy-load the patch for every expanded file missing one.
  useEffect(() => {
    const transport = getTransport();
    for (const file of files) {
      if (!effectiveExpanded.has(file.path) || patches[file.path] !== undefined) continue;
      const path = file.path;
      void loadFileDiff(transport, source, id, path, threadId)
        .then((result) => {
          setPatches((prev) => (prev[path] === undefined ? { ...prev, [path]: result } : prev));
          useDiffStore.getState().cacheInlineDiff(threadId, source, id, path, result);
        })
        .catch((error) => {
          console.warn("[ReviewDiffView] load failed", path, error);
          setPatches((prev) => (prev[path] === undefined ? { ...prev, [path]: "" } : prev));
        });
    }
  }, [effectiveExpanded, files, id, patches, source, threadId]);

  // Bulk expand/collapse arrives as a store command; subscriptions run outside
  // the render pass, unlike an effect watching the nonce.
  useEffect(() => {
    return useDiffStore.subscribe((state, prev) => {
      const command = state.bulkDiffExpand;
      if (!command || command === prev.bulkDiffExpand) return;
      setExpanded(new Set(command.expand ? files.map((f) => f.path) : []));
      if (!command.expand) setPreviewPaths(new Set());
    });
  }, [files]);

  // Jump expansion is adjusted during render so the scroll effect below runs
  // only after the target item has committed.
  const [appliedJumpToken, setAppliedJumpToken] = useState<number | null>(null);
  if (jumpTarget && appliedJumpToken !== jumpTarget.token) {
    setAppliedJumpToken(jumpTarget.token);
    if (!expanded.has(jumpTarget.path)) {
      setExpanded((prev) => new Set(prev).add(jumpTarget.path));
    }
  }
  useEffect(() => {
    if (!jumpTarget || appliedJumpToken !== jumpTarget.token) return;
    handleRef.current?.scrollTo({ type: "item", id: jumpTarget.path, align: "start", offset: -8 });
    onJumpSettled(jumpTarget.token);
  }, [appliedJumpToken, jumpTarget, onJumpSettled]);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        setPreviewPaths((p) => {
          const n = new Set(p);
          n.delete(path);
          return n;
        });
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const togglePreview = useCallback((path: string) => {
    setPreviewPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // CodeView diffs controlled items by id+version only: an unchanged version
  // keeps the stale record, so async patches and annotation edits would never
  // paint. Bump each item's version whenever its rendered inputs change.
  const itemVersions = useRef(new Map<string, { sig: string; version: number }>());
  const items = useMemo<DiffItem[]>(() => {
    const noteById = new Map(savedAnnotations.map((a) => [a.id, a.note] as const));
    const annotationsByFile = new Map<string, DiffLineAnnotation<DiffRowMeta>[]>();
    for (const annotation of savedAnnotations) {
      const list = annotationsByFile.get(annotation.filePath) ?? [];
      list.push({
        side: annotation.side === "left" ? "deletions" : "additions",
        lineNumber: annotation.line,
        metadata: { kind: "saved", annotationId: annotation.id },
      });
      annotationsByFile.set(annotation.filePath, list);
    }
    if (editTarget?.kind === "draft") {
      const list = annotationsByFile.get(editTarget.filePath) ?? [];
      list.push({
        side: editTarget.side === "left" ? "deletions" : "additions",
        lineNumber: editTarget.line,
        metadata: { kind: "draft" },
      });
      annotationsByFile.set(editTarget.filePath, list);
    }
    return files.map((file) => {
      const item = buildItem({
        file,
        isExpanded: effectiveExpanded.has(file.path),
        patch: patches[file.path],
        fileDiff: fileDiffs[file.path],
        annotations: annotationsByFile.get(file.path) ?? [],
        previewMode: previewPaths.has(file.path),
      });
      const sig = itemSignature(item, patches[file.path], noteById, editingAnnotation?.id);
      const prev = itemVersions.current.get(file.path);
      const version = prev?.sig === sig ? prev.version : (prev?.version ?? 0) + 1;
      itemVersions.current.set(file.path, { sig, version });
      return { ...item, version };
    });
  }, [files, effectiveExpanded, patches, fileDiffs, previewPaths, savedAnnotations, editTarget, editingAnnotation]);

  // Pierre merges loaded files into the diff metadata, so both sides must be
  // the exact contents the patch was generated against — mismatched contents
  // corrupt the hunk model and break rendering.
  const loadFileContents = useCallback(
    async (fileDiff: FileDiffMetadata) => {
      const ws = useWorkspaceStore.getState();
      const workspaceId = ws.activeWorkspaceId;
      if (!workspaceId) throw new Error("Cannot hydrate a diff without an active workspace");
      const transport = getTransport();
      // file.read/git.fileAtRef reject draft-thread ids, so only forward real threads.
      const realThreadId = ws.threads.some((t) => t.id === threadId) ? threadId : undefined;
      const at = async (ref: string, path: string): Promise<FileContents> => ({
        name: path,
        contents: await transport.readFileAtRef(workspaceId, ref, path, realThreadId),
      });
      const worktree = async (path: string): Promise<FileContents> => ({
        name: path,
        contents: await transport.readFileContent(workspaceId, path, realThreadId),
      });
      return resolveHydrationFiles(source, id, fileDiff, at, worktree);
    },
    [id, source, threadId],
  );

  const options = useMemo<CodeViewReactOptions<DiffRowMeta, undefined>>(
    () => ({
      theme: shikiTheme,
      themeType: shikiTheme === "github-dark" ? "dark" : "light",
      diffStyle: renderMode === "unified" ? "unified" : "split",
      overflow: lineWrap ? "wrap" : "scroll",
      lineDiffType: "word-alt",
      // Only git-backed sources can supply the exact old/new contents
      // hydration requires; snapshot diffs stay partial.
      ...(HYDRATABLE_SOURCES.has(source) ? { loadDiffFiles: loadFileContents } : {}),
      enableGutterUtility: true,
      // File separation is layout-owned: margins would corrupt the
      // virtualizer's height bookkeeping, so spacing goes through pierre.
      layout: { paddingTop: 10, paddingBottom: 10, gap: 16 },
      unsafeCSS: DIFF_UNSAFE_CSS,
    }),
    [lineWrap, loadFileContents, renderMode, shikiTheme, source],
  );

  const openDraft = useCallback(
    (filePath: string, hovered: { lineNumber: number; side: "deletions" | "additions" } | undefined) => {
      if (!hovered) return;
      const fileDiff = fileDiffs[filePath];
      const side = hovered.side === "deletions" ? "left" : "right";
      usePreviewAnnotationStore.getState().setDiffEditTarget(threadId, {
        kind: "draft",
        filePath,
        side,
        line: hovered.lineNumber,
        lineContent: fileDiff ? lineContentAt(fileDiff, side, hovered.lineNumber) : "",
      });
    },
    [fileDiffs, threadId],
  );

  const closeEditor = useCallback(() => {
    usePreviewAnnotationStore.getState().setDiffEditTarget(threadId, undefined);
  }, [threadId]);

  const renderCommentRow = (meta: Extract<DiffRowMeta, { kind: "draft" | "saved" }>) => {
    if (meta.kind === "draft") {
      if (!editTarget || editTarget.kind !== "draft") return null;
      return (
        <div className="mx-3 my-1.5 w-[calc(100%-1.5rem)]">
          <DiffCommentEditor
            threadId={threadId}
            target={{
              filePath: editTarget.filePath,
              side: editTarget.side,
              line: editTarget.line,
              lineContent: editTarget.lineContent,
            }}
            workspaceId={workspaceId}
            providerId={providerId}
            onClose={closeEditor}
          />
        </div>
      );
    }
    const saved = savedAnnotations.find((a) => a.id === meta.annotationId);
    if (!saved) return null;
    if (editingAnnotation?.id === saved.id) {
      return (
        <div className="mx-3 my-1.5 w-[calc(100%-1.5rem)]">
          <DiffCommentEditor
            threadId={threadId}
            target={{
              filePath: saved.filePath,
              side: saved.side,
              line: saved.line,
              lineContent: saved.lineContent,
            }}
            annotation={saved}
            workspaceId={workspaceId}
            providerId={providerId}
            onClose={closeEditor}
          />
        </div>
      );
    }
    return (
      <SavedAnnotationChip
        annotation={saved}
        onEdit={() =>
          usePreviewAnnotationStore.getState().setDiffEditTarget(threadId, {
            kind: "edit",
            annotationId: saved.id,
          })
        }
      />
    );
  };

  return (
    <CodeView
      ref={handleRef}
      items={items}
      options={options}
      className="min-h-0 flex-1 overflow-y-auto"
      renderHeaderPrefix={(item) => (
        <HeaderToggleButton
          itemId={item.id}
          expanded={!item.collapsed}
          highlighted={highlightPath === item.id}
          onToggle={() => toggleExpanded(item.id)}
        />
      )}
      renderHeaderMetadata={(item) => {
        if (item.collapsed) return null;
        const absolutePath = basePath ? joinPaths(basePath, item.id) : undefined;
        const absoluteDir =
          absolutePath?.slice(
            0,
            Math.max(absolutePath.lastIndexOf("/"), absolutePath.lastIndexOf("\\")) + 1,
          ) || undefined;
        return (
          <FileActionBar
            filePath={item.id}
            absolutePath={absolutePath}
            absoluteDir={absoluteDir}
            openAtLine={
              patches[item.id] !== undefined ? parseFirstHunkLine(patches[item.id]) : undefined
            }
            isMarkdown={isMarkdownFile(item.id)}
            previewMode={previewPaths.has(item.id)}
            onTogglePreview={() => togglePreview(item.id)}
          />
        );
      }}
      renderAnnotation={(annotation) => {
        const meta = annotation.metadata;
        if (!meta) return null;
        if (meta.kind === "preview") {
          return <DiffPreview lines={parseDiffLines(meta.patch)} />;
        }
        if (meta.kind === "status") {
          return <DiffStatusRow status={meta.status} />;
        }
        return renderCommentRow(meta);
      }}
      renderGutterUtility={(getHoveredLine, item) => (
        <button
          type="button"
          aria-label={`Add comment on line in ${item.id}`}
          className="relative z-10 flex h-5 w-5 items-center justify-center rounded-md bg-foreground text-background shadow-sm transition-colors hover:bg-foreground/90"
          // Pierre's line-number span overlaps the utility slot, so the button
          // must stack above it to be clickable; press events are stopped so a
          // click on "+" cannot start a line-range selection.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => openDraft(item.id, getHoveredLine() as { lineNumber: number; side: "deletions" | "additions" } | undefined)}
        >
          +
        </button>
      )}
    />
  );
}

interface HeaderToggleButtonProps {
  readonly itemId: string;
  readonly expanded: boolean;
  readonly highlighted: boolean;
  readonly onToggle: () => void;
}

/**
 * Collapse toggle rendered into pierre's header prefix slot. Carries the
 * jump-highlight marker so document CSS can flash the owning item host;
 * slotted nodes are light-DOM descendants of it.
 */
function HeaderToggleButton({ itemId, expanded, highlighted, onToggle }: HeaderToggleButtonProps) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={expanded ? `Collapse ${itemId}` : `Expand ${itemId}`}
      data-jump-highlight={highlighted ? "true" : undefined}
      onClick={onToggle}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded transition-colors",
        "hover:bg-foreground/[0.08]",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring/55",
      )}
    >
      <ChevronRight
        aria-hidden="true"
        size={14}
        className={cn(
          "text-muted-foreground/70 transition-transform duration-150",
          expanded && "rotate-90",
        )}
      />
    </button>
  );
}

/** Loading pulse and terminal per-file states. */
function DiffStatusRow({ status }: { readonly status: "loading" | "empty" | "binary" }) {
  if (status === "loading") {
    return (
      <div className="flex items-center justify-center gap-1.5 py-3">
        {[0, 150, 300].map((delay) => (
          <div
            key={delay}
            className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/40"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    );
  }
  return (
    <p className="px-3 py-2 font-mono text-[11px] text-muted-foreground/70">
      {status === "binary" ? "Binary file changed" : "No diff content"}
    </p>
  );
}

/** Saved comment chip; click to swap it for the inline editor. */
function SavedAnnotationChip({
  annotation,
  onEdit,
}: {
  readonly annotation: { readonly displayNumber: number; readonly note: string };
  readonly onEdit: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label={`Edit comment ${annotation.displayNumber}`}
      className="mx-3 my-1.5 flex w-[calc(100%-1.5rem)] items-start gap-2 rounded-lg bg-muted/45 px-3 py-2 text-left ring-1 ring-inset ring-border/60 transition-colors hover:bg-muted/60"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-foreground font-mono text-[10px] font-semibold tabular-nums text-background">
        {annotation.displayNumber}
      </span>
      <MessageCircle size={12} className="mt-1 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 whitespace-pre-wrap text-xs leading-5 text-foreground/85">
        {annotation.note}
      </span>
    </button>
  );
}

/**
 * Maps the app's diff tokens onto pierre's override variables. Applied inside
 * each shadow root, so values resolve against the document-level theme vars.
 */
// Maps our --diff-* tokens onto pierre's override vars. Custom properties
// inherit through the shadow boundary, so var(--diff-*) resolves to the theme.
const DIFF_UNSAFE_CSS = `
:host {
  --diffs-bg: var(--background);
  --diffs-bg-addition-override: var(--diff-add-bg);
  --diffs-bg-deletion-override: var(--diff-remove-bg);
  --diffs-bg-addition-emphasis-override: var(--diff-add-bg-hover);
  --diffs-bg-deletion-emphasis-override: var(--diff-remove-bg-hover);
  --diffs-addition-color-override: var(--diff-add-text);
  --diffs-deletion-color-override: var(--diff-remove-text);
  --diffs-font-family: var(--font-mono);
}
[data-diffs-header="default"] {
  border-bottom: 1px solid color-mix(in oklch, var(--border), transparent 70%);
}
`;
