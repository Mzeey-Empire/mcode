// Runs before CSS and the app bundle so the first frame paints in the last used theme.
(function () {
  var dark = true;
  try {
    var theme = localStorage.getItem("mcode-theme");
    if (theme === "light") dark = false;
    else if (theme === "system") dark = matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {}
  document.documentElement.classList.toggle("dark", dark);
})();
