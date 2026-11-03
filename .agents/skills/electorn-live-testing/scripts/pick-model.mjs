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
  const trigger = scope.getByTestId("model-selector-trigger").last();
  if (!(await trigger.innerText()).includes(model)) {
    await trigger.click();
    // The picker opens in a portal, outside a locator scope.
    const page = typeof scope.page === "function" ? scope.page() : scope;
    const picker = page.getByRole("dialog", { name: "Choose model and provider" });
    await picker.getByRole("radio", { name: "Claude", exact: true }).click();
    await picker.getByRole("combobox", { name: "Search models" }).fill(model);
    await picker.getByRole("option", { name: new RegExp(`\\b${model}\\b`) }).first().click();
    await picker.waitFor({ state: "hidden" });
  }
  const label = (await trigger.innerText()).replace(/\s+/g, " ").trim();
  if (!label.includes(model)) throw new Error(`The composer shows ${label}, not ${model}`);
  return label;
}
