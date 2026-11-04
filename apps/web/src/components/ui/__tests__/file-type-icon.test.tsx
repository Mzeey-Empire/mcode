import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileCodeCorner } from "lucide-react";
import { FileTypeIcon } from "../file-type-icon";

vi.mock("@/lib/material-icons", () => ({
  resolveIcon: vi.fn(async (fileName: string) =>
    fileName.endsWith(".ts")
      ? { type: "image", url: "blob:typescript-icon" }
      : { type: "lucide", icon: FileCodeCorner },
  ),
}));

describe("FileTypeIcon", () => {
  it("renders the Material icon when the CDN answers", async () => {
    render(<FileTypeIcon filePath="apps/web/src/index.ts" />);

    await waitFor(() => {
      expect(screen.getByTestId("file-type-icon-image")).toHaveAttribute(
        "src",
        "blob:typescript-icon",
      );
    });
  });

  it("falls back to Lucide when the Material icon is unavailable", async () => {
    render(<FileTypeIcon filePath="README" />);

    await waitFor(() => {
      expect(screen.getByTestId("file-type-icon-lucide")).toBeInTheDocument();
    });
  });
});
