import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noSourceTextTest } from "../rules/no-source-text-test.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
});

ruleTester.run("no-source-text-test", noSourceTextTest, {
  valid: [
    {
      name: "raw imports of text fixtures",
      code: 'import notes from "./fixtures/notes.md?raw"; import data from "./fixtures/events.jsonl?raw"; import svg from "../icon.svg?raw";',
    },
    {
      name: "plain source imports",
      code: 'import { Composer } from "../Composer.tsx";',
    },
    {
      name: "reading data fixtures",
      code: [
        'import * as NodeFS from "node:fs";',
        'const a = NodeFS.readFileSync(NodePath.join(fixtureDirectory, "v1.sql"), "utf8");',
        'const b = NodeFS.readFileSync(new URL("./fixtures/session.jsonl", import.meta.url), "utf8");',
        'const c = await NodeFSPromises.readFile(NodePath.join(dir, "settings.json"), "utf8");',
        'const d = readFileSync("snapshot.txt", "utf8");',
      ].join("\n"),
    },
    {
      name: "reading a generated .ts file back from a temp directory",
      code: 'const text = NodeFS.readFileSync(NodePath.join(tmpDir, "hello.ts"), "utf8"); const t = NodeFS.readFileSync(`${tmpDir}/a.ts`, "utf8");',
    },
    {
      name: "reading a dynamic path",
      code: 'const text = NodeFS.readFileSync(result.sourcePath, "utf8");',
    },
    {
      name: "a worker URL that is not read as text",
      code: 'new Worker(new URL("../writer.worker.ts", import.meta.url), { type: "module" });',
    },
    {
      name: "a glob without the raw query",
      code: 'const modules = import.meta.glob("../*.tsx", { eager: true });',
    },
  ],
  invalid: [
    {
      name: "a raw import of a TSX source",
      code: 'import source from "../Composer.tsx?raw";',
      errors: [{ messageId: "sourceText", data: { path: "../Composer.tsx?raw" } }],
    },
    {
      name: "a raw import of CSS and a dynamic raw import of JS",
      code: 'import css from "../index.css?raw"; const js = await import("./bundle.js?raw");',
      errors: [{ messageId: "sourceText" }, { messageId: "sourceText" }],
    },
    {
      name: "a raw glob over sources",
      code: 'const modules = import.meta.glob<string>(["../ChatView.tsx"], { query: "?raw", import: "default" });',
      errors: [{ messageId: "sourceText" }],
    },
    {
      name: "readFileSync through the NodeFS namespace and path.resolve",
      code: 'const source = NodeFS.readFileSync(NodePath.resolve(here, "../../Composer.tsx"), "utf8");',
      errors: [{ messageId: "sourceText", data: { path: 'NodePath.resolve(here, "../../Composer.tsx")' } }],
    },
    {
      name: "a named readFile import with path.join into src",
      code: 'import { readFile } from "node:fs/promises"; const text = await readFile(join(root, "apps/web/src/index.css"), "utf8");',
      errors: [{ messageId: "sourceText" }],
    },
    {
      name: "a string literal and a static template literal",
      code: 'readFileSync("src/main.ts", "utf8"); readFileSync(`src/main.tsx`, "utf8");',
      errors: [{ messageId: "sourceText" }, { messageId: "sourceText" }],
    },
    {
      name: "a template literal walking to a sibling source",
      code: "const text = fs.readFileSync(`${here}/../index.css`, \"utf8\");",
      errors: [{ messageId: "sourceText" }],
    },
    {
      name: "a URL relative to the test module",
      code: 'const text = NodeFS.readFileSync(new URL("../ChatView.tsx", import.meta.url), "utf8");',
      errors: [{ messageId: "sourceText" }],
    },
    {
      name: "a const path declared before the read",
      code: 'const cssPath = NodePath.resolve(here, "../index.css"); const css = NodeFS.readFileSync(cssPath, "utf8");',
      errors: [{ messageId: "sourceText" }],
    },
  ],
});
