import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PlanCommentEditor } from "./PlanCommentEditor";

function renderEditor(canWrite: boolean, onSave = vi.fn(async () => null)) {
  render(
    <PlanCommentEditor
      body="Split this step"
      saved
      canWrite={canWrite}
      onBodyChange={vi.fn()}
      onSave={onSave}
      onDelete={vi.fn(async () => null)}
      onCancel={vi.fn()}
    />,
  );
  return onSave;
}

describe("PlanCommentEditor", () => {
  it("saves with the button and with Enter while the version takes comments", async () => {
    const onSave = renderEditor(true);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Save comment" }));
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "{Enter}");

    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("blocks Save, Enter and Delete once the version no longer takes comments", async () => {
    const onSave = renderEditor(false);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "Comment" }), "{Enter}");

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save comment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeDisabled();
  });
});
