// Hash router — singleton (only one tab set exists now that demo-a/b were
// consolidated). Views import `rerender` directly to re-render the current
// tab after a state mutation.
const DEFAULT_TAB = "rasti";
const START_ROUTE = "aloitus";
const routes = new Map();
let currentTab = null;

export function register(tab, renderFn) {
  routes.set(tab, renderFn);
}

function route() {
  const hash = window.location.hash || `#/${START_ROUTE}`;
  const tab = hash.replace(/^#\//, "");
  const render = routes.get(tab) || routes.get(DEFAULT_TAB);
  currentTab = routes.has(tab) ? tab : DEFAULT_TAB;
  const view = document.getElementById("view");
  view.innerHTML = "";
  render(view);
  document.querySelectorAll(".tabs a").forEach(a => {
    a.classList.toggle("active", a.dataset.tab === currentTab);
  });
  // Header shows the current section's name instead of a static brand label —
  // except on the start screen, which has no nav link of its own.
  const activeLink = document.querySelector(`.tabs a[data-tab="${currentTab}"]`);
  const brand = document.querySelector(".brand");
  if (brand) brand.textContent = activeLink ? activeLink.textContent : "Kisa Ennustaja";
  document.body.classList.toggle("on-start", currentTab === START_ROUTE);
  // Kartta wants more horizontal room than the .view's normal reading-width
  // cap allows — a real race map is usually landscape.
  view.classList.toggle("view-wide", currentTab === "kartta");
}

export function start() {
  window.addEventListener("hashchange", route);
  route();
}

export function rerender() {
  if (currentTab) route();
}
