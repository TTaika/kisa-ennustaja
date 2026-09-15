// Generic small anchored overflow ("⋮") menu. Unlike the singleton hamburger
// nav menu, many instances of this can exist on one page at once (one per
// card), so opening one closes any others via a broadcast event.
export function initDropdownMenu(triggerEl, menuEl) {
  function close() {
    menuEl.classList.remove("open");
    triggerEl.setAttribute("aria-expanded", "false");
  }
  function open() {
    document.dispatchEvent(new CustomEvent("dropdownmenu:closeall"));
    menuEl.classList.add("open");
    triggerEl.setAttribute("aria-expanded", "true");
  }
  triggerEl.addEventListener("click", (e) => {
    // If the trigger lives inside a <summary> (e.g. a collapsible card's
    // header), a plain click would also toggle the parent <details> — stop
    // that native behavior as well as bubbling to any outer click-outside
    // listener.
    e.preventDefault();
    e.stopPropagation();
    if (menuEl.classList.contains("open")) close(); else open();
  });
  menuEl.addEventListener("click", (e) => {
    // Same <summary>-toggle guard as the trigger: a menu item click must not
    // also collapse/expand an ancestor <details> card.
    if (e.target.closest("button, a")) { e.preventDefault(); close(); }
  });
  document.addEventListener("click", (e) => {
    if (menuEl.classList.contains("open") && !menuEl.contains(e.target) && !triggerEl.contains(e.target)) {
      close();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.addEventListener("dropdownmenu:closeall", close);
  return close;
}
