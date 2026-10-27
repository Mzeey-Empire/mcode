#!/usr/bin/env bun
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
// TypeScript belongs to the contracts workspace, rather than the repository root.
import ts from "../../packages/contracts/node_modules/typescript/lib/typescript.js";

interface ImportTarget {
  module: string;
  name: string;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const root = NodePath.resolve(NodeURL.fileURLToPath(new URL("../..", import.meta.url)));
const contractsRoot = NodePath.join(root, "packages/contracts/src");
const indexPath = NodePath.join(contractsRoot, "index.ts");
const packageName = "@mcode/contracts";
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

function trackedSources(): string[] {
  return NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", "apps/", "packages/", "scripts/"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter((file) => /\.(?:ts|tsx|mts|mjs)$/.test(file))
    .filter((file) => !/(?:^|\/)(?:node_modules|dist|out|\.opensrc)\//.test(file));
}

function originalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function moduleExports(checker: ts.TypeChecker, source: ts.SourceFile): ts.Symbol[] {
  const symbol = checker.getSymbolAtLocation(source);
  return symbol ? checker.getExportsOfModule(symbol) : [];
}

function modulePath(source: ts.SourceFile): string {
  const relative = NodePath.relative(contractsRoot, source.fileName).replaceAll("\\", "/");
  if (relative.startsWith("../")) throw new Error(`Declaration outside contracts: ${source.fileName}`);
  return `${packageName}/${relative.replace(/\.ts$/, "")}`;
}

function externalBoundary(checker: ts.TypeChecker, source: ts.SourceFile): boolean {
  return source.statements.some((statement) => {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) return false;
    const symbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
    return symbol?.declarations?.some((declaration) =>
      !NodePath.resolve(declaration.getSourceFile().fileName).startsWith(`${contractsRoot}${NodePath.sep}`),
    ) ?? false;
  });
}

function definingTarget(checker: ts.TypeChecker, symbol: ts.Symbol, boundaries: ts.SourceFile[]): ImportTarget {
  const original = originalSymbol(checker, symbol);
  const declaration = original.declarations?.[0];
  if (!declaration) throw new Error(`No declaration for ${symbol.name}`);
  let source = declaration.getSourceFile();
  if (!NodePath.resolve(source.fileName).startsWith(`${contractsRoot}${NodePath.sep}`)) {
    // Keep external packages behind the contracts compatibility boundary.
    const boundary = boundaries.find((candidate) => moduleExports(checker, candidate)
      .some((entry) => originalSymbol(checker, entry) === original));
    if (!boundary) throw new Error(`No contracts boundary for ${symbol.name}`);
    source = boundary;
  }
  const exports = moduleExports(checker, source).filter((entry) => originalSymbol(checker, entry) === original);
  const exported = exports.find((entry) => entry.name === original.name) ?? exports[0];
  if (!exported) throw new Error(`Declaration is not exported: ${symbol.name} in ${source.fileName}`);
  return { module: modulePath(source), name: exported.name };
}

function exportTargets(files: string[]): Map<string, ImportTarget> {
  const sources = files.filter((file) => file.startsWith("packages/contracts/src/") && NodeFS.existsSync(NodePath.join(root, file)));
  const program = ts.createProgram(sources.map((file) => NodePath.join(root, file)), {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const modules = sources.filter((file) => !/(?:__tests__|\.test\.|\.type-test\.)/.test(file))
    .map((file) => program.getSourceFile(NodePath.join(root, file)))
    .filter((source): source is ts.SourceFile => source !== undefined);
  const boundaries = modules.filter((source) => externalBoundary(checker, source));
  const index = program.getSourceFile(indexPath);
  const targets = new Map<string, ImportTarget>();
  const ambiguous = new Set<string>();
  for (const source of index ? [index] : modules) {
    for (const symbol of moduleExports(checker, source)) {
      const target = definingTarget(checker, symbol, boundaries);
      const previous = targets.get(symbol.name);
      if (previous && (previous.module !== target.module || previous.name !== target.name)) ambiguous.add(symbol.name);
      targets.set(symbol.name, target);
    }
  }
  for (const name of ambiguous) targets.delete(name);
  return targets;
}

function targetFor(targets: Map<string, ImportTarget>, name: string): ImportTarget {
  const target = targets.get(name);
  if (!target) throw new Error(`Missing or ambiguous contracts export: ${name}`);
  return target;
}

function isBarrel(text: string, file: string): boolean {
  if (text === packageName) return true;
  return file.startsWith("packages/contracts/") && text.startsWith(".")
    && NodePath.resolve(root, NodePath.dirname(file), text).replace(/\.js$/, ".ts") === indexPath;
}

function print(node: ts.Node, source: ts.SourceFile): string {
  ts.setEmitFlags(node, ts.EmitFlags.NoLeadingComments);
  return printer.printNode(ts.EmitHint.Unspecified, node, source);
}

function groupSpecifiers<T extends ts.ImportSpecifier | ts.ExportSpecifier>(
  elements: readonly T[], targets: Map<string, ImportTarget>, rename: (element: T, target: ImportTarget) => T,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const element of elements) {
    const target = targetFor(targets, (element.propertyName ?? element.name).text);
    const group = groups.get(target.module) ?? [];
    group.push(rename(element, target));
    groups.set(target.module, group);
  }
  return groups;
}

function rewriteImport(node: ts.ImportDeclaration, source: ts.SourceFile, targets: Map<string, ImportTarget>): string {
  const clause = node.importClause;
  if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    throw new Error(`Expected named contracts imports in ${source.fileName}`);
  }
  const groups = groupSpecifiers(clause.namedBindings.elements, targets, (element, target) =>
    ts.factory.updateImportSpecifier(element, element.isTypeOnly,
      target.name === element.name.text ? undefined : ts.factory.createIdentifier(target.name), element.name));
  return [...groups].map(([module, elements]) => print(ts.factory.updateImportDeclaration(node, node.modifiers,
    ts.factory.updateImportClause(clause, clause.isTypeOnly, undefined, ts.factory.createNamedImports(elements)),
    ts.factory.createStringLiteral(module), node.attributes), source)).join("\n");
}

function rewriteExport(node: ts.ExportDeclaration, source: ts.SourceFile, targets: Map<string, ImportTarget>): string {
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) throw new Error(`Expected named contracts exports in ${source.fileName}`);
  const groups = groupSpecifiers(clause.elements, targets, (element, target) =>
    ts.factory.updateExportSpecifier(element, element.isTypeOnly,
      target.name === element.name.text ? undefined : ts.factory.createIdentifier(target.name), element.name));
  return [...groups].map(([module, elements]) => print(ts.factory.updateExportDeclaration(node, node.modifiers,
    node.isTypeOnly, ts.factory.createNamedExports(elements), ts.factory.createStringLiteral(module), node.attributes), source)).join("\n");
}

