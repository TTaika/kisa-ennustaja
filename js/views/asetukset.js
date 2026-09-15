import { getState, update, resetToDefaults, exportFileName, exportJson, importJson } from "../state.js";
import { exportXlsxArray, importXlsxArrayBuffer } from "../io/xlsx.js";
import { teamFitness } from "../model/simulate.js";
import { rerender } from "../router.js";
import { escapeAttr } from "../util/format.js";
import { bindCollapse } from "../util/collapseMemory.js";

const PREVIEW_TEAM_COUNT = 12;

export function render(root) {
  root.appendChild(raceCardHtml());
  root.appendChild(simulationCardHtml());
  root.appendChild(displayCardHtml());
  root.appendChild(dataCardHtml());
}

function raceCardHtml() {
  const state = getState();
  const card = document.createElement("details");
  card.className = "card";
  bindCollapse(card, "asetukset-race");
  const hasLogo = !!state.race.logo;
  card.innerHTML = `
    <summary><h2>Kilpailun perustiedot</h2></summary>
    <div class="row">
      <label>Nimi <input class="f-name" type="text" value="${escapeAttr(state.race.name)}"></label>
      <label>Aloituspäivä <input class="f-date" type="date" value="${escapeAttr(state.race.startDateISO)}"></label>
    </div>
    <div class="row" style="margin-top:0.75rem; align-items:center;">
      <label>Logo <input class="f-logo" type="file" accept="image/*"></label>
      <div class="logo-preview">${hasLogo ? `<img class="logo-preview-img" src="${escapeAttr(state.race.logo)}" alt="Logo">` : `<span class="text-muted">(Ei logoa)</span>`}</div>
    </div>
    <p class="text-muted" style="font-size:0.85rem; margin:0.4rem 0 0;">Logo näkyy jokaisen Ennuste-tulosteen ylälaidassa.</p>
  `;
  card.querySelector(".f-name").addEventListener("input", (e) => update(st => { st.race.name = e.target.value; }));
  card.querySelector(".f-date").addEventListener("change", (e) => update(st => { st.race.startDateISO = e.target.value; }));
  card.querySelector(".f-logo").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      update(st => { st.race.logo = reader.result; });
      rerender();
    };
    reader.readAsDataURL(file);
  });
  return card;
}

function simulationCardHtml() {
  const state = getState();
  const sim = state.simulation;
  const card = document.createElement("details");
  card.className = "card";
  bindCollapse(card, "asetukset-simulation");
  card.innerHTML = `
    <summary><h2>Simulaatio</h2></summary>
    <div class="sim-grid">
      <div>
        <div class="sim-toggles">
          <label title="Kun valittu, jokainen tehtävä toimii kuin rajaton — kukaan ei jonota.">
            <input class="f-disable-queue switch" type="checkbox" ${sim.disableQueueing ? "checked" : ""}> Poista jonotuksen mallinnus käytöstä
          </label>
          <label title="Kun valittu, yöhön viimeisenä saapunut joukkue lähtee aamulla ensimmäisenä.">
            <input class="f-reverse-overnight switch" type="checkbox" ${sim.reverseOvernightOrder ? "checked" : ""}> Käänteinen lähtöjärjestys
          </label>
        </div>
        <div class="sim-controls">
          <span class="control-label">Kuntokäyrä</span>
          <select id="f-curve">
            <option value="normal" ${sim.fitnessCurve === "normal" ? "selected" : ""}>Normaali jakauma</option>
            <option value="linear" ${sim.fitnessCurve === "linear" ? "selected" : ""}>Tasainen / lineaarinen</option>
            <option value="power" ${sim.fitnessCurve === "power" ? "selected" : ""}>Vinokäyrä (potenssi)</option>
          </select>
          <span class="control-label">Käyrän voimakkuus</span>
          <div style="display:flex; align-items:center; gap:0.6rem;">
            <input id="f-sharpness" type="range" min="0.3" max="3.0" step="0.1" value="${sim.fitnessSharpness}" style="flex:1;">
            <span id="sharpness-value" style="min-width:2.2rem; text-align:right; font-variant-numeric:tabular-nums;">${sim.fitnessSharpness.toFixed(1)}</span>
          </div>
        </div>
      </div>
      <div>
        <p class="sim-preview-caption">Esimerkki: ${PREVIEW_TEAM_COUNT} joukkuetta sijoiteltuna hitaimmasta nopeimpaan.</p>
        <svg id="curve-preview" viewBox="0 0 320 70" width="320" height="70" style="background:var(--bg-input); border:1px solid var(--border); border-radius:4px;">
          <line x1="20" y1="40" x2="300" y2="40" stroke="var(--border)" stroke-width="1"></line>
          <text x="20" y="62" fill="var(--fg-muted)" font-size="10" text-anchor="middle">hitain</text>
          <text x="300" y="62" fill="var(--fg-muted)" font-size="10" text-anchor="middle">nopein</text>
          <g id="team-dots"></g>
        </svg>
      </div>
    </div>
  `;
  card.querySelector(".f-disable-queue").addEventListener("change", (e) => update(st => { st.simulation.disableQueueing = e.target.checked; }));
  card.querySelector(".f-reverse-overnight").addEventListener("change", (e) => update(st => { st.simulation.reverseOvernightOrder = e.target.checked; }));

  const dotsEl = card.querySelector("#team-dots");
  const curveSel = card.querySelector("#f-curve");
  const sharpInput = card.querySelector("#f-sharpness");
  const sharpVal = card.querySelector("#sharpness-value");
  function redraw() {
    const curve = curveSel.value, sharpness = Number(sharpInput.value);
    const dots = [];
    for (let i = 0; i < PREVIEW_TEAM_COUNT; i++) {
      const f = teamFitness(i, PREVIEW_TEAM_COUNT, curve, sharpness);
      const x = 20 + f * 280;
      const hue = Math.round(220 - 140 * f);
      dots.push(`<circle cx="${x.toFixed(1)}" cy="40" r="6" fill="hsl(${hue},70%,60%)" opacity="0.85" stroke="rgba(0,0,0,0.35)"></circle>`);
    }
    dotsEl.innerHTML = dots.join("");
  }
  curveSel.addEventListener("change", () => {
    sharpInput.disabled = curveSel.value === "linear";
    update(st => { st.simulation.fitnessCurve = curveSel.value; });
    redraw();
  });
  sharpInput.addEventListener("input", () => {
    sharpVal.textContent = Number(sharpInput.value).toFixed(1);
    update(st => { st.simulation.fitnessSharpness = Number(sharpInput.value); });
    redraw();
  });
  sharpInput.disabled = sim.fitnessCurve === "linear";
  redraw();
  return card;
}

