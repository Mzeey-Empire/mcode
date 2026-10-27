import { defineRule, type ESTree } from "@oxlint/plugins";

type Shape = {
  type: string;
  builder: string;
  from: string;
  keys: string[];
};

function propertyName(property: ESTree.ObjectExpression["properties"][number]): string | null {
  if (property.type !== "Property") return null;
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && (typeof property.key.value === "string" || typeof property.key.value === "number")) {
    return String(property.key.value);
  }
  return null;
}

function isBuilderArgument(node: ESTree.ObjectExpression, builder: string): boolean {
  const parent = node.parent;
  return (
    parent.type === "CallExpression"
    && parent.arguments.includes(node)
    && parent.callee.type === "Identifier"
    && parent.callee.name === builder
  );
}

/** Require shared builders instead of repeating complete contract fixtures. */
export const useTestBuilder = defineRule({
  meta: {
    type: "suggestion",
    schema: [{
      type: "object",
      properties: {
        shapes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              builder: { type: "string" },
              from: { type: "string" },
              keys: { type: "array", items: { type: "string" }, minItems: 1 },
            },
            required: ["type", "builder", "from", "keys"],
            additionalProperties: false,
          },
        },
      },
      required: ["shapes"],
      additionalProperties: false,
    }],
    messages: {
      useBuilder: 'Build a {{type}} with {{builder}}() from "{{from}}" and pass only the fields this test needs. A hand-written {{type}} breaks when the type gains a field.',
    },
  },
  create(context) {
    const options = context.options[0] as { shapes: Shape[] } | undefined;
    const shapes = options?.shapes ?? [];
    return {
      ObjectExpression(node) {
        const keys = new Set(node.properties.map(propertyName));
        for (const shape of shapes) {
          if (shape.keys.every((key) => keys.has(key)) && !isBuilderArgument(node, shape.builder)) {
            context.report({
              node,
              messageId: "useBuilder",
              data: { type: shape.type, builder: shape.builder, from: shape.from },
            });
          }
        }
      },
    };
  },
});
