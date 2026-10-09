import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SegmentedControl } from "@/components/ui/segmented-control";

const opts = [
  { value: "a", label: "Option A" },
  { value: "b", label: "Option B" },
  { value: "c", label: "Option C", disabled: true },
];

describe("SegmentedControl", () => {
  it("calls onChange with the clicked value", () => {
    const fn = vi.fn();
    render(<SegmentedControl options={opts} value="a" onChange={fn} />);
    fireEvent.click(screen.getByRole("radio", { name: "Option B" }));
    expect(fn).toHaveBeenCalledWith("b");
  });

  it("does not call onChange for disabled options", () => {
    const fn = vi.fn();
    render(<SegmentedControl options={opts} value="a" onChange={fn} />);
    fireEvent.click(screen.getByRole("radio", { name: "Option C" }));
    expect(fn).not.toHaveBeenCalled();
  });

  it("checks only the active option and gives it the single tab stop", () => {
    render(<SegmentedControl options={opts} value="b" onChange={() => {}} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("keeps the group reachable by Tab when the value matches no option", () => {
    render(<SegmentedControl options={opts} value="missing" onChange={() => {}} />);
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it("keeps the group reachable by Tab when the chosen option is disabled", () => {
    render(<SegmentedControl options={opts} value="c" onChange={() => {}} />);
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves from the focused segment when the chosen option is disabled", () => {
    const fn = vi.fn();
    render(<SegmentedControl options={opts} value="c" onChange={fn} />);
    screen.getByRole("radio", { name: "Option A" }).focus();
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(fn).toHaveBeenLastCalledWith("b");
  });

  it("moves the choice with arrow keys, skipping disabled options and wrapping", () => {
    const fn = vi.fn();
    render(<SegmentedControl options={opts} value="b" onChange={fn} />);
    const group = screen.getByRole("radiogroup");
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(fn).toHaveBeenLastCalledWith("a");
    expect(screen.getByRole("radio", { name: "Option A" })).toHaveFocus();
    // `value` is still "b" because the owner hasn't applied the first move; moving back must still report it.
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(fn).toHaveBeenLastCalledWith("b");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not report a move that lands where it started", () => {
    const fn = vi.fn();
    const onlyA = [
      { value: "a", label: "Option A" },
      { value: "c", label: "Option C", disabled: true },
    ];
    render(<SegmentedControl options={onlyA} value="a" onChange={fn} />);
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("jumps to the last enabled option on End", () => {
    const fn = vi.fn();
    render(<SegmentedControl options={opts} value="a" onChange={fn} />);
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "End" });
    expect(fn).toHaveBeenCalledWith("b");
  });
});
