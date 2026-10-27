import type { ProviderId } from "@mcode/contracts/providers/interfaces";
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

/** A thread's turn end notice with Retry, Resume, and Sign in wired to the server and the provider status store. */
export function ThreadTurnEndNotice({ threadId, turnId, providerId, notice }: ThreadTurnEndNoticeProps) {
  const retry = useTurnRetry(threadId, turnId);
  const resume = useTurnResume(threadId, turnId);
  // Resume takes an optional model, so the click event must not reach it.
  const actions: TurnEndActionHandlers = { retry: retry.retry, resume: () => resume.resume() };
  if (providerId) actions.sign_in = () => signInToSignedOutProvider(providerId);
  return (
    <TurnEndNotice
      notice={notice}
      actions={actions}
      pending={retry.pending || resume.pending}
      error={retry.error ?? resume.error}
    />
  );
}