function rewriteType(node: ts.ImportTypeNode, source: ts.SourceFile, targets: Map<string, ImportTarget>): string {
  if (!node.qualifier) throw new Error(`Expected qualified contracts type in ${source.fileName}`);
  let name: ts.EntityName = node.qualifier;
  while (ts.isQualifiedName(name)) name = name.left;
  const target = targetFor(targets, name.text);
  const edits: Edit[] = [{ start: node.argument.getStart(source), end: node.argument.end, text: JSON.stringify(target.module) }];
  if (target.name !== name.text) edits.push({ start: name.getStart(source), end: name.end, text: target.name });
  return applyEdits(source.text.slice(node.getStart(source), node.end), edits.map((edit) => ({
    ...edit, start: edit.start - node.getStart(source), end: edit.end - node.getStart(source),
  })));
}

function mockObject(factory: ts.Expression): ts.ObjectLiteralExpression {
  if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) throw new Error("Expected a contracts mock factory");
  let body: ts.Node = factory.body;
  if (ts.isBlock(body)) {
    const returned = body.statements.find(ts.isReturnStatement)?.expression;
    if (!returned) throw new Error("Expected a returned contracts mock object");
    body = returned;
  }
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isObjectLiteralExpression(body)) throw new Error("Expected a contracts mock object");
  return body;
}

