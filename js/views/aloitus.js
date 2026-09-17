// Start screen — shown on every launch (empty hash routes here, see
// router.js's START_ROUTE) and reachable afterwards via the topbar's home
// button. Single-project app: "latest race" is just whatever is already in
// state.js's localStorage-backed state, so "continue" is a plain navigate.
import { createEmptyRace, importJson } from "../state.js";
import { importXlsxArrayBuffer } from "../io/xlsx.js";
import { rerender } from "../router.js";

export function render(root) {
  root.appendChild(startCardHtml());
}

function startCardHtml() {
  const card = document.createElement("div");
  card.className = "card start-card";
  card.innerHTML = `
    <h1 class="start-title">Kisa Ennustaja</h1>
    <div class="start-actions">
      <button class="start-btn btn-continue">Palaa viimeisimpään kilpailuun</button>
      <button class="start-btn secondary btn-import">Tuo kilpailu</button>
      <button class="start-btn secondary btn-new">Luo uusi kilpailu</button>
      <button class="start-btn danger btn-quit">Poistu Kisa Ennustajasta</button>
    </div>
    <input class="start-file-import" type="file" accept=".json,.xlsx" style="display:none;">
  `;

  card.querySelector(".btn-continue").addEventListener("click", () => {
    window.location.hash = "#/rasti";
  });

  const fileInput = card.querySelector(".start-file-import");
  card.querySelector(".btn-import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      if (/\.json$/i.test(file.name)) {
        importJson(await file.text());
      } else {
        importXlsxArrayBuffer(await file.arrayBuffer());
      }
      window.location.hash = "#/rasti";
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      fileInput.value = "";
    }
  });

  card.querySelector(".btn-new").addEventListener("click", () => {
    if (!confirm("Nykyinen kilpailu korvataan uudella, ellet ole vienyt sitä JSON- tai XLSX-tiedostoon. Jatketaanko?")) return;
    createEmptyRace();
    window.location.hash = "#/rasti";
  });

  card.querySelector(".btn-quit").addEventListener("click", () => {
    // Only closes tabs the page itself opened via script — blocked by the
    // browser in the normal case, so fall back to a goodbye screen.
    window.close();
    renderGoodbye(card);
  });

  return card;
}

function renderGoodbye(card) {
  card.innerHTML = `
    <h1 class="start-title">Kisa Ennustaja on suljettu</h1>
    <p class="text-muted start-goodbye-text">Voit nyt sulkea tämän välilehden.</p>
    <div class="start-actions">
      <button class="start-btn secondary btn-back">Takaisin alkuun</button>
    </div>
  `;
  card.querySelector(".btn-back").addEventListener("click", rerender);
}
