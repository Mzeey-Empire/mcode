import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SettingsNav } from "../SettingsNav";

describe("SettingsNav selection indicator", () => {
  it("selected button has bg-primary class", () => {
    render(<SettingsNav section="model" onSection={() => {}} />);
    const selected = screen.getByRole("button", { name: "Model" });
    expect(selected.className).toContain("bg-primary");
  });
});
