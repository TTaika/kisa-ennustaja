// Demo-phase chrome: every button/action that would eventually mutate real
// state just shows a toast instead. Event delegation on document means view
// modules don't need to wire a listener per button — tag the element with
// data-demo-action="<toast message>" and it's handled here, once.

let toastEl = null;
let toastTimer = null;

export function initDemoChrome() {
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-demo-action]");
    if (!el) return;
    e.preventDefault();
    showToast(el.dataset.demoAction || "Demo-tila – ei vielä kytketty taustaan.");
  });
}

export function showToast(msg) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "demo-toast";
    toastEl.className = "demo-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}
