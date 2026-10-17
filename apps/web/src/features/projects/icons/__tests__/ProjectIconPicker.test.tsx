import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

import { ProjectIconPicker } from "../ProjectIconPicker";

const FILES = ["apps/desktop/build/icon.svg", "apps/web/public/favicon.ico"];

async function openPicker(user: ReturnType<typeof userEvent.setup>, onPick = vi.fn(), chosenPath: string | null = null) {
  render(<ProjectIconPicker workspaceId="ws-1" chosenPath={chosenPath} onPick={onPick} />);
  await user.click(screen.getByRole("button", { name: "Choose file" }));
  return onPick;
}

beforeEach(() => {
  vi.mocked(mockTransport.listProjectIconCandidates).mockReset();
  vi.mocked(mockTransport.listProjectIconCandidates).mockResolvedValue({ files: FILES, total: 7 });
});

describe("ProjectIconPicker", () => {
  it("lists image files with their folder and how many exist", async () => {
    await openPicker(userEvent.setup());

    expect(await screen.findByRole("option", { name: /icon\.svg/ })).toHaveTextContent("apps/desktop/build");
    expect(screen.getByRole("option", { name: /favicon\.ico/ })).toHaveTextContent("apps/web/public");
    expect(screen.getByText("Showing 2 of 7")).toBeInTheDocument();
    expect(mockTransport.listProjectIconCandidates).toHaveBeenCalledWith("ws-1", "");
  });

  it("asks the server for matches as the user types", async () => {
    const user = userEvent.setup();
    await openPicker(user);
    await screen.findByRole("option", { name: /icon\.svg/ });
    vi.mocked(mockTransport.listProjectIconCandidates).mockResolvedValue({ files: ["apps/web/public/favicon.ico"], total: 1 });

    await user.type(screen.getByRole("combobox", { name: "Search image files" }), "fav");

    await waitFor(() => expect(mockTransport.listProjectIconCandidates).toHaveBeenLastCalledWith("ws-1", "fav"));
    await waitFor(() => expect(screen.queryByRole("option", { name: /icon\.svg/ })).toBeNull());
    expect(screen.getByText("Showing 1 of 1")).toBeInTheDocument();
  });

  it("saves the highlighted file on Enter and closes", async () => {
    const user = userEvent.setup();
    const onPick = await openPicker(user);
    await screen.findByRole("option", { name: /icon\.svg/ });

    await user.keyboard("{ArrowDown}{Enter}");

    expect(onPick).toHaveBeenCalledWith("apps/web/public/favicon.ico");
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });

  it("saves the clicked file", async () => {
    const user = userEvent.setup();
    const onPick = await openPicker(user);

    await user.click(await screen.findByRole("option", { name: /icon\.svg/ }));

    expect(onPick).toHaveBeenCalledWith("apps/desktop/build/icon.svg");
  });

  it("marks the chosen file", async () => {
    await openPicker(userEvent.setup(), vi.fn(), "apps/desktop/build/icon.svg");

    expect(await screen.findByRole("option", { name: /icon\.svg/ })).toHaveAttribute("aria-selected", "true");
  });

  it("offers Retry when the files cannot be listed", async () => {
    const user = userEvent.setup();
    vi.mocked(mockTransport.listProjectIconCandidates).mockRejectedValueOnce(new Error("offline"));
    await openPicker(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("option", { name: /icon\.svg/ })).toBeInTheDocument();
  });
});
