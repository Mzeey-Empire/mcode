import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PreviewAnnotationHeader } from "../PreviewAnnotationHeader";

const noop = () => undefined;

function renderHeader(control: Parameters<typeof PreviewAnnotationHeader>[0]["control"]) {
  return render(
    <TooltipProvider>
      <PreviewAnnotationHeader
        pageCount={0}
        bundleCount={0}
        pageLabel="Home"
        onDiscardPage={noop}
        onSend={noop}
        onExit={noop}
        control={control}
      />
    </TooltipProvider>,
  );
}

describe("PreviewAnnotationHeader control pill", () => {
  it("keeps Hand back reachable while designing", () => {
    const handBack = vi.fn();
    renderHeader({ kind: "user-holding", provider: "codex", handBack });

    fireEvent.click(screen.getByRole("button", { name: "Hand back" }));

    expect(handBack).toHaveBeenCalledOnce();
  });

  it("shows no pill when nobody holds the Browser", () => {
    renderHeader({ kind: "none" });

    expect(screen.queryByTestId("browser-control-pill")).not.toBeInTheDocument();
  });
});
