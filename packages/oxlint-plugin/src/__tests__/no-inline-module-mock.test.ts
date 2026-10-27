import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noInlineModuleMock } from "../rules/no-inline-module-mock.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const options = [{ modules: { "@/transport": { name: "mockTransport", from: "@/__tests__/mocks/transport" } } }];
const error = {
  messageId: "inlineModuleMock",
  data: { specifier: "@/transport", name: "mockTransport", from: "@/__tests__/mocks/transport" },
};

ruleTester.run("no-inline-module-mock", noInlineModuleMock, {
  valid: [
    {
      name: "a factory returning the shared transport",
      code: 'vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));',
      options,
    },
    {
      name: "an async factory retaining the other exports",
      code: 'vi.mock("@/transport", async (importOriginal) => ({ ...(await importOriginal()), getTransport: () => mockTransport, initTransport: vi.fn() }));',
      options,
    },
    {
      name: "a function expression using the shared transport",
      code: 'vi.mock("@/transport", function () { return { getTransport: () => mockTransport }; });',
      options,
    },
    {
      name: "an unconfigured module",
      code: 'vi.mock("@/other", () => ({ method: vi.fn() })); vi.mock("toString");',
      options,
    },
    {
      name: "no configured modules",
      code: 'vi.mock("@/transport");',
    },
    {
      name: "other calls and nonliteral specifiers",
      code: 'other.mock("@/transport"); vi.doMock("@/transport"); mock("@/transport"); vi.mock(moduleName); vi.mock(import("@/transport"));',
      options,
    },
    {
      name: "a configured identifier containing dollar signs",
      code: 'vi.mock("client", () => ({ client: $fake }));',
      options: [{ modules: { client: { name: "$fake", from: "test/client" } } }],
    },
  ],
  invalid: [
    {
      name: "a mock without a factory",
      code: 'vi.mock("@/transport");',
      options,
      errors: [error],
    },
    {
      name: "an inline transport object",
      code: 'vi.mock("@/transport", () => ({ getTransport: () => ({ sendMessage: vi.fn() }) }));',
      options,
      errors: [error],
    },
    {
      name: "an async factory keeping real exports but replacing the transport inline",
      code: 'vi.mock("@/transport", async (importOriginal) => ({ ...(await importOriginal()), getTransport: () => ({}) }));',
      options,
      errors: [error],
    },
    {
      name: "a function expression that does not use the shared transport",
      code: 'vi.mock("@/transport", function () { return { getTransport: vi.fn() }; });',
      options,
      errors: [error],
    },
    {
      name: "a longer identifier does not reference the configured name",
      code: 'vi.mock("@/transport", () => ({ getTransport: () => mockTransportLocal }));',
      options,
      errors: [error],
    },
    {
      name: "comments and strings do not reference the configured identifier",
      code: 'vi.mock("@/transport", () => { /* mockTransport */ return { label: "mockTransport" }; });',
      options,
      errors: [error],
    },
    {
      name: "another configured module uses its own diagnostic",
      code: 'vi.mock("client", () => ({}));',
      options: [{ modules: { client: { name: "fakeClient", from: "test/client" } } }],
      errors: [{
        messageId: "inlineModuleMock",
        data: { specifier: "client", name: "fakeClient", from: "test/client" },
      }],
    },
  ],
});
