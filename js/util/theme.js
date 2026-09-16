// Light/dark toggle. index.html applies the stored choice synchronously
// (before first paint) via an inline script — this just wires the button
// and keeps its icon/label in sync from then on.
const STORAGE_KEY = "theme";

export function initTheme() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const icon = btn.querySelector(".theme-icon");

  function isDark() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  function sync() {
    const dark = isDark();
    icon.textContent = dark ? "☀" : "☾";
    btn.setAttribute("aria-label", dark ? "Vaihda vaalea teema" : "Vaihda tumma teema");
  }

  btn.addEventListener("click", () => {
    const dark = !isDark();
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem(STORAGE_KEY, dark ? "dark" : "light"); } catch (e) {}
    sync();
  });

  sync();
}
