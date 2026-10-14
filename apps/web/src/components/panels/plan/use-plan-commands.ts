import { useEffect } from "react";
import type { PlanVersion } from "@mcode/contracts";
import { registerCommand } from "@/lib/command-registry";
import { setContext } from "@/lib/context-tracker";
import { usePlanStore } from "@/stores/planStore";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { implementPlan, selectImplementTarget, usePlanImplementStore } from "./plan-implement";

const EMPTY_PLANS: readonly PlanVersion[] = [];

/**
 * Registers the palette's Implement commands for the active thread and sets the
 * `planImplementable` keybinding context. Both exist only while the target
 * version is implementable, so the shortcut does nothing on history. Mounted
 * at the app level because the shortcut must work from the composer with the
 * Plan panel closed.
 */
export function usePlanCommands(threadId: string | null): void {
  const versions = usePlanStore((s) => (threadId ? (s.plansByThread[threadId] ?? EMPTY_PLANS) : EMPTY_PLANS));
  const activeVersion = usePlanStore((s) => (threadId ? (s.activeVersionByThread[threadId] ?? null) : null));
  const onScreen = usePlanImplementStore((s) => threadId !== null && s.panelsOnScreen[threadId] === true);
  const executing = useThreadStore((s) => threadId !== null && isThreadExecuting(threadId, s));
  const version = threadId && !executing ? (selectImplementTarget(versions, activeVersion, onScreen)?.version ?? null) : null;

  useEffect(() => {
    if (threadId === null || version === null) return;
    setContext("planImplementable", true);
    const dispose = registerCommand({
      id: "plan.implement",
      title: `Implement v${version}`,
      category: "Plan",
      handler: () => void implementPlan(threadId),
    });
    const disposeNewThread = registerCommand({
      id: "plan.implementInNewThread",
      title: `Implement v${version} in a new thread`,
      category: "Plan",
      handler: () => void implementPlan(threadId, "new-thread"),
    });
    return () => {
      dispose();
      disposeNewThread();
      setContext("planImplementable", false);
    };
  }, [threadId, version]);
}
