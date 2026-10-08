/**
 * State for the notice shown at the top of a child fork thread when the
 * handoff was produced by the local deterministic path (path D) because the
 * provider was unavailable or the pipeline threw.
 *
 * Copy varies with the classified provider error so users understand what
 * happened and what, if anything, they should do. Suppressed when
 * `chat.handoff.notifyOnLocalFallback` is false.
 */

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { NoticeTone } from "@/components/ui/notice";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import type { HandoffMeta } from "@/stores/threadStore";
import { getTransport } from "@/transport";
import { MarkdownContent } from "./MarkdownContent";

/** Notice content for one handoff fallback cause. */
export interface HandoffFallbackCopy {
  tone: NoticeTone;
  title: string;
  detail: string;
}

/**
 * Picks copy for the classified provider error that caused the local fallback.
 * A null `providerErrorOnGenerate` means path D fired for a structural reason (no
 * session, provider doesn't support fork handoffs) rather than a runtime error.
 */
function handoffFallbackCopy(meta: HandoffMeta): HandoffFallbackCopy {
  switch (meta.providerErrorOnGenerate) {
    case "quota":
      return {
        tone: "warning",
        title: "Your previous provider was rate-limited.",
        detail: "Used the local builder for this handoff. Retry will be available later.",
      };
    case "auth":
      return {
        tone: "warning",
        title: "Your previous provider returned an auth error.",
        detail: "Used the local builder. Check your provider credentials in settings.",
      };
    case "context-overflow":
      return {
        tone: "warning",
        title: "Your previous thread is too large for a side-channel handoff.",
        detail: "Used the local builder, which summarizes within budget.",
      };
    case "transient":
      return {
        tone: "warning",
        title: "Couldn't reach your previous provider for the handoff.",
        detail: "Used the local builder. The next fork will retry the provider.",
      };
    case "fatal":
      return {
        tone: "warning",
        title: "Previous provider returned an unexpected error.",
        detail: "Used the local builder for this handoff.",
      };
    default:
      return {
        tone: "info",
        title: "Used the local builder for this handoff.",
        detail: "Your previous thread hadn't started a provider session, or that provider doesn't support fork handoffs.",
      };
  }
}

/**
 * Returns the fallback notice copy and its dismiss action, or null when the
 * thread's handoff is not a local fallback or the notification is turned off.
 */
export function useHandoffFallback(threadId: string): { copy: HandoffFallbackCopy; dismiss: () => void } | null {
  const enabled = useSettingsStore((s) => s.settings.chat?.handoff?.notifyOnLocalFallback ?? true);
  const meta = useThreadRecord(threadId, (r) => r.handoffMeta);
  const setHandoffStatus = useThreadStore((s) => s.setHandoffStatus);
  if (!enabled || meta?.status !== "fallback") return null;
  return { copy: handoffFallbackCopy(meta), dismiss: () => setHandoffStatus(threadId, "ready") };
}

/** Strips YAML frontmatter delimited by leading `---` lines from markdown. */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** The content rendered inside the handoff doc viewer dialog. */
function HandoffDocViewer({ threadId }: { threadId: string }) {
  const [state, setState] = useState<
    | { threadId: string; phase: "loading" }
    | { threadId: string; phase: "ready"; markdown: string; meta: NonNullable<Awaited<ReturnType<ReturnType<typeof getTransport>["readLatestHandoff"]>>>["meta"] }
    | { threadId: string; phase: "error"; message: string }
  >({ threadId, phase: "loading" });

  // Fetch on mount. The dialog mounts only when open=true.
  useEffect(() => {
    let cancelled = false;
    getTransport()
      .readLatestHandoff(threadId)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setState({ threadId, phase: "error", message: "No handoff document found for this thread." });
        } else {
          setState({ threadId, phase: "ready", markdown: result.markdown, meta: result.meta });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          threadId,
          phase: "error",
          message: err instanceof Error ? err.message : "Failed to load handoff document.",
        });
      });
    return () => { cancelled = true; };
  }, [threadId]);

  const viewState = state.threadId === threadId ? state : { threadId, phase: "loading" as const };

  if (viewState.phase === "loading") {
    return <p className="text-muted text-sm py-4">Loading...</p>;
  }
  if (viewState.phase === "error") {
    return <p className="text-destructive text-sm py-4">{viewState.message}</p>;
  }

  const { meta } = viewState;
  return (
    <div className="flex flex-col gap-3 overflow-hidden">
      {/* Metadata strip: key fields at a glance without wading into the doc body */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted border-b pb-3">
        <div><span className="font-mono">ladderStep:</span> {meta.ladderStep}</div>
        <div><span className="font-mono">mode:</span> {meta.mode}</div>
        <div><span className="font-mono">generatedBy:</span> {meta.generatedBy}</div>
        {meta.provider && <div><span className="font-mono">provider:</span> {meta.provider}</div>}
        <div><span className="font-mono">chars:</span> {meta.characterCount.toLocaleString()}</div>
        <div><span className="font-mono">when:</span> {new Date(meta.generatedAt).toLocaleString()}</div>
      </div>
      <div className="overflow-y-auto max-h-[65vh]">
        <MarkdownContent content={stripFrontmatter(viewState.markdown)} />
      </div>
    </div>
  );
}

/** Dialog that shows the latest handoff document for a fork thread. */
export function HandoffDocDialog({ threadId, open, onOpenChange }: { threadId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        <DialogTitle>Handoff document</DialogTitle>
        {open && <HandoffDocViewer threadId={threadId} />}
      </DialogContent>
    </Dialog>
  );
}
