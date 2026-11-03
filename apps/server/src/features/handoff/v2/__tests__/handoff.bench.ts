import { bench } from "vitest";
import {
  handoffBudgetBytes,
  selectHandoffHistory,
  type HandoffCoverage,
  type HandoffSourceItem,
} from "../index.js";

const coverage: HandoffCoverage = {
  threadId: "thread-1",
  kind: "switch",
  fromProvider: "codex",
  toProvider: "claude",
  fromSequence: 1,
  toSequence: 5_000,
};

function message(sequence: number, role: "user" | "assistant", text: string): HandoffSourceItem {
  return { sequence, role, kind: "message", provider: null, text };
}

const items = Array.from({ length: 5_000 }, (_, index) => message(index + 1, "user", `request ${index + 1}`));
const budgetBytes = handoffBudgetBytes({ contextWindow: null, nativeContextTokens: null, userText: "", attachments: [] });

bench("selects handoff history from 5,000 user messages at the default budget", () => {
  selectHandoffHistory({ items, coverage, budgetBytes });
});
