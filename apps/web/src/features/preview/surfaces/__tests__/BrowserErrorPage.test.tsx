import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserCertificateFailure, PreviewPageError, WorkspaceEnvironmentActionRun } from "@mcode/contracts";

const transport = {
  listWorkspaceActionRuns: vi.fn(),
  startWorkspaceAction: vi.fn(),
  restartWorkspaceAction: vi.fn(),
};

vi.mock("@/transport", () => ({ getTransport: () => transport }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useTerminalStore } from "@/features/terminal";
import { useToastStore } from "@/stores/toastStore";
import { previewPageErrorForFailure } from "../../navigation/nav-errors";
import { BrowserErrorPage, type BrowserErrorPageProps } from "../BrowserErrorPage";
import type { BrowserCertificate } from "../useBrowserCertificate";

const THREAD_ID = "thread-1";
const WORKSPACE_ID = "workspace-1";

function actionRun(overrides: Partial<WorkspaceEnvironmentActionRun> = {}): WorkspaceEnvironmentActionRun {
  return {
    threadId: THREAD_ID,
    workspaceId: WORKSPACE_ID,
    actionId: "web",
    runId: "run-1",
    revision: 1,
    terminalSessionId: "pty-1",
    trigger: "manual",
    port: {
      runId: "run-1",
      port: 5173,
      host: "localhost",
      url: "http://localhost:5173/",
      reachable: false,
      detectedAt: "2026-08-22T12:00:02.000Z",
    },
    actionName: "web",
    status: "interrupted",
    snapshot: { platform: "linux", script: "bun run dev", checkoutPath: "/repo", terminal: null, environmentNames: [] },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: "2026-08-22T12:00:00.000Z",
    finishedAt: "2026-08-22T12:05:00.000Z",
    exitCode: null,
    ...overrides,
  };
}

function seedRuns(...runs: WorkspaceEnvironmentActionRun[]): void {
  for (const run of runs) useProjectActionStore.getState().applyRun(run);
  transport.listWorkspaceActionRuns.mockResolvedValue(Object.values(useProjectActionStore.getState().runsByThread[THREAD_ID] ?? {}));
}

const FAILURE: BrowserCertificateFailure = {
  host: "localhost",
  error: "net::ERR_CERT_AUTHORITY_INVALID",
  fingerprint: "sha256/AbCd",
  subjectName: "localhost",
  issuerName: "localhost",
  validStart: 1_700_000_000,
  validExpiry: 1_800_000_000,
};

function certificate(overrides: Partial<BrowserCertificate> = {}): BrowserCertificate {
  return {
    state: { failure: FAILURE, exceptionInUse: false },
    proceed: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderPage(error: PreviewPageError, url: string, overrides: Partial<BrowserErrorPageProps> = {}) {
  const props: BrowserErrorPageProps = {
    error,
    url,
    threadId: THREAD_ID,
    onRetry: vi.fn(),
    onOpen: vi.fn(),
    onBackToSafety: vi.fn(),
    certificate: certificate(),
    ...overrides,
  };
  render(<TooltipProvider><BrowserErrorPage {...props} /></TooltipProvider>);
  return props;
}

function refused(url: string): PreviewPageError {
  return previewPageErrorForFailure("ERR_CONNECTION_REFUSED", -102, url);
}

function untrusted(url: string): PreviewPageError {
  return previewPageErrorForFailure("ERR_CERT_AUTHORITY_INVALID", -202, url);
}

describe("BrowserErrorPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.listWorkspaceActionRuns.mockResolvedValue([]);
    useProjectActionStore.setState({
      runsByThread: {},
      configurationEpochByWorkspace: {},
      updateEpochByThread: {},
      updateEpochByThreadAction: {},
      hydrationByThread: {},
    });
    useTerminalStore.setState({ terminals: {}, activeTerminalByScope: {}, ptyToThread: {} });
    useWorkspaceStore.setState({
      threads: [{ id: THREAD_ID, workspace_id: WORKSPACE_ID } as never],
      workspaces: [{ id: WORKSPACE_ID, name: "mcode" } as never],
    });
    useToastStore.setState({ toasts: [] });
  });

  describe("connection refused", () => {
    it("offers Start for the project server that usually runs on the refused port", async () => {
      seedRuns(actionRun());
      renderPage(refused("http://localhost:5173/"), "http://localhost:5173/");

      expect(screen.getByTestId("preview-error-headline")).toHaveTextContent("Can't reach localhost:5173");
      expect(await screen.findByRole("button", { name: "Start web" })).toBeInTheDocument();
      expect(screen.getByTestId("preview-error-detail")).toHaveTextContent(
        "Nothing is listening on this port. web in mcode usually runs here.",
      );
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });

    it("offers only Retry for a port no action of this thread announced", async () => {
      seedRuns(actionRun());
      renderPage(refused("http://localhost:3000/"), "http://localhost:3000/");

      await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalled());
      expect(screen.getByTestId("preview-error-detail")).toHaveTextContent(/^Nothing is listening on this port\.$/);
      expect(screen.queryByRole("button", { name: /^Start/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });

    it("never offers Start for a remote host whose port matches an action", async () => {
      seedRuns(actionRun());
      renderPage(previewPageErrorForFailure("ERR_CONNECTION_REFUSED", -102, "https://example.com:5173/"), "https://example.com:5173/");

      expect(screen.queryByRole("button", { name: /^Start/ })).not.toBeInTheDocument();
      expect(transport.listWorkspaceActionRuns).not.toHaveBeenCalled();
    });

    it("restarts the action and opens the page once the new run reports a reachable port", async () => {
      seedRuns(actionRun());
      const { onOpen } = renderPage(refused("http://localhost:5173/"), "http://localhost:5173/");
      transport.restartWorkspaceAction.mockResolvedValue(actionRun({
        runId: "run-2",
        status: "running",
        createdAt: "2026-08-22T12:10:00.000Z",
        finishedAt: null,
        port: { ...actionRun().port!, runId: "run-1" },
      }));

      await userEvent.click(await screen.findByRole("button", { name: "Start web" }));

      expect(transport.restartWorkspaceAction).toHaveBeenCalledWith(THREAD_ID, "web");
      expect(onOpen).not.toHaveBeenCalled();

      act(() => seedRuns(actionRun({
        runId: "run-2",
        revision: 2,
        status: "running",
        createdAt: "2026-08-22T12:10:00.000Z",
        finishedAt: null,
        port: { ...actionRun().port!, runId: "run-2", reachable: true },
      })));

      await waitFor(() => expect(onOpen).toHaveBeenCalledWith("http://localhost:5173/"));
    });

    it("retries the failed page", async () => {
      const { onRetry } = renderPage(refused("http://localhost:3000/"), "http://localhost:3000/");

      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe("other failures", () => {
    it("names the host and offers Retry for a network failure", async () => {
      const { onRetry } = renderPage(
        previewPageErrorForFailure("ERR_NAME_NOT_RESOLVED", -105, "https://nope.invalid/"),
        "https://nope.invalid/",
      );

      expect(screen.getByTestId("preview-error-headline")).toHaveTextContent("Can't reach nope.invalid");
      expect(screen.getByTestId("preview-error-detail")).toHaveTextContent("Check the address or your connection.");
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("offers Reload for a crash", () => {
      renderPage(previewPageErrorForFailure("surface-lost", null, "http://localhost:5173/"), "http://localhost:5173/");

      expect(screen.getByTestId("preview-error-headline")).toHaveTextContent("This page crashed");
      expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    });

    it("keeps a blocked file blocked with no Retry", () => {
      renderPage(previewPageErrorForFailure("sensitive-file", null, null), "file:///repo/.env");

      expect(screen.getByTestId("preview-error-headline")).toHaveTextContent("This file can't be previewed");
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    });
  });

  describe("certificate", () => {
    it("warns in plain words without an error code and keeps Proceed behind Details", async () => {
      renderPage(untrusted("https://localhost:4443/"), "https://localhost:4443/");

      expect(screen.getByTestId("preview-error-headline")).toHaveTextContent("This connection isn't private");
      expect(screen.getByTestId("preview-error-detail")).toHaveTextContent(
        "The certificate for localhost isn't trusted: it's self-signed or from an unknown issuer.",
      );
      expect(screen.getByTestId("preview-error-panel")).not.toHaveTextContent("ERR_");
      expect(screen.queryByText(/Proceed to/)).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Details" }));

      expect(screen.getByTestId("browser-certificate-details")).toHaveTextContent("net::ERR_CERT_AUTHORITY_INVALID");
      expect(screen.getByTestId("browser-certificate-details")).toHaveTextContent("sha256/AbCd");
      expect(screen.getByRole("button", { name: "Proceed to localhost (unsafe)" })).toBeInTheDocument();
    });

    it("proceeds with the fingerprint the desktop recorded", async () => {
      const proceed = vi.fn().mockResolvedValue(undefined);
      renderPage(untrusted("https://localhost:4443/"), "https://localhost:4443/", { certificate: certificate({ proceed }) });

      await userEvent.click(screen.getByRole("button", { name: "Details" }));
      await userEvent.click(screen.getByRole("button", { name: "Proceed to localhost (unsafe)" }));

      expect(proceed).toHaveBeenCalledWith("sha256/AbCd");
    });

    it("offers no Proceed before the desktop has recorded a failure", async () => {
      renderPage(untrusted("https://localhost:4443/"), "https://localhost:4443/", {
        certificate: certificate({ state: null }),
      });

      await userEvent.click(screen.getByRole("button", { name: "Details" }));

      expect(screen.getByTestId("browser-certificate-details")).toHaveTextContent("ERR_CERT_AUTHORITY_INVALID");
      expect(screen.queryByText(/Proceed to/)).not.toBeInTheDocument();
    });

    it("goes back to safety", async () => {
      const { onBackToSafety } = renderPage(untrusted("https://localhost:4443/"), "https://localhost:4443/");

      await userEvent.click(screen.getByRole("button", { name: "Back to safety" }));

      expect(onBackToSafety).toHaveBeenCalledTimes(1);
    });
  });
});
