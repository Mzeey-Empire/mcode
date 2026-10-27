import { defineRule, type ESTree, type Context } from "@oxlint/plugins";

function isViMock(node: ESTree.CallExpression): boolean {
  const callee = node.callee;
  return (
    callee.type === "MemberExpression"
    && callee.object.type === "Identifier"
    && callee.object.name === "vi"
    && !callee.computed
    && callee.property.type === "Identifier"
    && callee.property.name === "mock"
  );
}

function isFactory(node: ESTree.Argument | undefined): node is ESTree.ArrowFunctionExpression | ESTree.Function {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

function isOptionObject(value: Context["options"][number] | undefined): value is { [key: string]: Context["options"][number] } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredMock(context: Context, specifier: string): { name: string; from: string } | null {
  const [options] = context.options;
  if (!isOptionObject(options)) return null;
  const modules = options.modules;
  if (!isOptionObject(modules)) return null;
  if (!Object.hasOwn(modules, specifier)) return null;
  const configured = modules[specifier];
  if (!isOptionObject(configured)) return null;
  if (typeof configured.name !== "string" || typeof configured.from !== "string") return null;
  return { name: configured.name, from: configured.from };
}

/** Keep module mocks on their shared fake so new methods need no test edits. */
export const noInlineModuleMock = defineRule({
  meta: {
    type: "suggestion",
    schema: [{
      type: "object",
      properties: {
        modules: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { name: { type: "string" }, from: { type: "string" } },
            required: ["name", "from"],
            additionalProperties: false,
          },
        },
      },
      required: ["modules"],
      additionalProperties: false,
    }],
    messages: {
      inlineModuleMock:
        'Mock "{{specifier}}" with {{name}} from "{{from}}" and set per-test behavior with vi.mocked({{name}}.<method>). An inline mock breaks when the module gains a method.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isViMock(node)) return;
        const [source, factory] = node.arguments;
        if (source?.type !== "Literal" || typeof source.value !== "string") return;
        const configured = configuredMock(context, source.value);
        if (configured === null) return;
        if (isFactory(factory)) {
          const referencesFake = context.sourceCode.getTokens(factory).some(
            (token) => token.type === "Identifier" && token.value === configured.name,
          );
          if (referencesFake) return;
        }
        context.report({
          node,
          messageId: "inlineModuleMock",
          data: { specifier: source.value, ...configured },
        });
      },
    };
  },
});
