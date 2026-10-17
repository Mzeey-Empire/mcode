import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectIcon } from "@mcode/contracts";
import { createMockWorkspace, mockTransport } from "@/__tests__/mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useToastStore } from "@/stores/toastStore";
import { useProjectIconStore } from "@/features/projects/icons/projectIconStore";
import { GeneralSection } from "../GeneralSection";

const WORKSPACE_ID = "ws-1";

function iconState(icon: ProjectIcon) {
  useProjectIconStore.setState({ iconsByWorkspaceId: { [WORKSPACE_ID]: icon } });
}

const image = { workspaceId: WORKSPACE_ID, version: "v1", url: "/workspace-images/ws-1?path=x&use=icon&v=v1" } as const;

beforeEach(() => {
  useWorkspaceStore.setState({
    workspaces: [createMockWorkspace({ id: WORKSPACE_ID, name: "Caravan", path: "C:\\src\\caravan", icon_path: null })],
  });
  vi.mocked(mockTransport.setProjectIcon).mockReset();
  vi.mocked(mockTransport.renameWorkspace).mockReset();
  vi.mocked(mockTransport.resolveProjectIcons).mockReset().mockResolvedValue([]);
  useProjectIconStore.setState({ iconsByWorkspaceId: {} });
});

describe("GeneralSection icon row", () => {
  it.each<[string, ProjectIcon, string | null, string]>([
    ["a detected favicon", { ...image, source: "automatic", chosenMissing: false, path: "public/favicon.svg" }, null, "Automatic · public/favicon.svg"],
    ["no icon file", { workspaceId: WORKSPACE_ID, source: "none", chosenMissing: false }, null, "Automatic · no icon file found"],
    ["a chosen file", { ...image, source: "chosen", chosenMissing: false, path: "apps/desktop/build/icon.svg" }, "apps/desktop/build/icon.svg", "apps/desktop/build/icon.svg"],
    ["a chosen file that went missing", { workspaceId: WORKSPACE_ID, source: "none", chosenMissing: true }, "apps/x.svg", "apps/x.svg is missing · using automatic"],
  ])("says where the icon comes from for %s", (_label, icon, iconPath, line) => {
    useWorkspaceStore.setState({ workspaces: [createMockWorkspace({ id: WORKSPACE_ID, name: "Caravan", icon_path: iconPath })] });
    iconState(icon);
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);
    expect(screen.getByText("Icon").nextElementSibling?.textContent).toBe(line);
  });

  it("offers Use automatic only once a file is chosen, and saves null when it is used", async () => {
    const user = userEvent.setup();
    iconState({ workspaceId: WORKSPACE_ID, source: "none", chosenMissing: false });
    const { unmount } = render(<GeneralSection workspaceId={WORKSPACE_ID} />);
    expect(screen.queryByRole("button", { name: "Use automatic" })).toBeNull();
    unmount();

    iconState({ ...image, source: "chosen", chosenMissing: false, path: "brand.svg" });
    vi.mocked(mockTransport.setProjectIcon).mockResolvedValue({ workspaceId: WORKSPACE_ID, source: "none", chosenMissing: false });
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);
    await user.click(screen.getByRole("button", { name: "Use automatic" }));

    expect(mockTransport.setProjectIcon).toHaveBeenCalledWith(WORKSPACE_ID, null);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use automatic" })).toBeNull());
    expect(screen.getByText("Automatic · no icon file found")).toBeInTheDocument();
  });
});

describe("GeneralSection icon freshness and saving", () => {
  it("re-resolves the icon on open so a deleted chosen file shows as missing", async () => {
    useWorkspaceStore.setState({ workspaces: [createMockWorkspace({ id: WORKSPACE_ID, name: "Caravan", icon_path: "brand.svg" })] });
    iconState({ ...image, source: "chosen", chosenMissing: false, path: "brand.svg" });
    vi.mocked(mockTransport.resolveProjectIcons).mockResolvedValue([{ workspaceId: WORKSPACE_ID, source: "none", chosenMissing: true }]);
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText(/is missing · using automatic/)).toBeInTheDocument();
    expect(mockTransport.resolveProjectIcons).toHaveBeenCalledWith([WORKSPACE_ID]);
  });

  it("keeps the last choice when saves are made in quick succession", async () => {
    const user = userEvent.setup();
    iconState({ ...image, source: "chosen", chosenMissing: false, path: "brand.svg" });
    let resolveFirst: (icon: ProjectIcon) => void = () => {};
    const firstSave = new Promise<ProjectIcon>((resolve) => { resolveFirst = resolve; });
    const second: ProjectIcon = { workspaceId: WORKSPACE_ID, source: "none", chosenMissing: false };
    vi.mocked(mockTransport.setProjectIcon).mockReturnValueOnce(firstSave).mockResolvedValueOnce(second);
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);

    await user.click(screen.getByRole("button", { name: "Use automatic" }));
    await user.click(screen.getByRole("button", { name: "Use automatic" }));
    expect(mockTransport.setProjectIcon).toHaveBeenCalledTimes(1);

    resolveFirst({ ...image, source: "chosen", chosenMissing: false, path: "brand.svg" });
    await waitFor(() => expect(mockTransport.setProjectIcon).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Automatic · no icon file found")).toBeInTheDocument());
  });

  it("keeps saves in order across leaving and reopening General", async () => {
    const user = userEvent.setup();
    iconState({ ...image, source: "chosen", chosenMissing: false, path: "brand.svg" });
    let resolveFirst: (icon: ProjectIcon) => void = () => {};
    const firstSave = new Promise<ProjectIcon>((resolve) => { resolveFirst = resolve; });
    vi.mocked(mockTransport.setProjectIcon)
      .mockReturnValueOnce(firstSave)
      .mockResolvedValue({ workspaceId: WORKSPACE_ID, source: "none", chosenMissing: false });
    const { unmount } = render(<GeneralSection workspaceId={WORKSPACE_ID} />);
    await user.click(screen.getByRole("button", { name: "Use automatic" }));
    unmount();

    render(<GeneralSection workspaceId={WORKSPACE_ID} />);
    await user.click(screen.getByRole("button", { name: "Use automatic" }));
    expect(mockTransport.setProjectIcon).toHaveBeenCalledTimes(1);

    resolveFirst({ ...image, source: "chosen", chosenMissing: false, path: "brand.svg" });
    await waitFor(() => expect(mockTransport.setProjectIcon).toHaveBeenCalledTimes(2));
  });

  it("reports a failed icon save and keeps the icon as it was", async () => {
    const user = userEvent.setup();
    iconState({ ...image, source: "chosen", chosenMissing: false, path: "brand.svg" });
    vi.mocked(mockTransport.setProjectIcon).mockRejectedValue(new Error("disk full"));
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);

    await user.click(screen.getByRole("button", { name: "Use automatic" }));

    await waitFor(() => expect(useToastStore.getState().toasts.some((toast) => toast.title === "Icon could not be saved")).toBe(true));
    expect(screen.getByRole("button", { name: "Use automatic" })).toBeInTheDocument();
  });
});

