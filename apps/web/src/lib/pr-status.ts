import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ThreadPullRequestState } from "@mcode/contracts/models/thread-pull-request";

/** Icon and Tailwind color class resolved from a PR state string. */
export interface PrStateVisual {
  Icon: LucideIcon;
  color: string;
}

/** Returns the icon and color for a PR state. */
export function getPrVisual(state: string | null | undefined): PrStateVisual {
  switch (state) {
    case "merged":
      return { Icon: GitMerge, color: "text-pr-merged" };
    case "closed":
      return { Icon: GitPullRequest, color: "text-destructive/70" };
    default:
      return { Icon: GitPullRequest, color: "text-muted/60" };
  }
}

/** Returns the PR state's icon and color; unresolved links inherit the surrounding color. */
export function getPullRequestStateVisual(state: ThreadPullRequestState): PrStateVisual {
  switch (state) {
    case "open":
      return { Icon: GitPullRequest, color: "text-success" };
    case "draft":
      return { Icon: GitPullRequestDraft, color: "text-muted" };
    case "merged":
      return { Icon: GitMerge, color: "text-pr-merged" };
    case "closed":
      return { Icon: GitPullRequestClosed, color: "text-error" };
    case "unresolved":
      return { Icon: GitPullRequest, color: "" };
  }
}
