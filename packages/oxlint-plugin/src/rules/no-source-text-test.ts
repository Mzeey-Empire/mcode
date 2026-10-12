import { defineRule, type ESTree } from "@oxlint/plugins";

const RAW_SOURCE_IMPORT = /\.(?:[cm]?[jt]sx?|css)\?raw$/;
const SOURCE_PATH = /\.(?:tsx?|css)$/;
const RELATIVE_OR_SOURCE_SEGMENT = /^[/\\]?\.{1,2}[/\\]|(?:^|[/\\])src[/\\]/;
const READ_FUNCTIONS = new Set(["readFile", "readFileSync"]);
const PATH_BUILDERS = new Set(["join", "resolve"]);

type PathNode = ESTree.Expression | ESTree.SpreadElement | ESTree.Argument;
type ConstantPaths = ReadonlyMap<string, ESTree.Expression>;

function stringLiteralValue(node: PathNode): string | null {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function memberOrIdentifierName(callee: ESTree.Expression): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return null;
}

function isImportMetaUrl(node: PathNode): boolean {
  return (
    node.type === "MemberExpression"
    && node.object.type === "MetaProperty"
    && !node.computed
    && node.property.type === "Identifier"
    && node.property.name === "url"
  );
}

// A dynamic base such as a temp directory can hold generated `.ts` fixtures, so a
// dynamic path only counts as repo source when its literal tail walks relative to
// the test file or into a `src/` tree.
function dynamicTailPointsAtSource(tail: string | null): boolean {
  return tail !== null && SOURCE_PATH.test(tail) && RELATIVE_OR_SOURCE_SEGMENT.test(tail);
}

function isSourceUrl(node: ESTree.NewExpression, constants: ConstantPaths): boolean {
  const [href, base] = node.arguments;
  return (
    node.callee.type === "Identifier"
    && node.callee.name === "URL"
    && href !== undefined
    && base !== undefined
    && isImportMetaUrl(base)
    && pathPointsAtSource(href, constants)
  );
}

function isSourcePathBuilder(node: ESTree.CallExpression): boolean {
  const last = node.arguments.at(-1);
  return (
    PATH_BUILDERS.has(memberOrIdentifierName(node.callee) ?? "")
    && last !== undefined
    && dynamicTailPointsAtSource(stringLiteralValue(last))
  );
}

function pathPointsAtSource(node: PathNode, constants: ConstantPaths): boolean {
  const literal = stringLiteralValue(node);
  if (literal !== null) return SOURCE_PATH.test(literal);
  switch (node.type) {
    case "Identifier": {
      const init = constants.get(node.name);
      return init !== undefined && pathPointsAtSource(init, new Map());
    }
    case "TemplateLiteral":
      return dynamicTailPointsAtSource(node.quasis.at(-1)?.value.cooked ?? null);
    case "NewExpression":
      return isSourceUrl(node, constants);
    case "CallExpression":
      return isSourcePathBuilder(node);
    default:
      return false;
  }
}

function isRawQueryOption(property: ESTree.ObjectExpression["properties"][number]): boolean {
  return (
    property.type === "Property"
    && property.key.type === "Identifier"
    && property.key.name === "query"
    && stringLiteralValue(property.value) === "?raw"
  );
}

function globPatterns(node: PathNode): string[] {
  const single = stringLiteralValue(node);
  if (single !== null) return [single];
  if (node.type !== "ArrayExpression") return [];
  return node.elements.flatMap((element) => (element === null ? [] : globPatterns(element)));
}

function isRawSourceGlob(node: ESTree.CallExpression): boolean {
  const [patterns, options] = node.arguments;
  return (
    node.callee.type === "MemberExpression"
    && node.callee.object.type === "MetaProperty"
    && memberOrIdentifierName(node.callee) === "glob"
    && patterns !== undefined
    && options?.type === "ObjectExpression"
    && options.properties.some(isRawQueryOption)
    && globPatterns(patterns).some((pattern) => SOURCE_PATH.test(pattern))
  );
}

/** Ban tests that read source files as text instead of exercising behavior. */
export const noSourceTextTest = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      sourceText:
        "Assert behavior, not source text. Render or call the code under test instead of reading `{{path}}` as a string.",
    },
  },
  create(context) {
    const constants = new Map<string, ESTree.Expression>();
    const reportSourceImport = (node: ESTree.Node, source: ESTree.Expression) => {
      const path = stringLiteralValue(source);
      if (path !== null && RAW_SOURCE_IMPORT.test(path)) {
        context.report({ node, messageId: "sourceText", data: { path } });
      }
    };
    return {
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init !== null && node.parent.type === "VariableDeclaration" && node.parent.kind === "const") {
          constants.set(node.id.name, node.init);
        }
      },
      ImportDeclaration(node) {
        reportSourceImport(node, node.source);
      },
      ImportExpression(node) {
        reportSourceImport(node, node.source);
      },
      CallExpression(node) {
        if (isRawSourceGlob(node)) {
          context.report({ node, messageId: "sourceText", data: { path: "import.meta.glob ?raw" } });
          return;
        }
        const [path] = node.arguments;
        if (
          path !== undefined
          && READ_FUNCTIONS.has(memberOrIdentifierName(node.callee) ?? "")
          && pathPointsAtSource(path, constants)
        ) {
          context.report({ node, messageId: "sourceText", data: { path: context.sourceCode.getText(path) } });
        }
      },
    };
  },
});
