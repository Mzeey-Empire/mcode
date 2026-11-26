/* Shared by the #2242 prototype pages: the purple top bar, and the theme, which carries from page to page. */
const PAGES = [["sitemap.html", "1 · Site map"], ["flows.html", "2 · Flows"], ["prototype.html", "3 · Clickable prototype"]];
const THEME_KEY = "mcode-2242-theme";
const savedTheme = () => localStorage.getItem(THEME_KEY) ?? "dark";
function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.dataset.theme = theme;
}
document.documentElement.dataset.theme = savedTheme();

/* The prototype page marks its body data-reset to get a Reset button. */
function protoTop(extra = "") {
  const here = location.pathname.split("/").pop();
  const tabs = PAGES.map(([href, label]) => `<a class="tab" href="${href}" ${href === here ? 'aria-current="page"' : ""}>${label}</a>`).join("");
  return `<nav class="proto-top" aria-label="Prototype pages"><span class="tag">PROTOTYPE</span><span class="issue">#2242 Move to project</span>${tabs}<span class="spacer"></span><button class="ghost" data-theme-toggle>Toggle light / dark</button>${extra}</nav>`;
}
document.addEventListener("click", e => {
  if (e.target.closest("[data-theme-toggle]")) setTheme(savedTheme() === "dark" ? "light" : "dark");
});
document.addEventListener("DOMContentLoaded", () => {
  const reset = document.body.hasAttribute("data-reset") ? '<button class="ghost" data-act="reset">Reset</button>' : "";
  document.body.insertAdjacentHTML("afterbegin", protoTop(reset));
});
