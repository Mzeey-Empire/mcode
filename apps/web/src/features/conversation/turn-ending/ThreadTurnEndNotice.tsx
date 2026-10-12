import type { ReactElement } from "react";
import type { ProviderId } from "@mcode/contracts";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { signInToSignedOutProvider } from "@/features/providers/sign-in";
import { TurnEndNotice, type TurnEndActionHandlers } from "./TurnEndNotice";
import type { TurnEndNoticeView } from "./turn-ending-notice";
import { useTurnResume } from "./useTurnResume";
import { useTurnRetry } from "./useTurnRetry";

/** Props for {@link ThreadTurnEndNotice}. */
export interface ThreadTurnEndNoticeProps {
  threadId: string;
  /** Latest attempt's turn id, which Retry and Resume target. */
  turnId: string;
  /** The thread's provider, which Sign in targets; Sign in is hidden when it is null. */
  providerId: ProviderId | null;
  notice: TurnEndNoticeView;
}

/**
 * A thread's turn end notice with Retry, Retry at, Cancel retry, Switch model, Resume, and Sign in
 * wired to the server and the provider status store.
 */
export function ThreadTurnEndNotice({ threadId, turnId, providerId, notice }: ThreadTurnEndNoticeProps) {
  const { retry, retryAt, cancelRetry, ...retryRequest } = useTurnRetry(threadId, turnId);
  const resume = useTurnResume(threadId, turnId);
  const thread = useWorkspaceStore((store) => store.threads.find((candidate) => candidate.id === threadId));
  const primary = notice.style === "filled" ? notice.primary : undefined;
  const actions: TurnEndActionHandlers = {
    retry: () => retry(),
    retry_at: primary?.action === "retry_at" ? () => retryAt(primary.at) : undefined,
    cancel_retry: cancelRetry,
    resume: resume.resume,
    // A thread keeps its provider session, so the retry can only change model within it.
    switch_model: thread
      ? (trigger: ReactElement) => (
        <ModelSelector
          selectedModelId={thread.model ?? ""}
          selectedProviderId={thread.provider}
          onSelect={(modelId) => retry(modelId)}
          locked={false}
          providerLocked
          trigger={trigger}
        />
      )
      : undefined,
  };
  if (providerId) actions.sign_in = () => signInToSignedOutProvider(providerId);
  return (
    <TurnEndNotice
      notice={notice}
      actions={actions}
      pending={retryRequest.pending || resume.pending}
      error={retryRequest.error ?? resume.error}
    />
  );
}
