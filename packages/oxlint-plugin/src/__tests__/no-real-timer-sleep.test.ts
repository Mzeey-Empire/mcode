import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noRealTimerSleep } from "../rules/no-real-timer-sleep.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

ruleTester.run("no-real-timer-sleep", noRealTimerSleep, {
  valid: [
    {
      name: "a macrotask yield below the threshold",
      code: "await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((r) => setTimeout(r, 49)); await new Promise((r) => setTimeout(r));",
    },
    {
      name: "setTimeout that does not resolve the promise",
      code: "await new Promise((resolve) => { setTimeout(() => emitter.emit('done'), 500); emitter.once('done', resolve); });",
    },
    {
      name: "setTimeout outside a promise",
      code: "const handle = setTimeout(() => controller.abort(), 1000); clearTimeout(handle);",
    },
    {
      name: "a timeout that rejects instead of resolving",
      code: "await new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 5000));",
    },
    {
      name: "a mock that resolves a value after a delay",
      code: "mock.mockReturnValue(new Promise((resolve) => setTimeout(() => resolve(threads), 100)));",
    },
    {
      name: "an upper-bound timeout raced against the real signal",
      code: "await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2_000))]);",
    },
    {
      name: "vi.waitFor",
      code: "await vi.waitFor(() => expect(spy).toHaveBeenCalled());",
    },
  ],
  invalid: [
    {
      name: "an awaited literal sleep",
      code: "await new Promise((resolve) => setTimeout(resolve, 100));",
      errors: [{ messageId: "realTimerSleep" }],
    },
    {
      name: "a sleep at exactly the threshold through a wrapper callback",
      code: "await new Promise((r) => setTimeout(() => r(), 50));",
      errors: [{ messageId: "realTimerSleep" }],
    },
    {
      name: "a block-bodied function executor via globalThis",
      code: "await new Promise(function (done) { globalThis.setTimeout(done, 250); });",
      errors: [{ messageId: "realTimerSleep" }],
    },
    {
      name: "a sleep helper with a non-literal delay",
      code: "const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)); await sleep(10);",
      errors: [{ messageId: "realTimerSleep" }],
    },
    {
      name: "a sleep helper that returns the promise",
      code: "function wait(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }",
      errors: [{ messageId: "realTimerSleep" }],
    },
  ],
});
