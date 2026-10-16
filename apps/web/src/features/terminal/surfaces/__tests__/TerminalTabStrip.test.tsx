import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TerminalInstance } from "@/features/terminal/state/terminalStore";
import { TerminalTabStrip } from "../TerminalTabStrip";

vi.mock("@/lib/ensure-terminal", () => ({ createTerminalForScope: vi.fn() }));

function terminal(id: string, label: string): TerminalInstance {
  return { id, threadId: "thread-1", label, kind: "shell" };
}

describe("TerminalTabStrip", () => {
  it("shows each shell tab with its shell's icon", () => {
    const terminals = [terminal("a", "pwsh"), terminal("b", "/bin/zsh")];
    render(
      <TooltipProvider>
        <TerminalTabStrip
          scopeId="scope-1"
          terminals={terminals}
          activeId="a"
          labels={new Map()}
          actionRuns={{}}
          onClose={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.getAllByTestId("action-icon").map((icon) => icon.getAttribute("data-icon-id"))).toEqual([
      "powershell",
      "shell",
    ]);
  });
});
