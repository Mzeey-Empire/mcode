import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Setting } from "../Setting";
import { settingsPage } from "../setting-def";

function Value() {
  return <span>control</span>;
}

const FIXTURE = settingsPage("general", {
  plain: { label: "Plain", hint: "Plain hint.", Control: Value },
  absent: { label: "Absent", exists: () => false, Control: Value },
  offNow: {
    label: "Off now",
    hint: "Off hint.",
    when: { useApplies: () => false, reason: "Only for other choices.", anchor: "general.plain" },
    Control: Value,
  },
});

describe("Setting", () => {
  it("draws the label, hint and control on its page", () => {
    render(<Setting def={FIXTURE.plain} />);
    expect(screen.getByText("Plain")).toBeInTheDocument();
    expect(screen.getByText("Plain hint.")).toBeInTheDocument();
    expect(screen.getByText("control")).toBeInTheDocument();
  });

  it("hides the hint for another match but keeps the control", () => {
    render(<Setting def={FIXTURE.plain} variant="match" />);
    expect(screen.queryByText("Plain hint.")).toBeNull();
    expect(screen.getByText("control")).toBeInTheDocument();
  });

  it("draws nothing for a setting the platform lacks", () => {
    const { container } = render(<Setting def={FIXTURE.absent} variant="best" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("hides a row that does not apply on its page but explains it in search", () => {
    const { container, rerender } = render(<Setting def={FIXTURE.offNow} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<Setting def={FIXTURE.offNow} variant="best" />);
    expect(screen.getByText("Only for other choices.")).toBeInTheDocument();
    expect(screen.queryByText("control")).toBeNull();
  });
});
