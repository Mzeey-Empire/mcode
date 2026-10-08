import { createContext, useContext, type ReactNode } from "react";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

const SubagentProviderContext = createContext<string | undefined>(undefined);

/**
 * Supplies the provider that subagents under `threadId` show. Subagent threads
 * are provider-native, so they share their parent thread's provider. Canonical
 * child threads are not workspace threads, so a child transcript inherits the
 * provider from the enclosing scope.
 */
export function SubagentProviderScope({
  threadId,
  children,
}: {
  readonly threadId: string | null | undefined;
  readonly children: ReactNode;
}) {
  const inherited = useContext(SubagentProviderContext);
  const own = useWorkspaceStore((state) => (
    threadId ? state.threads.find((thread) => thread.id === threadId)?.provider : undefined
  ));
  return (
    <SubagentProviderContext.Provider value={own ?? inherited}>
      {children}
    </SubagentProviderContext.Provider>
  );
}

/** Provider id for subagents in the current scope, or an empty string when unknown. */
export function useSubagentProvider(): string {
  return useContext(SubagentProviderContext) ?? "";
}
