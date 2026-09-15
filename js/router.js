// Hash router — singleton (only one tab set exists now that demo-a/b were
// consolidated). Views import `rerender` directly to re-render the current
// tab after a state mutation.
const DEFAULT_TAB = "rasti";
const routes = new Map();
let currentTab = null;

export function register(tab, renderFn) {
  routes.set(tab, renderFn);
}

function route() {
  const hash = window.location.hash || `#/${DEFAULT_TAB}`;
  const tab = hash.replace(/^#\//, "");
  const render = routes.get(tab) || routes.get(DEFAULT_TAB);
  currentTab = routes.has(tab) ? tab : DEFAULT_TAB;
  const view = document.getElementById("view");
  view.innerHTML = "";
  render(view);
  document.querySelectorAll(".tabs a").forEach(a => {
    a.classList.toggle("active", a.dataset.tab === currentTab);
  });
  // Header shows the current section's name instead of a static brand label.
  const activeLink = document.querySelector(`.tabs a[data-tab="${currentTab}"]`);
  const brand = document.querySelector(".brand");
  if (brand && activeLink) brand.textContent = activeLink.textContent;
}

export function start() {
  window.addEventListener("hashchange", route);
  route();
}

export function rerender() {
  if (currentTab) route();
}
