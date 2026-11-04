import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MentionedText } from "../MentionedText";
import type { Message } from "@/transport";
import { getFilesScope, useFilesTabsStore } from "@/features/files/filesTabsStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";

const TID = "thread-1";
const FILE_PATH = "src/lib/path.ts";
const TEXT = `check @${FILE_PATH} with /architect`;

const mentions: NonNullable<Message["mentions"]> = [
  { id: `file:${FILE_PATH}`, kind: "file", label: FILE_PATH, path: FILE_PATH, range: { start: 6, end: TEXT.indexOf(" with") } },
  { id: "command:skill:architect", kind: "command", label: "architect", namespace: "skill", range: { start: TEXT.indexOf("/architect"), end: TEXT.length } },
];

function renderMentions(): void {
  render(<p><MentionedText text={TEXT} mentions={mentions} /></p>);
}

describe("MentionedText file tokens", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-1", activeThreadId: TID, threads: [] });
    useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {} });
    useUiStore.setState({ primarySurface: "chat" });
    useFilesTabsStore.setState({ scopes: {} });
  });

  it("opens the file in Files when clicked", () => {
    renderMentions();
    fireEvent.click(screen.getByRole("link", { name: /path\.ts/ }));
    expect(getFilesScope(TID).activePath).toBe(FILE_PATH);
    expect(useDiffStore.getState().getRightPanel("ws-1", TID).activeTab).toBe("files");
  });

  it("opens the file in Files when Enter is pressed", () => {
    renderMentions();
    fireEvent.keyDown(screen.getByRole("link", { name: /path\.ts/ }), { key: "Enter" });
    expect(getFilesScope(TID).activePath).toBe(FILE_PATH);
  });

  it("leaves skill tokens as plain text, not links", () => {
    renderMentions();
    const skillToken = document.querySelector('[data-entity-token="skill"]');
    expect(skillToken).not.toBeNull();
    expect(skillToken?.getAttribute("role")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
