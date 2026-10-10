import type { Thread } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDefaultBranchTarget } from "./targets/useBranchTargets";

/**
 * The branch a composer target sends. The store holds only explicit picks; an empty pick follows the context's
 * default branch, read from the page one the target picker shares, so a HEAD change moves it until the user picks.
 */
export interface TargetBranch {
  readonly name: string;
  /** Why `name` is empty: the default is still loading, or there is none to follow. Null once `name` is set. */
  readonly unknown: "loading" | "missing" | null;
}

/** The parent thread fields a fork's branch comes from. */
export type ForkSourceThread = Pick<Thread, "id" | "workspace_id" | "branch" | "base_branch">;

interface DefaultBranchContext {
  readonly workspaceId: string;
  readonly threadId?: string;
}

function useIsGitWorkspace(workspaceId: string | undefined): boolean {
  return useWorkspaceStore((state) =>
    state.workspaces.find((workspace) => workspace.id === workspaceId)?.is_git_repo ?? false,
  );
}

function useEffectiveBranch(picked: string, context: DefaultBranchContext | null): TargetBranch {
  const fallback = useDefaultBranchTarget(picked === "" ? context : null);
  if (picked !== "") return { name: picked, unknown: null };
  if (fallback) return { name: fallback.name, unknown: null };
  return { name: "", unknown: fallback === undefined && context !== null ? "loading" : "missing" };
}

/**
 * A new thread's branch: the user's pick, else the project's checked-out branch, else its default branch. Pass no
 * workspace outside a new thread so nothing is fetched.
 */
export function useNewThreadTargetBranch(workspaceId: string | undefined): TargetBranch {
  const picked = useWorkspaceStore((state) => state.newThreadBranch);
  const isGitRepo = useIsGitWorkspace(workspaceId);
  return useEffectiveBranch(picked, workspaceId && isGitRepo ? { workspaceId } : null);
}

/**
 * A fork's branch: the user's pick, else the parent's branch, else the default of the checkout the parent runs in.
 * Pass no parent outside a fork so nothing is fetched.
 */
export function useForkTargetBranch(parent: ForkSourceThread | undefined): TargetBranch {
  const picked = useWorkspaceStore((state) => state.branchTargetBranch);
  const isGitRepo = useIsGitWorkspace(parent?.workspace_id);
  const name = picked || parent?.branch || parent?.base_branch || "";
  return useEffectiveBranch(
    name,
    parent && isGitRepo ? { workspaceId: parent.workspace_id, threadId: parent.id } : null,
  );
}
