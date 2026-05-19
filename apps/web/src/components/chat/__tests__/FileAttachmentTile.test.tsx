import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { FileAttachmentTile } from "../FileAttachmentTile";

describe("FileAttachmentTile", () => {
  it("renders filename and KB line for composer PDF attachments", () => {
    render(
      <FileAttachmentTile
        variant="composer"
        name="readme.pdf"
        sizeBytes={2048}
        mimeType="application/pdf"
      />,
    );
    expect(screen.getByText("readme.pdf")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
  });

  it("renders transcript variant sizing without crashing", () => {
    render(
      <FileAttachmentTile
        variant="transcript"
        name="notes.txt"
        sizeBytes={512}
        mimeType="text/plain"
      />,
    );
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("512 B")).toBeInTheDocument();
  });
});
