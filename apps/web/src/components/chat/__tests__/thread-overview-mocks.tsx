import type { ReactNode } from "react";
import { vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import type { Thread } from "@/transport";
import type { ThreadRecord } from "@/stores/thread-record";

// vi.mock factories load this module, so it must not import any module the
// ThreadOverview tests mock; a cycle would hand the factory a half-built module.

/** Workspace store state read and written by the mocked `useWorkspaceStore`. */
export const mockWorkspaceState = {
  workspaces: [{ id: "ws-1", path: "/repo" }],
  threads: [] as Thread[],
  prUrlsByThreadId: {} as Record<string, string>,
  checksById: {} as Record<string, unknown>,
  worktreesLoadedForWorkspace: null as string | null,
};

/** Thread records served by the mocked `useThreadStore`. */
export const mockThreadRecords = new Map<string, ThreadRecord>();

/** Right panel visibility answered by the mocked `useDiffStore`. */
export const mockGetRightPanelVisible = vi.fn();

/** Replaces `openSubagentsPanel` from `@/features/subagents`. */
export const mockOpenSubagentsPanel = vi.fn();

/** `@/transport` with `getTransport` answering the shared {@link mockTransport}. */
export function mockTransportModule<T extends object>(actual: T) {
  return { ...actual, getTransport: () => mockTransport };
}

/** `@/features/projects/state/workspaceStore` backed by {@link mockWorkspaceState}. */
export function mockWorkspaceStoreModule() {
  const store = Object.assign(
    vi.fn((selector: (state: unknown) => unknown) => selector(mockWorkspaceState)),
    {
      setState: vi.fn((updater: unknown) => {
        const patch =
          typeof updater === "function"
            ? (updater as (state: typeof mockWorkspaceState) => Partial<typeof mockWorkspaceState>)(
                mockWorkspaceState,
              )
            : updater;
        Object.assign(mockWorkspaceState, patch);
      }),
      getState: vi.fn(() => mockWorkspaceState),
    },
  );
  return { useWorkspaceStore: store };
}

/** `@/stores/diffStore` whose selector reads {@link mockGetRightPanelVisible}. */
export function mockDiffStoreModule(actual: typeof import("@/stores/diffStore")) {
  const mockState = {
    snapshotsByThread: {},
    diffRevisionByScope: {},
    getRightPanelVisible: mockGetRightPanelVisible,
    getRightPanel: vi.fn().mockReturnValue({ width: 380 }),
    setSnapshots: vi.fn(),
  };
  const selector = vi.fn((select: (state: typeof mockState) => unknown) => select(mockState));
  Object.assign(selector, actual.useDiffStore);
  return {
    ...actual,
    useDiffStore: selector,
  };
}

/** `@/stores/threadStore` serving {@link mockThreadRecords}. */
export function mockThreadStoreModule() {
  return {
    useThreadStore: vi.fn((selector: (state: unknown) => unknown) =>
      selector({ records: mockThreadRecords, runningThreadIds: new Set<string>(), fetchProviderUsage: vi.fn() }),
    ),
  };
}

/** `@/features/subagents` with `openSubagentsPanel` replaced by {@link mockOpenSubagentsPanel}. */
export function mockSubagentsModule(actual: typeof import("@/features/subagents")) {
  return { ...actual, openSubagentsPanel: mockOpenSubagentsPanel };
}

/** `@/components/ui/dialog` rendered inline so dialog content is queryable. */
export function mockDialogModule() {
  return {
    Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  };
}

/** `./CreatePrDialog` reduced to its open state, branch, and preferred base. */
export function mockCreatePrDialogModule() {
  return {
    CreatePrDialog: ({
      open,
      branch,
      preferredBaseBranch,
    }: {
      open: boolean;
      branch: string;
      preferredBaseBranch?: string | null;
    }) =>
      open ? (
        <div data-testid="create-pr-dialog">
          <span data-testid="create-pr-branch">{branch}</span>
          <span data-testid="create-pr-base">{preferredBaseBranch}</span>
        </div>
      ) : null,
  };
}
