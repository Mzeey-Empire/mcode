import { create } from "zustand";
import { PROJECT_ICON_RESOLVE_MAX_IDS, type ProjectIcon } from "@mcode/contracts/models/project-icon";
import { getTransport } from "@/transport";

/** Resolved project icons keyed by workspace id; a missing entry renders the monogram. */
interface ProjectIconState {
  iconsByWorkspaceId: Record<string, ProjectIcon>;
  /** Resolves icons for the given workspaces in server-sized batches. */
  resolve: (workspaceIds: readonly string[]) => Promise<void>;
  /** Applies an icon pushed by the server after any client changed it. */
  applyIcon: (icon: ProjectIcon) => void;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

/** Client cache of project icons, filled after the workspace list loads and kept fresh by pushes. */
export const useProjectIconStore = create<ProjectIconState>((set) => ({
  iconsByWorkspaceId: {},

  resolve: async (workspaceIds) => {
    const batches = chunks([...new Set(workspaceIds)], PROJECT_ICON_RESOLVE_MAX_IDS);
    const results = await Promise.all(batches.map((batch) => getTransport().resolveProjectIcons(batch)));
    set((state) => {
      const next = { ...state.iconsByWorkspaceId };
      for (const icon of results.flat()) next[icon.workspaceId] = icon;
      return { iconsByWorkspaceId: next };
    });
  },

  applyIcon: (icon) => {
    set((state) => ({ iconsByWorkspaceId: { ...state.iconsByWorkspaceId, [icon.workspaceId]: icon } }));
  },
}));
