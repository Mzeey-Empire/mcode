import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlanComment } from "@mcode/contracts/models/plan";
import { PlanCommentRow } from "./PlanCommentRow";

const comment = { id: "c1", body: "Split this step" } as PlanComment;

describe("PlanCommentRow", () => {
  it("opens the editor from the note as well as from the pencil", async () => {
    const onEdit = vi.fn();
    render(<PlanCommentRow comment={comment} canEdit onEdit={onEdit} onResolve={vi.fn()} />);

    await userEvent.setup().click(screen.getByText("Split this step"));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("only shows the note once the version no longer takes comments", async () => {
    const onEdit = vi.fn();
    render(<PlanCommentRow comment={comment} canEdit={false} onEdit={onEdit} onResolve={vi.fn()} />);

    await userEvent.setup().click(screen.getByText("Split this step"));

    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
