import { DiffCommentEditor } from "@/components/diff/DiffCommentEditor";
import {
  usePreviewAnnotationStore,
  type DiffAnnotationInput,
  type DiffEditTarget,
  type SavedDiffAnnotation,
} from "@/features/preview/state/previewAnnotationStore";

/** Props for the composer-docked diff comment editor. */
export interface DiffCommentEditorAttachmentProps {
  /** Scope that owns the annotations: the thread id, or the workspace for drafts. */
  readonly scopeId: string;
  /** Owning thread; diff comments only exist for thread-bound scopes. */
  readonly threadId?: string;
  /** Workspace that scopes mention and slash suggestions. */
  readonly workspaceId: string;
  /** Provider that scopes mention and slash suggestions. */
  readonly providerId?: string;
}

/** Resolves an edit target into the line target and saved annotation the editor needs. */
function resolveEditTarget(
  target: DiffEditTarget,
  annotations: readonly SavedDiffAnnotation[],
): { editorTarget: Omit<DiffAnnotationInput, "note">; annotation?: SavedDiffAnnotation } | null {
  if (target.kind === "draft") {
    return {
      editorTarget: {
        filePath: target.filePath,
        side: target.side,
        line: target.line,
        lineContent: target.lineContent,
      },
    };
  }
  const annotation = annotations.find((a) => a.id === target.annotationId);
  if (!annotation) return null;
  return {
    editorTarget: {
      filePath: annotation.filePath,
      side: annotation.side,
      line: annotation.line,
      lineContent: annotation.lineContent,
    },
    annotation,
  };
}

/**
 * Renders the active diff comment draft or edit target as an editor card in
 * the composer attachment column, keeping comment composition in one place.
 * The diff itself shows a slim anchor marker at the target line instead.
 */
export function DiffCommentEditorAttachment({
  scopeId,
  threadId,
  workspaceId,
  providerId,
}: DiffCommentEditorAttachmentProps) {
  const target = usePreviewAnnotationStore((s) => s.diffEditTargets[scopeId]);
  const annotations = usePreviewAnnotationStore((s) => s.diffByThread[scopeId]);
  const resolved = target ? resolveEditTarget(target, annotations ?? []) : null;
  if (!resolved || !threadId) return null;

  return (
    <div className="px-3 pt-2">
      <DiffCommentEditor
        threadId={threadId}
        target={resolved.editorTarget}
        annotation={resolved.annotation}
        workspaceId={workspaceId}
        providerId={providerId}
        onClose={() =>
          usePreviewAnnotationStore.getState().setDiffEditTarget(scopeId, undefined)
        }
      />
    </div>
  );
}
