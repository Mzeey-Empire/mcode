import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noSyncPopupQuery } from "../rules/no-sync-popup-query.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const test = (body: string) => `it("case", async () => { ${body} });`;

ruleTester.run("no-sync-popup-query", noSyncPopupQuery, {
  valid: [
    {
      name: "waits for the menu with findByRole",
      code: test(`await user.click(trigger); expect(await screen.findByRole("menu")).toBeVisible();`),
    },
    {
      name: "a waitFor settles before the sync query",
      code: test(`await user.click(trigger); await waitFor(() => expect(spy).toHaveBeenCalled()); screen.getByRole("menu");`),
    },
    {
      name: "a sync query inside the waitFor callback",
      code: test(`await user.click(trigger); await waitFor(() => expect(screen.getByRole("dialog")).toBeVisible());`),
    },
    {
      name: "a sync query for a non-popup role",
      code: test(`await user.click(trigger); screen.getByRole("button", { name: "Save" });`),
    },
    {
      name: "a popup query before any user action",
      code: test(`render(openMenu); screen.getByRole("menu");`),
    },
    {
      name: "a query passed as the action's argument once the menu has settled",
      code: test(`await user.click(trigger); await screen.findByRole("menu"); await user.click(screen.getByRole("menuitem", { name: /Plan/ }));`),
    },
    {
      name: "an action in one test does not leak into the next",
      code: `it("a", async () => { await user.click(trigger); }); it("b", () => { screen.getByRole("menu"); });`,
    },
  ],
  invalid: [
    {
      name: "the composer add menu flake",
      code: test(`await user.click(trigger); expect(trigger).toHaveAttribute("aria-haspopup", "menu"); expect(screen.getByRole("menu", { name: "Add" })).toBeVisible();`),
      errors: [{ messageId: "syncPopupQuery" }],
    },
    {
      name: "a keyboard action before a within() query",
      code: test(`await user.keyboard("{ArrowDown}"); within(root).getAllByRole("menuitem");`),
      errors: [{ messageId: "syncPopupQuery" }],
    },
    {
      name: "a later action unsettles the screen again",
      code: test(`await user.click(trigger); await screen.findByRole("menu"); await user.click(item); screen.getByRole("dialog");`),
      errors: [{ messageId: "syncPopupQuery" }],
    },
  ],
});
