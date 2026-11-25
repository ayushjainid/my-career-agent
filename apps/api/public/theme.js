// Sets the theme before the page draws, so there is no flash of the wrong one.
// The choice ("light", "dark", or nothing for the system setting) lives in localStorage.
(function () {
  var KEY = "mca_theme";
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  function saved() { try { return localStorage.getItem(KEY) || "system"; } catch (e) { return "system"; } }
  function apply() {
    var choice = saved();
    var theme = choice === "system" ? (mq.matches ? "dark" : "light") : choice;
    document.documentElement.setAttribute("data-theme", theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0b0d10" : "#15181d");
    return theme;
  }
  apply();
  if (mq.addEventListener) mq.addEventListener("change", function () { apply(); document.dispatchEvent(new CustomEvent("themechange")); });
  window.mcaTheme = {
    choice: saved,
    current: function () { return document.documentElement.getAttribute("data-theme"); },
    set: function (v) {
      try { if (v === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) {}
      apply();
      document.dispatchEvent(new CustomEvent("themechange"));
    },
  };
})();
