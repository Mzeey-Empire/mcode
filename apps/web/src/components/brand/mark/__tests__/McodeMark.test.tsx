import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { McodeMark } from "../McodeMark";

describe("McodeMark", () => {
  it("is named Mcode", () => {
    render(<McodeMark state="quiet" />);
    expect(screen.getByRole("img", { name: "Mcode" })).toBeInTheDocument();
  });

  it("names the state it shows", () => {
    const { rerender } = render(<McodeMark state="running" />);
    expect(screen.getByRole("img", { name: "Mcode, running" })).toBeInTheDocument();
    rerender(<McodeMark state="finished" />);
    expect(screen.getByRole("img", { name: "Mcode, finished" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Mcode, running" })).not.toBeInTheDocument();
  });

  it("replaces the svg when the state changes, so a one-shot restarts", () => {
    const { rerender } = render(<McodeMark state="running" />);
    const before = screen.getByRole("img", { name: "Mcode, running" });
    rerender(<McodeMark state="finished" />);
    const after = screen.getByRole("img", { name: "Mcode, finished" });
    expect(after).not.toBe(before);
    expect(after.getAttribute("data-state")).toBe("finished");
  });

  it("keeps the same svg when re-rendered in the same state", () => {
    const { rerender } = render(<McodeMark state="running" className="a" />);
    const before = screen.getByRole("img", { name: "Mcode, running" });
    rerender(<McodeMark state="running" className="b" />);
    expect(screen.getByRole("img", { name: "Mcode, running" })).toBe(before);
  });
});
