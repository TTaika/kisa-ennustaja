// Hamburger-triggered nav dropdown (top-right). No-ops if the markup isn't
// present, so it's safe to call unconditionally from any bootstrap file.
export function initNavMenu() {
  const btn = document.getElementById("nav-toggle");
  const menu = document.getElementById("nav-dropdown");
  if (!btn || !menu) return;

  function close() {
    menu.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
  }
  function open() {
    menu.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("open")) close(); else open();
  });
  menu.addEventListener("click", (e) => {
    if (e.target.closest("a")) close();
  });
  document.addEventListener("click", (e) => {
    if (menu.classList.contains("open") && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      close();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}
