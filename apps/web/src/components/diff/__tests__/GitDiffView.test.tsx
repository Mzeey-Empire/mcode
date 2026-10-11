import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitDiffView } from "../GitDiffView";

vi.mock("../FileList", () => ({
  FileList: ({ files, source, id }: { files: { path: string }[]; source: string; id: string }) => (
    <div data-testid="file-list" data-source={source} data-id={id}>{files.map((file) => file.path).join(",")}</div>
  ),
}));

const resolved = {
  comparison: {
    files: [{ path: "selected.ts", previousPath: null, changeType: "modified" as const, binary: false, additions: null, deletions: null, untracked: false }],
    additions: 1,
    deletions: 0,
  },
  source: "commit" as const,
  id: "bbbbbbbb2",
  cacheVersion: 0,
};

describe("GitDiffView", () => {
  it("renders one settled comparison from its git source", () => {
    render(<GitDiffView {...resolved} threadId="thread-1" />);

    expect(screen.getByTestId("file-list")).toHaveTextContent("selected.ts");
    expect(screen.getByTestId("file-list")).toHaveAttribute("data-source", "commit");
    expect(screen.getByTestId("file-list")).toHaveAttribute("data-id", "bbbbbbbb2");
  });
});
