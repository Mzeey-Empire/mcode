import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComposerBranchBar } from "../ComposerBranchBar";

afterEach(cleanup);

describe("ComposerBranchBar", () => {
  it.each(["mcode-plan", "plan-output", "plan-questions"])("strips %s before taking the excerpt", (name) => {
    const content = `\`\`\`\`${name}\n${"private".repeat(30)}\n\`\`\`\`\nSummary.`;
    const { container } = render(<ComposerBranchBar branchFromMessageId="assistant-1" branchFromMessageContent={content} />);
    expect([...container.querySelectorAll("p")].map((node) => node.textContent)).toEqual(["Forking from", "Summary."]);
  });

  it("omits an empty excerpt when the source only contains a plan", () => {
    const { container } = render(<ComposerBranchBar branchFromMessageId="assistant-1" branchFromMessageContent={"```mcode-plan\nHidden\n```"} />);
    expect([...container.querySelectorAll("p")].map((node) => node.textContent)).toEqual(["Forking from"]);
  });
});
