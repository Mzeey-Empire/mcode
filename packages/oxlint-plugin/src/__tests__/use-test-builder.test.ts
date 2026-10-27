import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { useTestBuilder } from "../rules/use-test-builder.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const threadShape = {
  type: "Thread",
  builder: "createMockThread",
  from: "@mcode/contracts/testing",
  keys: ["title", "worktree_path", "checkout_state"],
};
const messageShape = {
  type: "Message",
  builder: "createMockMessage",
  from: "@mcode/contracts/testing",
  keys: ["thread_id", "role", "tool_calls", "files_changed"],
};
const workspaceShape = {
  type: "Workspace",
  builder: "createMockWorkspace",
  from: "@mcode/contracts/testing",
  keys: ["path", "provider_config", "is_git_repo"],
};
const approvalShape = {
  type: "ApprovalRequest",
  builder: "createMockApproval",
  from: "@mcode/contracts/testing",
  keys: ["requestId", "subject", "choices", "origin"],
};
const options = [{ shapes: [threadShape, messageShape, workspaceShape, approvalShape] }];

ruleTester.run("use-test-builder", useTestBuilder, {
  valid: [
    {
      name: "no configured shapes",
      code: 'const workspace = { path: "/repo", provider_config: {}, is_git_repo: true };',
    },
    {
      name: "a partial thread used by a PR router stub",
      code: 'const thread = { workspace_id: "ws", worktree_path: null, checkout_state: "named" };',
      options,
    },
    {
      name: "spread properties do not supply identifying keys",
      code: 'const message = { ...base, thread_id: "t", role: "user", tool_calls: null };',
      options,
    },
    {
      name: "a dynamic computed key is not an identifying key",
      code: 'const workspace = { path: "/repo", [provider_config]: {}, is_git_repo: true };',
      options,
    },
    {
      name: "each builder accepts overrides including all identifying keys",
      code: `
        createMockThread({ workspace_id: "ws", worktree_path: null, checkout_state: "named", title: "Test" });
        createMockMessage({ thread_id: "t", role: "user", tool_calls: null, files_changed: null });
        createMockWorkspace({ path: "/repo", provider_config: {}, is_git_repo: true });
        createMockApproval({ requestId: "r", subject, choices, origin });
      `,
      options,
    },
    {
      name: "object destructuring is not a fixture literal",
      code: "const { path, provider_config, is_git_repo } = workspace;",
      options,
    },
  ],
  invalid: [
    {
      name: "a thread with additional fields",
      code: 'const thread = { id: "t", workspace_id: "ws", worktree_path: null, checkout_state: "named", title: "Test" };',
      options,
      errors: [{ messageId: "useBuilder", data: threadShape }],
    },
    {
      name: "a message returned by a local helper",
      code: 'function message() { return { thread_id: "t", role: "user", tool_calls: null, files_changed: null }; }',
      options,
      errors: [{ messageId: "useBuilder", data: messageShape }],
    },
    {
      name: "a workspace with quoted and static computed keys",
      code: 'const workspace = { "path": "/repo", ["provider_config"]: {}, is_git_repo: true };',
      options,
      errors: [{ messageId: "useBuilder", data: workspaceShape }],
    },
    {
      name: "an approval using shorthand keys and a spread",
      code: "const approval = { ...base, requestId, subject, choices, origin };",
      options,
      errors: [{ messageId: "useBuilder", data: approvalShape }],
    },
    {
      name: "a different builder does not exempt the literal",
      code: 'createMockThread({ path: "/repo", provider_config: {}, is_git_repo: true });',
      options,
      errors: [{ messageId: "useBuilder", data: workspaceShape }],
    },
    {
      name: "a literal nested inside builder overrides is still reported",
      code: 'createMockThread({ workspace: { path: "/repo", provider_config: {}, is_git_repo: true } });',
      options,
      errors: [{ messageId: "useBuilder", data: workspaceShape }],
    },
    {
      name: "every matching shape is reported",
      code: 'const fixture = { path: "/repo", provider_config: {}, is_git_repo: true, requestId, subject, choices, origin };',
      options,
      errors: [{ messageId: "useBuilder", data: workspaceShape }, { messageId: "useBuilder", data: approvalShape }],
    },
    {
      name: "custom shapes and builders support numeric property names",
      code: 'customBuilder({ 0: "value", name: "test" }); const fixture = { 0: "value", name: "test" };',
      options: [{ shapes: [{ type: "Custom", builder: "customBuilder", from: "custom/testing", keys: ["0", "name"] }] }],
      errors: [{ messageId: "useBuilder", data: { type: "Custom", builder: "customBuilder", from: "custom/testing" } }],
    },
  ],
});
