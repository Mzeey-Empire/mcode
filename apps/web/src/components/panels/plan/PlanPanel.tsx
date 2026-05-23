import { useCallback, useMemo, useState } from "react";
import { usePlanStore } from "@/stores/planStore";
import { PlanChrome } from "./PlanChrome";
import { PlanDocument, type PlanComment } from "./PlanDocument";
import { PlanSkeleton } from "./PlanSkeleton";
import type { PlanRecord } from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";

/** Stable empty array to avoid new-reference-per-render in Zustand selectors. */
const EMPTY_PLANS: readonly PlanRecord[] = [];

interface PlanPanelProps {
  threadId: string;
}

/**
 * Plan section of the Scope tab. Renders the plan document with
 * inline annotation support. Returns null when no plan exists.
 */
export function PlanPanel({ threadId }: PlanPanelProps) {
  const plans = usePlanStore((s) => s.plansByThread[threadId] ?? EMPTY_PLANS);
  const activeVersion = usePlanStore((s) => s.activeVersionByThread[threadId] ?? null);
  const isGenerating = usePlanStore((s) => s.generatingThreads.has(threadId));

  const [comments, setComments] = useState<PlanComment[]>([]);

  const activePlan = useMemo(() => {
    if (plans.length === 0) return null;
    if (activeVersion !== null) {
      return plans.find((p) => p.version === activeVersion) ?? plans[plans.length - 1];
    }
    return [...plans].reverse().find((p) => p.status !== "superseded") ?? plans[plans.length - 1];
  }, [plans, activeVersion]);

  const handleCommentChange = useCallback((sectionTitle: string, text: string) => {
    setComments((prev) => {
      const idx = prev.findIndex((c) => c.sectionTitle.toLowerCase() === sectionTitle.toLowerCase());
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { sectionTitle, text };
        return updated;
      }
      return [...prev, { sectionTitle, text }];
    });
  }, []);

  const handleCommentDiscard = useCallback((sectionTitle: string) => {
    setComments((prev) =>
      prev.filter((c) => c.sectionTitle.toLowerCase() !== sectionTitle.toLowerCase()),
    );
  }, []);

  const nonEmptyComments = useMemo(
    () => comments.filter((c) => c.text.trim().length > 0),
    [comments],
  );

  const handleSendFeedback = useCallback(async () => {
    if (nonEmptyComments.length === 0 || !activePlan) return;

    // Build a natural-language message from the annotations
    const lines = [
      `Plan feedback for "${activePlan.title}" (v${activePlan.version}):\n`,
      ...nonEmptyComments.map(
        (c) => `- **${c.sectionTitle}**: ${c.text}`,
      ),
      "\nPlease revise the plan based on this feedback.",
    ];

    try {
      await useThreadStore.getState().sendMessage(threadId, lines.join("\n"));
      setComments([]);
    } catch (err) {
      console.error("[plan] send feedback failed:", err);
    }
  }, [nonEmptyComments, activePlan, threadId]);

  const handleRevise = useCallback(() => {
    if (nonEmptyComments.length > 0) {
      void handleSendFeedback();
    } else {
      // Pre-fill composer - for now just focus it
      const composer = document.querySelector<HTMLTextAreaElement>("[data-composer-input]");
      if (composer) {
        composer.focus();
        composer.value = `Revise the plan "${activePlan?.title}": `;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }, [nonEmptyComments, handleSendFeedback, activePlan]);

  const handleImplement = useCallback(async () => {
    if (!activePlan) return;
    try {
      await useThreadStore.getState().sendMessage(
        threadId,
        `Implement the plan: "${activePlan.title}".\n\nThe full plan is in the conversation above. Follow it section by section.`,
      );
    } catch (err) {
      console.error("[plan] implement failed:", err);
    }
  }, [activePlan, threadId]);

  if (isGenerating) {
    return <PlanSkeleton title={activePlan?.title} />;
  }

  if (!activePlan) return null;

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* Chrome pinned at top - never scrolls */}
      <PlanChrome
        plan={activePlan}
        allVersions={plans}
        threadId={threadId}
        onRevise={handleRevise}
        onImplement={handleImplement}
        commentCount={nonEmptyComments.length}
      />

      {/* Scrollable plan body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <h1 className="px-6 pt-4 text-[17px] font-bold leading-[1.35]">
          {activePlan.title}
        </h1>
        <p className="px-6 mt-1.5 font-mono text-[10px] tracking-[0.06em] text-muted-foreground/60">
          Click any heading to leave feedback
        </p>
        <div className="mx-6 mt-3 h-px bg-border" />
        <PlanDocument
          plan={activePlan}
          comments={comments}
          onCommentChange={handleCommentChange}
          onCommentDiscard={handleCommentDiscard}
        />
      </div>

      {/* Send feedback bar - only visible when annotations exist */}
      {nonEmptyComments.length > 0 && (
        <div className="flex items-center border-t border-border bg-background px-4 py-2 flex-shrink-0">
          <span className="font-mono text-[10px] tabular-nums tracking-[0.06em] text-muted-foreground/50">
            {nonEmptyComments.length} {nonEmptyComments.length === 1 ? "comment" : "comments"}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={handleSendFeedback}
            className="font-mono text-[10px] uppercase tracking-[0.1em] text-primary/70 transition-colors hover:text-primary border border-border rounded px-3 py-1"
          >
            Send feedback
          </button>
        </div>
      )}
    </div>
  );
}
