// A closed <details> renders no content when printed. Rather than fight the
// browser's UA rule with a CSS display:block!important override (which would
// also clobber <table>/<tr> layout for any collapsed report section), force
// every <details> open right before printing and restore prior state after.
//
// This forcing is programmatic, not a real user choice, so it's wrapped in
// collapseMemory's suppressPersistence — otherwise every print would silently
// forget the user's real collapse/expand choices.
import { suppressPersistence } from "./collapseMemory.js";

export function initPrintExpand() {
  let previouslyClosed = [];
  window.addEventListener("beforeprint", () => {
    suppressPersistence(() => {
      previouslyClosed = Array.from(document.querySelectorAll("details:not([open])"));
      previouslyClosed.forEach(d => { d.open = true; });
    });
  });
  window.addEventListener("afterprint", () => {
    suppressPersistence(() => {
      previouslyClosed.forEach(d => { d.open = false; });
      previouslyClosed = [];
    });
  });
}
