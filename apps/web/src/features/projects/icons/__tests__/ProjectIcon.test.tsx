import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAttachmentTransportWsUrlCache, setAttachmentTransportWsUrl } from "@/lib/attachment-url";
import { ProjectIcon, projectHue, projectInitials, projectMonogram } from "../ProjectIcon";
import { useProjectIconStore } from "../projectIconStore";

const favicon = {
  workspaceId: "ws 1",
  source: "automatic",
  chosenMissing: false,
  path: "public/favicon.svg",
  version: "4739de4dbbd4c0e0",
  url: "/workspace-images/ws%201?path=public%2Ffavicon.svg&use=icon&v=4739de4dbbd4c0e0",
} as const;

beforeEach(() => {
  useProjectIconStore.setState({ iconsByWorkspaceId: {} });
  setAttachmentTransportWsUrl("ws://localhost:4321?token=secret-token");
});

afterEach(() => clearAttachmentTransportWsUrlCache());

describe("ProjectIcon", () => {
  it("loads the icon from the local server with the transport token", () => {
    useProjectIconStore.getState().applyIcon(favicon);
    const { container } = render(<ProjectIcon workspaceId="ws 1" name="mcode" size={16} />);
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "http://localhost:4321/workspace-images/ws%201?path=public%2Ffavicon.svg&use=icon&v=4739de4dbbd4c0e0&token=secret-token",
    );
    expect(image?.getAttribute("alt")).toBe("");
    expect(image?.style.width).toBe("16px");
  });

  it("falls back to the monogram when the image fails to load", () => {
    useProjectIconStore.getState().applyIcon(favicon);
    const { container } = render(<ProjectIcon workspaceId="ws 1" name="mcode" size={16} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("project-monogram").textContent).toBe("M");
  });

  it("shows the monogram when the project has no icon", () => {
    useProjectIconStore.getState().applyIcon({ workspaceId: "ws 1", source: "none", chosenMissing: false });
    const { container } = render(<ProjectIcon workspaceId="ws 1" name="élan" size={40} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("project-monogram").textContent).toBe("É");
  });
});

describe("tinted project badge", () => {
  it("shows two letters when the project has no image", () => {
    render(<ProjectIcon workspaceId="ws 1" name="orderwise-sync" size={16} tone="tinted" />);
    expect(screen.getByTestId("project-monogram").textContent).toBe("OS");
  });

  it("shows the project's image over the letters", () => {
    useProjectIconStore.getState().applyIcon(favicon);
    const { container } = render(<ProjectIcon workspaceId="ws 1" name="mcode" size={16} tone="tinted" />);
    expect(container.querySelector("img")).not.toBeNull();
    expect(screen.queryByTestId("project-monogram")).toBeNull();
  });

  it("keeps one hue per project id", () => {
    expect(projectHue("ws-1")).toBe(projectHue("ws-1"));
    expect(projectHue("ws-1")).not.toBe(projectHue("ws-2"));
  });
});

describe("projectInitials", () => {
  it.each([
    ["mcode", "Mc"],
    ["orderwise-sync", "OS"],
    ["vault tools", "VT"],
    ["x", "X"],
    ["", "?"],
  ])("reads %j as %j", (name, expected) => {
    expect(projectInitials(name)).toBe(expected);
  });
});

describe("projectMonogram", () => {
  it.each([
    ["mcode", "M"],
    ["élan", "É"],
    ["  spaced", "S"],
    ["👩‍💻 lab", "👩‍💻"],
    ["", "?"],
  ])("uses the first character of %j", (name, expected) => {
    expect(projectMonogram(name)).toBe(expected);
  });
});