function rewriteMock(node: ts.CallExpression, source: ts.SourceFile, targets: Map<string, ImportTarget>): string {
  const factory = node.arguments[1];
  if (!factory) throw new Error(`Expected an explicit contracts mock factory in ${source.fileName}`);
  const object = mockObject(factory);
  const groups = new Map<string, ts.ObjectLiteralElementLike[]>();
  for (const property of object.properties) {
    const name = property.name;
    if (!name || (!ts.isIdentifier(name) && !ts.isStringLiteral(name))) throw new Error("Expected named contracts mock overrides");
    const target = targetFor(targets, name.text);
    if (target.name !== name.text) throw new Error(`Mock alias requires an explicit factory: ${name.text}`);
    const group = groups.get(target.module) ?? [];
    group.push(property);
    groups.set(target.module, group);
  }
  return [...groups].map(([module, properties]) => {
    const edits = [
      { start: node.arguments[0].getStart(source), end: node.arguments[0].end, text: JSON.stringify(module) },
      { start: object.getStart(source), end: object.end, text: `{${properties.map((property) => `${property.getFullText(source)},`).join("")}\n}` },
    ].map((edit) => ({ ...edit, start: edit.start - node.getStart(source), end: edit.end - node.getStart(source) }));
    return applyEdits(node.getText(source), edits);
  }).join(";\n\n");
}

function applyEdits(text: string, edits: Edit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return text;
}

function barrelSpecifier(node: ts.Node | undefined, file: string): boolean {
  return node !== undefined && ts.isStringLiteral(node) && isBarrel(node.text, file);
}

function rewriteModuleCall(node: ts.CallExpression, source: ts.SourceFile, targets: Map<string, ImportTarget>): string | undefined {
  if (!barrelSpecifier(node.arguments[0], source.fileName)) return undefined;
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "mock") {
    throw new Error(`Unsupported contracts module call in ${source.fileName}: ${node.getText(source)}`);
  }
  return rewriteMock(node, source, targets);
}

function rewriteNode(node: ts.Node, source: ts.SourceFile, targets: Map<string, ImportTarget>): string | undefined {
  if (ts.isImportDeclaration(node)) {
    return barrelSpecifier(node.moduleSpecifier, source.fileName) ? rewriteImport(node, source, targets) : undefined;
  }
  if (ts.isExportDeclaration(node)) {
    return barrelSpecifier(node.moduleSpecifier, source.fileName) ? rewriteExport(node, source, targets) : undefined;
  }
  if (ts.isImportTypeNode(node)) {
    const argument = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
    return barrelSpecifier(argument, source.fileName) ? rewriteType(node, source, targets) : undefined;
  }
  if (ts.isCallExpression(node)) return rewriteModuleCall(node, source, targets);
  return undefined;
}

function rewriteSource(file: string, text: string, targets: Map<string, ImportTarget>): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits: Edit[] = [];
  const visit = (node: ts.Node): void => {
    const replacement = rewriteNode(node, source, targets);
    if (replacement !== undefined) {
      edits.push({ start: node.getStart(source), end: node.end, text: replacement });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return applyEdits(text, edits.map((edit) => ({ ...edit, text: edit.text.replace(/\r?\n/g, newline) })));
}

const files = trackedSources();
const targets = exportTargets(files);
const changes = new Map<string, string>();
for (const file of files) {
  if (NodePath.join(root, file) === indexPath || !NodeFS.existsSync(NodePath.join(root, file))) continue;
  const text = NodeFS.readFileSync(NodePath.join(root, file), "utf8");
  const rewritten = rewriteSource(file, text, targets);
  if (rewritten !== text) changes.set(file, rewritten);
}
const counts = new Map<string, number>();
for (const [file, text] of changes) {
  NodeFS.writeFileSync(NodePath.join(root, file), text);
  const workspace = file.startsWith("scripts/") ? "scripts" : file.split("/").slice(0, 2).join("/");
  counts.set(workspace, (counts.get(workspace) ?? 0) + 1);
}
for (const [workspace, count] of [...counts].sort()) console.log(`${workspace}: ${count} files changed`);
console.log(`Total: ${changes.size} files changed`);