function displayCardHtml() {
  const state = getState();
  const d = state.display || { showDayPrefix: true, showLogo: true };
  const card = document.createElement("details");
  card.className = "card";
  bindCollapse(card, "asetukset-display");
  card.innerHTML = `
    <summary><h2>Näyttö</h2></summary>
    <div class="row" style="flex-direction:column; align-items:flex-start; gap:0.5rem;">
      <label><input class="f-day-prefix switch" type="checkbox" ${d.showDayPrefix ? "checked" : ""}> Näytä viikonpäivä (esim. Lauantai) toisen päivän ajoille</label>
      <label><input class="f-show-logo switch" type="checkbox" ${d.showLogo ? "checked" : ""}> Näytä logo Ennuste-tulosteilla</label>
    </div>
  `;
  card.querySelector(".f-day-prefix").addEventListener("change", (e) => update(st => { st.display.showDayPrefix = e.target.checked; }));
  card.querySelector(".f-show-logo").addEventListener("change", (e) => { update(st => { st.display.showLogo = e.target.checked; }); rerender(); });
  return card;
}

function dataCardHtml() {
  const state = getState();
  const filename = exportFileName();
  const card = document.createElement("details");
  card.className = "card";
  bindCollapse(card, "asetukset-data");
  card.innerHTML = `
    <summary><h2>Tiedot</h2></summary>
    <p class="text-muted" style="margin-top:0;">Tallennustiedosto nimetään kilpailun nimen ja päivämäärän mukaan.</p>
    <p><strong>Tiedostonimi:</strong> <code>${escapeAttr(filename)}</code></p>
    <div class="toolbar">
      <button class="btn-save-json">Tallenna JSON</button>
      <button class="secondary btn-export-xlsx">Vie XLSX</button>
      <button class="secondary btn-import">Tuo tiedosto</button>
      <input class="file-import" type="file" accept=".json,.xlsx" style="display:none;">
      <button class="danger btn-reset" style="margin-left:auto;">Palauta oletukset</button>
    </div>
  `;

  card.querySelector(".btn-save-json").addEventListener("click", () => {
    downloadBlob(new Blob([exportJson()], { type: "application/json" }), exportFileName());
  });
  card.querySelector(".btn-export-xlsx").addEventListener("click", () => {
    try {
      const arr = exportXlsxArray();
      const name = exportFileName().replace(/\.json$/i, ".xlsx");
      downloadBlob(new Blob([arr], { type: "application/octet-stream" }), name);
    } catch (err) {
      alert(err.message || String(err));
    }
  });
  const fileInput = card.querySelector(".file-import");
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
      rerender();
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      fileInput.value = "";
    }
  });
  card.querySelector(".btn-reset").addEventListener("click", () => {
    if (!confirm("Palautetaanko kaikki tiedot oletusarvoihin? Tämä ei voi peruuttaa.")) return;
    resetToDefaults();
    rerender();
  });

  return card;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
