// Shared popup used for creating/editing entities across every view. Caller
// supplies a title and a render(bodyEl, close) callback that builds its own
// form into bodyEl — each entity's fields differ enough that a bespoke form
// per view is simpler than a generic field-schema system. The caller calls
// close() itself after a successful save; backdrop click and Escape both
// close without saving. Only one modal is open at a time.

let activeClose = null;

export function openModal({ title, render }) {
  closeModal();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const panel = document.createElement("div");
  panel.className = "modal-panel";
  panel.innerHTML = `
    <div class="modal-header">
      <h2></h2>
      <button type="button" class="icon-btn modal-close" title="Sulje" aria-label="Sulje">✕</button>
    </div>
    <div class="modal-body"></div>
  `;
  panel.querySelector(".modal-header h2").textContent = title;
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }

  function close() {
    document.removeEventListener("keydown", onKeydown);
    backdrop.remove();
    if (activeClose === close) activeClose = null;
  }
  activeClose = close;

  document.addEventListener("keydown", onKeydown);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  panel.querySelector(".modal-close").addEventListener("click", close);

  const bodyEl = panel.querySelector(".modal-body");
  render(bodyEl, close);

  requestAnimationFrame(() => {
    bodyEl.querySelector("input, select, textarea")?.focus();
  });

  return close;
}

export function closeModal() {
  activeClose?.();
}
