// Type-to-search "pick one from a large list" input, replacing an exhaustive
// <select>/checkbox-list with search-then-select. Renders into `container`;
// `items()` is called fresh on every keystroke (not a static array) so the
// candidate set can shrink as things get picked elsewhere. Clicking or
// Enter-selecting a suggestion calls onPick(item) then clears + refocuses
// the input so the next search can start immediately.
import { escapeText } from "./format.js";

export function initSearchPicker(container, { items, placeholder = "Hae...", onPick, maxResults = 8 }) {
  container.classList.add("search-picker");
  container.innerHTML = `
    <input type="text" class="search-picker-input" placeholder="${escapeText(placeholder)}" autocomplete="off">
    <div class="search-picker-suggestions"></div>
  `;
  const input = container.querySelector(".search-picker-input");
  const box = container.querySelector(".search-picker-suggestions");
  let current = [];
  let highlighted = -1;

  function rank(label, q) {
    return label.toLowerCase().startsWith(q) ? 0 : 1;
  }

  function renderSuggestions() {
    const q = input.value.trim().toLowerCase();
    if (!q) { close(); return; }
    current = items()
      .filter(it => it.label.toLowerCase().includes(q))
      .sort((a, b) => rank(a.label, q) - rank(b.label, q) || a.label.localeCompare(b.label, "fi"))
      .slice(0, maxResults);
    if (current.length === 0) { close(); return; }
    highlighted = 0;
    box.innerHTML = current.map((it, i) => `<button type="button" class="search-picker-item" data-i="${i}">${escapeText(it.label)}</button>`).join("");
    box.classList.add("open");
    updateHighlight();
    box.querySelectorAll(".search-picker-item").forEach((btn, i) => {
      // mousedown (not click) so this fires before the input's blur would
      // otherwise close the suggestion list first.
      btn.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); });
    });
  }

  function updateHighlight() {
    box.querySelectorAll(".search-picker-item").forEach((btn, i) => btn.classList.toggle("highlighted", i === highlighted));
  }

  function pick(i) {
    const item = current[i];
    if (!item) return;
    onPick(item);
    input.value = "";
    close();
    input.focus();
  }

  function close() {
    box.classList.remove("open");
    box.innerHTML = "";
    current = [];
    highlighted = -1;
  }

  input.addEventListener("input", renderSuggestions);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (current.length) { highlighted = (highlighted + 1) % current.length; updateHighlight(); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (current.length) { highlighted = (highlighted - 1 + current.length) % current.length; updateHighlight(); }
    } else if (e.key === "Enter") {
      if (highlighted >= 0) { e.preventDefault(); pick(highlighted); }
    } else if (e.key === "Escape") {
      // Only swallow Escape when there's actually a suggestion list open to
      // dismiss — otherwise let it bubble so an enclosing modal can still
      // close on Escape as usual (first Escape closes the suggestions,
      // a second Escape closes the modal, same as most search UIs).
      if (box.classList.contains("open")) {
        e.stopPropagation();
        close();
      }
    }
  });
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) close();
  });
}
