import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ProviderDisabledError } from "../../../providers/availability/provider-availability-errors.js";
import { NoCompletionProviderError, type UtilityCompletion } from "../../../../shared/completion/utility-completion-service.js";
import { CommitMessageGenerator } from "../commits/commit-message-generator.js";

const DIFF = { stat: " a.ts | 2 +-", patch: "diff --git a/a.ts b/a.ts\n-old\n+new\n" };

function createGenerator(complete: (prompt: string) => Promise<UtilityCompletion>, patch = DIFF.patch) {
  const completion = { complete: vi.fn(complete) };
  const generator = new CommitMessageGenerator(
    { exec: vi.fn().mockResolvedValue({ stdout: "feat: earlier work\nfix: older bug\n", stderr: "" }) },
    { readSelectedPathsDiff: vi.fn().mockResolvedValue({ ...DIFF, patch }) },
    completion,
    { getCached: (provider) => provider === "claude" ? [{ id: "claude-haiku", name: "Claude Haiku" }] : undefined },
  );
  return { generator, completion };
}

const reply = (text: string, model = "claude-haiku"): Promise<UtilityCompletion> =>
  Promise.resolve({ text, provider: "claude", model });

describe("CommitMessageGenerator", () => {
  it("returns the parsed message and names the model from the catalog", async () => {
    const { generator, completion } = createGenerator(() =>
      reply('Here you go: {"subject": "feat: add commit sheet", "body": "Users commit from Review.\\n"}'));

    expect(await generator.generate("/repo", ["a.ts"])).toEqual({
      status: "ok",
      subject: "feat: add commit sheet",
      body: "Users commit from Review.",
      model: { provider: "claude", id: "claude-haiku", name: "Claude Haiku" },
    });
    const prompt = completion.complete.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("- feat: earlier work");
    expect(prompt).toContain(DIFF.stat);
    expect(prompt).toContain("+new");
  });

  it("falls back to the model id when the catalog does not know the model", async () => {
    const { generator } = createGenerator(() => reply('{"subject": "fix: x", "body": ""}', "claude-unlisted"));

    expect(await generator.generate("/repo", ["a.ts"])).toMatchObject({
      model: { id: "claude-unlisted", name: "claude-unlisted" },
    });
  });

  it.each([
    ["no JSON", "I could not decide."],
    ["a subject over 72 characters", JSON.stringify({ subject: "x".repeat(73), body: "" })],
    ["a missing body", JSON.stringify({ subject: "feat: x" })],
  ])("reports %s as unparseable, never as text", async (_label, text) => {
    const { generator } = createGenerator(() => reply(text));

    expect(await generator.generate("/repo", ["a.ts"])).toEqual({
      status: "failed", reason: "unparseable", message: "The model did not return a usable commit message.",
    });
  });

  it("reports an empty diff without calling the model", async () => {
    const { generator, completion } = createGenerator(() => reply("{}"), "  \n");

    expect(await generator.generate("/repo", ["a.ts"])).toMatchObject({ status: "failed", reason: "empty-diff" });
    expect(completion.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["a disabled provider", new ProviderDisabledError("claude")],
    ["no completion-capable provider", new NoCompletionProviderError()],
  ])("reports %s as provider-unavailable", async (_label, error) => {
    const { generator } = createGenerator(() => Promise.reject(error));

    expect(await generator.generate("/repo", ["a.ts"])).toMatchObject({ status: "failed", reason: "provider-unavailable" });
  });

  it("reports a model that does not answer in time as timeout", async () => {
    const { generator } = createGenerator(() => new Promise<UtilityCompletion>(() => {}));

    expect(await generator.generate("/repo", ["a.ts"], 20)).toMatchObject({ status: "failed", reason: "timeout" });
  });

  it("does not hide an unexpected completion error", async () => {
    const { generator } = createGenerator(() => Promise.reject(new Error("provider crashed")));

    await expect(generator.generate("/repo", ["a.ts"])).rejects.toThrow("provider crashed");
  });
});
