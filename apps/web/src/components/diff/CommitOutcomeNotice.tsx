import type { GitCommitRejection } from "@mcode/contracts";
import { Notice, type NoticeProps } from "@/components/ui/notice";
import type { CommitSubmission } from "@/hooks/useCommitSheet";

type Outcome = Pick<NoticeProps, "tone" | "title" | "detail">;

function output(text: string) {
  return <pre className="font-mono text-caption whitespace-pre-wrap">{text}</pre>;
}

function describeRejection(reason: GitCommitRejection): Outcome {
  switch (reason.kind) {
    case "nothing-to-commit":
      return { tone: "warning", title: "Nothing to commit", detail: "The checked files have no changes." };
    case "head-moved":
      return {
        tone: "warning",
        title: "The branch moved since this list was built",
        detail: `HEAD is now ${reason.head ?? "unborn"}. Check the refreshed list, then commit again.`,
      };
    case "no-branch":
      return { tone: "warning", title: "Create a branch to push", detail: "This checkout has no branch to push." };
    case "identity-missing":
      return { tone: "error", title: "Git has no author identity", detail: output(reason.detail) };
    case "conflicts":
      return { tone: "error", title: "Resolve the conflicts first", detail: output(reason.detail) };
    case "index-locked":
      return { tone: "error", title: "Another git process is running", detail: output(reason.detail) };
    case "failed":
      return { tone: "error", title: reason.summary, detail: output(reason.detail) };
  }
}

function describeSubmission(submission: CommitSubmission): Outcome | null {
  switch (submission.kind) {
    case "rejected":
      return describeRejection(submission.reason);
    case "unknown":
      return {
        tone: "warning",
        title: "Couldn't confirm the commit",
        detail: output(`HEAD is ${submission.head ?? "unborn"}.\n\n${submission.detail}`),
      };
    case "push-failed":
      return {
        tone: "warning",
        title: `Committed ${submission.shortSha}, but the push failed`,
        detail: output(`${submission.summary}\n\n${submission.detail}`),
      };
    default:
      return null;
  }
}

/** Props for {@link CommitOutcomeNotice}. */
export interface CommitOutcomeNoticeProps {
  readonly submission: CommitSubmission;
  /** Resend the interrupted request now instead of waiting for the connection. */
  readonly onRetry: () => void;
}

/** What the last commit request did when it did not simply succeed, with git's output behind Details. */
export function CommitOutcomeNotice({ submission, onRetry }: CommitOutcomeNoticeProps) {
  if (submission.kind === "interrupted") {
    return (
      <Notice
        tone="info"
        busy
        title="Connection lost. Resending when it's back"
        action={{ label: "Retry now", onClick: onRetry, emphasis: "neutral" }}
      />
    );
  }
  const outcome = describeSubmission(submission);
  return outcome ? <Notice {...outcome} collapsible /> : null;
}
