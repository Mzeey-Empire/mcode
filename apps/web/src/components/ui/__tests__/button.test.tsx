import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Plus } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "../button";
import { DropdownMenuItem } from "../dropdown-menu";
import { SplitButton } from "../split-button";

describe("Button loading", () => {
  it("blocks a second click while loading and stays focusable", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Button onClick={onClick}>Run agent</Button>);

    await user.click(screen.getByRole("button", { name: "Run agent" }));
    rerender(<Button onClick={onClick} loading>Run agent</Button>);
    const button = screen.getByRole("button", { name: "Run agent" });
    await user.click(button);
    await user.keyboard("{Enter}");

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).not.toBeDisabled();
  });

  it("swaps the leading icon for the spinner and keeps the label", () => {
    render(
      <Button loading>
        <Plus data-icon="inline-start" data-testid="leading-icon" />
        New thread
      </Button>,
    );

    expect(screen.getByTestId("leading-icon").parentElement).toHaveClass("opacity-0");
    expect(screen.getByText("New thread")).not.toHaveClass("opacity-0");
    expect(screen.getByRole("button", { name: "New thread" })).toBeInTheDocument();
  });

  it("keeps a fragment or label-component child in place as the accessible name", () => {
    function ActionLabel() {
      return <span>Create pull request</span>;
    }
    render(
      <>
        <Button loading>
          <>Open diff</>
        </Button>
        <Button loading>
          <ActionLabel />
        </Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Open diff" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create pull request" })).toBeInTheDocument();
  });
});

describe("IconButton", () => {
  it("drives aria-pressed from pressed so the round button takes its on fill", () => {
    render(<IconButton shape="round" aria-label="Wrap lines" pressed><Plus /></IconButton>);

    const button = screen.getByRole("button", { name: "Wrap lines" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveClass("rounded-full", "bg-selected", "aria-pressed:bg-control-border");
  });

  it("shows its name as a tooltip", async () => {
    const user = userEvent.setup();
    render(<IconButton aria-label="Refresh"><Plus /></IconButton>);

    await user.hover(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Refresh", { selector: "[data-slot='tooltip-content']" })).toBeInTheDocument();
  });
});

describe("SplitButton", () => {
  it("focuses the action, then the chevron, which opens the menu", async () => {
    const onAction = vi.fn();
    const onAlternate = vi.fn();
    const user = userEvent.setup();
    render(
      <SplitButton
        onClick={onAction}
        menuLabel="More commit options"
        menu={<DropdownMenuItem label="Commit and push" onClick={onAlternate} />}
      >
        Commit 3 files
      </SplitButton>,
    );

    await user.tab();
    expect(screen.getByRole("button", { name: "Commit 3 files" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledTimes(1);

    await user.tab();
    const chevron = screen.getByRole("button", { name: "More commit options" });
    expect(chevron).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Commit and push" }));

    expect(onAlternate).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
