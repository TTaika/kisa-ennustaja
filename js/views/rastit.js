import { getState, update, genId } from "../state.js";
import { rerender } from "../router.js";
import { escapeAttr, escapeText, minsToHHMM, hhmmToMins } from "../util/format.js";
import { parseCoords, formatCoords } from "../model/route.js";
import { bindCollapse } from "../util/collapseMemory.js";
import { openModal } from "../util/modal.js";

export function render(root) {
  const state = getState();
  const card = document.createElement("details");
  card.className = "card";
  bindCollapse(card, "rastit-main");
  card.innerHTML = `
    <summary><h2>Rastit</h2></summary>
    <div class="toolbar">
      <button id="btn-add-cp">+ Lisää rasti</button>
    </div>
    <table class="cp-table">
      <thead>
        <tr>
          <th>Nimi</th>
          <th class="nowrap">Sijainti</th>
          <th class="nowrap">Yörasti</th>
          <th class="nowrap">Sulkeutumisaika</th>
          <th>Tehtävät</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${state.controlPoints.map(rowHtml).join("")}
      </tbody>
    </table>
  `;
  root.appendChild(card);

  card.querySelector("#btn-add-cp").addEventListener("click", () => openCpModal(null));

  const rows = card.querySelectorAll("tbody tr");
  state.controlPoints.forEach((cp, i) => wireRow(rows[i], cp.id));
}

function rowHtml(cp) {
  const taskCount = (cp.taskIds || []).length;
  const taskSummary = taskCount ? `${taskCount} tehtävää` : "Ei tehtäviä";
  const closing = cp.closingTimeMin != null ? minsToHHMM(cp.closingTimeMin) : "—";
  const coordsLabel = formatCoords({ lat: cp.lat, lng: cp.lng }) || "—";
  return `
    <tr>
      <td>${escapeText(cp.name)}</td>
      <td class="nowrap">${escapeText(coordsLabel)}</td>
      <td><span class="readonly-badge ${cp.isSleepingCp ? "on" : ""}">${cp.isSleepingCp ? "Kyllä" : "Ei"}</span></td>
      <td class="nowrap">${escapeText(closing)}</td>
      <td>${escapeText(taskSummary)}</td>
      <td class="nowrap">
        <button class="secondary btn-edit">Muokkaa</button>
        <button class="icon-btn btn-del" title="Poista">✕</button>
      </td>
    </tr>
  `;
}

function findCpIn(st, id) { return st.controlPoints.find(c => c.id === id); }

function wireRow(tr, cpId) {
  tr.querySelector(".btn-edit").addEventListener("click", () => {
    openCpModal(findCpIn(getState(), cpId));
  });

  tr.querySelector(".btn-del").addEventListener("click", () => {
    const st = getState();
    const cp = findCpIn(st, cpId);
    if (!confirm(`Poistetaanko rasti "${cp?.name}"? Tämä poistaa sen myös kaikilta radoilta, joilla se on pysähdyksenä.`)) return;
    update(s => {
      s.controlPoints = s.controlPoints.filter(c => c.id !== cpId);
      for (const course of s.courses) course.stops = course.stops.filter(stop => stop.cpId !== cpId);
    });
    rerender();
  });
}

function openCpModal(existingCp) {
  const isEdit = !!existingCp;
  const state = getState();
  const seed = isEdit ? existingCp : (state.defaults?.controlPoint || {});
  const seedName = isEdit ? existingCp.name : "Uusi rasti";
  const seedCoords = isEdit ? formatCoords({ lat: existingCp.lat, lng: existingCp.lng }) : "";
  const seedTaskIds = isEdit ? (existingCp.taskIds || []) : [];
  const seedClosing = isEdit ? existingCp.closingTimeMin : (seed.closingTimeMin ?? null);
  const seedSleeping = isEdit ? existingCp.isSleepingCp : (seed.isSleepingCp ?? false);

  openModal({
    title: isEdit ? `Muokkaa rastia: ${existingCp.name}` : "Uusi rasti",
    render(body, close) {
      const taskPicks = state.tasks.map(task => `
        <label class="task-pick">
          <input type="checkbox" data-task-id="${escapeAttr(task.id)}" ${seedTaskIds.includes(task.id) ? "checked" : ""}>
          ${escapeText(task.name)}
        </label>
      `).join("") || `<span class="text-muted">Ei tehtäviä määritelty</span>`;

      body.innerHTML = `
        <form id="cp-form">
          <div class="row">
            <label>Nimi <input name="name" type="text" required value="${escapeAttr(seedName)}"></label>
          </div>
          <div class="row">
            <label>Sijainti <input name="coords" type="text" value="${escapeAttr(seedCoords)}" placeholder="lat, lng"></label>
            <label>Sulkeutumisaika <input name="closing" type="time" value="${escapeAttr(seedClosing != null ? minsToHHMM(seedClosing) : "")}"></label>
          </div>
          <div class="row">
            <label style="flex-direction:row; align-items:center;" title="Rata jatkaa seuraavana päivänä tämän jälkeen — voit merkitä useita yörasteja pidempää kilpailua varten.">
              <input name="isSleepingCp" class="switch" type="checkbox" ${seedSleeping ? "checked" : ""}> Yörasti
            </label>
          </div>
          <div class="row">
            <label>Tehtävät
              <div class="task-picks">${taskPicks}</div>
            </label>
          </div>
          <div class="modal-actions">
            <button type="button" class="secondary" data-cancel>Peruuta</button>
            <button type="submit">Tallenna</button>
          </div>
        </form>
      `;
      const form = body.querySelector("#cp-form");
      const field = (n) => form.querySelector(`[name="${n}"]`);
      form.querySelector("[data-cancel]").addEventListener("click", close);

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const parsed = parseCoords(field("coords").value);
        const checkedTaskIds = [...form.querySelectorAll(".task-pick input[type=checkbox]:checked")].map(el => el.dataset.taskId);
        const closingVal = field("closing").value;
        const values = {
          name: field("name").value.trim() || "Nimetön rasti",
          lat: parsed ? parsed.lat : null,
          lng: parsed ? parsed.lng : null,
          closingTimeMin: closingVal === "" ? null : hhmmToMins(closingVal),
          isSleepingCp: field("isSleepingCp").checked,
          taskIds: checkedTaskIds
        };
        update(st => {
          if (isEdit) Object.assign(findCpIn(st, existingCp.id), values);
          else st.controlPoints.push({ id: genId("cp"), ...values });
        });
        close();
        rerender();
      });
    }
  });
}
