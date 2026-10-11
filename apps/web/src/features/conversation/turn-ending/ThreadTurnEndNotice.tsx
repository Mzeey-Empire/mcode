import type { ProviderId } from "@mcode/contracts";
import { signInToSignedOutProvider } from "@/features/providers/sign-in";
import { TurnEndNotice, type TurnEndActionHandlers } from "./TurnEndNotice";
import type { TurnEndNoticeView } from "./turn-ending-notice";
import { useTurnRetry } from "./useTurnRetry";

/** Props for {@link ThreadTurnEndNotice}. */
export interface ThreadTurnEndNoticeProps {
  threadId: string;
  /** Latest attempt's turn id, which Retry targets. */
  turnId: string;
  /** The thread's provider, which Sign in targets; Sign in is hidden when it is null. */
  providerId: ProviderId | null;
  notice: TurnEndNoticeView;
}

/** A thread's turn end notice with Retry and Sign in wired to the server and the provider status store. */
export function ThreadTurnEndNotice({ threadId, turnId, providerId, notice }: ThreadTurnEndNoticeProps) {
  const { retry, pending, error } = useTurnRetry(threadId, turnId);
  const actions: TurnEndActionHandlers = providerId
    ? { retry, sign_in: () => signInToSignedOutProvider(providerId) }
    : { retry };
  return <TurnEndNotice notice={notice} actions={actions} pending={pending} error={error} />;
}
