import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RadioGroup, RadioGroupItem } from "../radio-group";

const SIZES = ["Small", "Medium", "Large"] as const;
type Size = (typeof SIZES)[number];

function SizeGroup({ initial, onPick }: { initial: Size; onPick?: (size: Size) => void }) {
  const [value, setValue] = useState<Size>(initial);
  return (
    <>
      <button type="button">Before</button>
      <RadioGroup
        aria-label="Size"
        value={value}
        onValueChange={(next: Size) => {
          onPick?.(next);
          setValue(next);
        }}
      >
        {SIZES.map((size) => (
          <RadioGroupItem key={size} value={size} aria-label={size} />
        ))}
      </RadioGroup>
      <button type="button">After</button>
    </>
  );
}

function checkedName() {
  return screen.getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")
    ?.getAttribute("aria-label");
}

describe("RadioGroup", () => {
  it("moves focus and selection together with the arrow keys and wraps at the ends", async () => {
    const user = userEvent.setup();
    render(<SizeGroup initial="Small" />);

    await user.click(screen.getByRole("button", { name: "Before" }));
    await user.tab();
    expect(screen.getByRole("radio", { name: "Small" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
    expect(checkedName()).toBe("Medium");

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Small" })).toHaveFocus();
    expect(checkedName()).toBe("Small");

    await user.keyboard("{ArrowUp}");
    expect(checkedName()).toBe("Large");
  });

  it("is a single tab stop that lands on the checked radio", async () => {
    const user = userEvent.setup();
    render(<SizeGroup initial="Large" />);

    await user.click(screen.getByRole("button", { name: "Before" }));
    await user.tab();
    expect(screen.getByRole("radio", { name: "Large" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });

  it("keeps the confirmed value checked when the owner holds a change pending", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup aria-label="Storage" value="system" onValueChange={onValueChange}>
        <RadioGroupItem value="system" aria-label="System" />
        <RadioGroupItem value="shared" aria-label="Shared" />
      </RadioGroup>,
    );

    await user.click(screen.getByRole("radio", { name: "Shared" }));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange.mock.calls[0]?.[0]).toBe("shared");
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Shared" })).toHaveAttribute("aria-checked", "false");
  });
});
