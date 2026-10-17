import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectIcon } from "@mcode/contracts";
import { createMockWorkspace, mockTransport } from "@/__tests__/mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
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

describe("GeneralSection name", () => {
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
