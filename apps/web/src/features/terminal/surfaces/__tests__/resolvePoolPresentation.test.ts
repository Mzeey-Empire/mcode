import { describe, expect, it } from "vitest";
import { resolvePoolPresentation } from "../resolvePoolPresentation";

describe("resolvePoolPresentation", () => {
  it("presents the home scope in the dialog, even over an open project terminal", () => {
    expect(
      resolvePoolPresentation({
        homePresented: true,
        activeThreadId: "thread-a",
        activeWorkspaceId: "workspace-a",
        panelTerminalTabVisible: true,
      }),
    ).toEqual({ scopeId: "home", surface: "dialog", visible: true });
  });

  it("presents the home scope in the dialog with no project open", () => {
    expect(
      resolvePoolPresentation({
        homePresented: true,
        activeThreadId: null,
        activeWorkspaceId: null,
        panelTerminalTabVisible: false,
      }),
    ).toEqual({ scopeId: "home", surface: "dialog", visible: true });
  });

  it("follows the active thread in the panel when home is not presented", () => {
    expect(
      resolvePoolPresentation({
        homePresented: false,
        activeThreadId: "thread-a",
        activeWorkspaceId: "workspace-a",
        panelTerminalTabVisible: true,
      }),
    ).toEqual({ scopeId: "thread-a", surface: "panel", visible: true });
  });

  it("falls back to the workspace scope and keeps the panel's hidden state", () => {
    expect(
      resolvePoolPresentation({
        homePresented: false,
        activeThreadId: null,
        activeWorkspaceId: "workspace-a",
        panelTerminalTabVisible: false,
      }),
    ).toEqual({ scopeId: "workspace-a", surface: "panel", visible: false });
  });

  it("presents nothing with no project and no home terminal", () => {
    expect(
      resolvePoolPresentation({
        homePresented: false,
        activeThreadId: null,
        activeWorkspaceId: null,
        panelTerminalTabVisible: false,
      }),
    ).toEqual({ scopeId: null, surface: "panel", visible: false });
  });
});