describe("GeneralSection location", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "desktopBridge");
  });

  it("offers Open folder only in the desktop app", () => {
    const { unmount } = render(<GeneralSection workspaceId={WORKSPACE_ID} />);
    expect(screen.queryByRole("button", { name: "Open folder" })).toBeNull();
    unmount();

    Object.defineProperty(window, "desktopBridge", { value: {}, configurable: true, writable: true });
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);
    expect(screen.getByRole("button", { name: "Open folder" })).toBeInTheDocument();
  });
});

describe("GeneralSection name", () => {
  it("keeps what the user typed when a rename lands mid-edit", async () => {
    const user = userEvent.setup();
    let resolveRename: (workspace: ReturnType<typeof createMockWorkspace>) => void = () => {};
    vi.mocked(mockTransport.renameWorkspace).mockReturnValue(new Promise((resolve) => { resolveRename = resolve; }));
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);
    const field = screen.getByLabelText("Name");

    await user.clear(field);
    await user.type(field, "Wagon{Enter}");
    await user.type(field, "x");
    resolveRename(createMockWorkspace({ id: WORKSPACE_ID, name: "Wagon" }));
    await waitFor(() => expect(useWorkspaceStore.getState().workspaces[0]?.name).toBe("Wagon"));

    expect(screen.getByLabelText("Name")).toBe(field);
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Wagonx");
  });

  it("keeps newer typing when an earlier rename fails", async () => {
    const user = userEvent.setup();
    let rejectRename: (error: Error) => void = () => {};
    vi.mocked(mockTransport.renameWorkspace).mockReturnValue(new Promise((_, reject) => { rejectRename = reject; }));
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);
    const field = screen.getByLabelText("Name");

    await user.clear(field);
    await user.type(field, "Wagon{Enter}");
    await user.type(field, "x");
    rejectRename(new Error("name taken"));

    await waitFor(() => expect(useToastStore.getState().toasts.some((toast) => toast.title === "Project could not be renamed")).toBe(true));
    expect(screen.getByLabelText("Name")).toHaveValue("Wagonx");
  });

  it("drops the edit on Escape and does not rename on the blur that follows", async () => {
    const user = userEvent.setup();
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);
    const field = screen.getByLabelText("Name");

    await user.type(field, "zzz{Escape}");
    await user.tab();

    expect(screen.getByLabelText("Name")).toHaveValue("Caravan");
    expect(mockTransport.renameWorkspace).not.toHaveBeenCalled();
  });

  it("renames on Enter", async () => {
    const user = userEvent.setup();
    vi.mocked(mockTransport.renameWorkspace).mockResolvedValue(createMockWorkspace({ id: WORKSPACE_ID, name: "Wagon" }));
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);

    const field = screen.getByLabelText("Name");
    await user.clear(field);
    await user.type(field, "Wagon{Enter}");

    expect(mockTransport.renameWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, "Wagon");
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Wagon"));
  });

  it("returns to the folder name when the name is cleared", async () => {
    const user = userEvent.setup();
    vi.mocked(mockTransport.renameWorkspace).mockResolvedValue(createMockWorkspace({ id: WORKSPACE_ID, name: "caravan" }));
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);

    await user.clear(screen.getByLabelText("Name"));
    await user.tab();

    expect(mockTransport.renameWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, "caravan");
    expect(screen.getByLabelText("Name")).toHaveValue("caravan");
  });

  it("does not call the server when the name is unchanged", async () => {
    const user = userEvent.setup();
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);

    await user.click(screen.getByLabelText("Name"));
    await user.tab();

    expect(mockTransport.renameWorkspace).not.toHaveBeenCalled();
  });

  it("puts the old name back when the server refuses the rename", async () => {
    const user = userEvent.setup();
    vi.mocked(mockTransport.renameWorkspace).mockRejectedValue(new Error("name taken"));
    render(<GeneralSection workspaceId={WORKSPACE_ID} />);

    const field = screen.getByLabelText("Name");
    await user.clear(field);
    await user.type(field, "Wagon{Enter}");

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Caravan"));
  });
});
