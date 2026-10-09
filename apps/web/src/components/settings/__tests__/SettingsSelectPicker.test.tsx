import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SettingsSelectPicker, type SettingsPickOption } from "../SettingsSelectPicker";

const OPTIONS: SettingsPickOption[] = [
  { value: "", label: "Auto" },
  { value: "code", label: "VS Code" },
  { value: "zed", label: "Zed", disabled: true, title: "Not installed" },
];

function Harness({ initial, onChange, options = OPTIONS }: { initial: string; onChange: (v: string) => void; options?: SettingsPickOption[] }) {
  const [value, setValue] = useState(initial);
  return (
    <SettingsSelectPicker
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
      options={options}
      searchPlaceholder="Search apps"
      data-testid="trigger"
    />
  );
}

async function open() {
  fireEvent.click(screen.getByTestId("trigger"));
  const search = await screen.findByRole("combobox", { name: "Search apps" });
  // Base UI moves focus to the first tabbable element a frame after opening.
  await waitFor(() => expect(search).toHaveFocus());
  return search;
}

describe("SettingsSelectPicker", () => {
  it("round-trips the empty-string value, so Auto stays a real choice", async () => {
    const onChange = vi.fn();
    render(<Harness initial="code" onChange={onChange} />);
    expect(screen.getByTestId("trigger")).toHaveTextContent("VS Code");

    await open();
    fireEvent.click(screen.getByRole("option", { name: "Auto" }));
    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.getByTestId("trigger")).toHaveTextContent("Auto");

    await open();
    expect(screen.getByRole("option", { name: "Auto" })).toHaveAttribute("aria-selected", "true");
  });

  it("picks the highlighted row with Enter from the search field", async () => {
    const onChange = vi.fn();
    render(<Harness initial="" onChange={onChange} />);
    const search = await open();
    fireEvent.change(search, { target: { value: "vs" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("code");
  });

  it("explains a disabled option and refuses to pick it", async () => {
    const onChange = vi.fn();
    render(<Harness initial="" onChange={onChange} />);
    await open();
    const zed = screen.getByRole("option", { name: "Zed" });
    expect(zed).toHaveAccessibleDescription("Not installed");
    fireEvent.click(zed);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("tags rows with their group only when the options span several groups", async () => {
    const grouped: SettingsPickOption[] = [
      { value: "a", label: "Alpha", group: "Claude" },
      { value: "b", label: "Beta", group: "Codex" },
    ];
    const { unmount } = render(<Harness initial="a" onChange={() => {}} options={grouped} />);
    await open();
    expect(screen.getByRole("option", { name: /Alpha/ })).toHaveTextContent("Claude");
    unmount();

    const single = grouped.map((option) => ({ ...option, group: "Claude" }));
    render(<Harness initial="a" onChange={() => {}} options={single} />);
    await open();
    expect(screen.getByRole("option", { name: "Alpha" })).not.toHaveTextContent("Claude");
  });
});
