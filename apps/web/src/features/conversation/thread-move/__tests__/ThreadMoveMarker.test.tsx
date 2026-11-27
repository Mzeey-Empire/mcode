import { createMockMessage } from "@mcode/contracts/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MessageBubble } from "@/features/conversation/messages/MessageBubble";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";

const marker = createMockMessage({
  id: "move-1",
  thread_id: "thread-1",
  role: "system",
  content: "Moved to mcode",
  threadMove: { projectName: "mcode", target: "local" },
});

beforeEach(() => resetThreadStoreForTests({ records: new Map([["thread-1", createEmptyThreadRecord()]]) }));
afterEach(() => resetThreadStoreForTests());

describe("ThreadMoveMarker", () => {
  it("shows the project the thread moved into and where it runs", () => {
    render(<MessageBubble message={marker} />);
    expect(screen.getByRole("note", { name: "Moved to mcode · Local" })).toHaveTextContent("Moved to mcode · Local");
  });

  it("puts the project name in its own element so it can be emphasised", () => {
    render(<MessageBubble message={marker} />);
    expect(screen.getByText("mcode")).toHaveTextContent(/^mcode$/);
  });

  it("renders the marker instead of the plain system note", () => {
    render(<MessageBubble message={marker} />);
    expect(screen.queryByText("Moved to mcode", { exact: true })).toBeNull();
  });
});
