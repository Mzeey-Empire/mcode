/** Test turns run only on these models, because larger ones cost too much for exploratory runs. */
const TEST_MODELS = ["Haiku", "Sonnet"];

/**
 * Selects a Claude model in the composer's model picker before a test turn and returns the
 * picker's label. Pass the page, or a locator that holds one composer when several are open.
 * Throws when the composer ends up on any model other than Haiku or Sonnet.
 */
export async function pickModel(scope, { model = "Haiku" } = {}) {
  if (!TEST_MODELS.includes(model)) {
    throw new Error(`Test turns run on ${TEST_MODELS.join(" or ")}, not ${model}`);
  }
  // The visible text hides at narrow composer widths, so read the part's "Model: <name>" label instead.
  const trigger = scope.locator('[data-capsule-part="model"]').last();
  if (!(await trigger.getAttribute("aria-label")).includes(model)) {
    await trigger.click();
    // The picker opens in a portal, outside a locator scope.
    const page = typeof scope.page === "function" ? scope.page() : scope;
    const picker = page.getByRole("dialog", { name: "Choose model and provider" });
    await picker.getByRole("radio", { name: "Claude", exact: true }).click();
    await picker.getByRole("combobox", { name: "Search models" }).fill(model);
    await picker.getByRole("option", { name: new RegExp(`\\b${model}\\b`) }).first().click();
    // A model with reasoning settings keeps the popup open on them.
    if (await picker.isVisible()) await page.keyboard.press("Escape");
    await picker.waitFor({ state: "hidden" });
  }
  const label = await trigger.getAttribute("aria-label");
  if (!label.includes(model)) throw new Error(`The composer shows ${label}, not ${model}`);
  return label;
}
