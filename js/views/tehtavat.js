import { getState, update, genId } from "../state.js";
import { rerender } from "../router.js";
import { escapeText, seedAttr } from "../util/format.js";
import { openModal } from "../util/modal.js";

export function render(root) {
  const state = getState();
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `
    <div class="toolbar">
      <button id="btn-add-task">+ Lisää tehtävä</button>
    </div>
    <table class="cp-table">
      <thead>
        <tr>
          <th>Nimi</th>
          <th class="nowrap">Suorituspaikkoja</th>
          <th class="nowrap">Nopein (min)</th>
          <th class="nowrap">Hitain (min)</th>
          <th class="nowrap">Häröily-lisä (min)</th>
          <th>Rastit</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${state.tasks.map(rowHtml).join("")}
      </tbody>
    </table>
  `;
  root.appendChild(card);

  card.querySelector("#btn-add-task").addEventListener("click", () => openTaskModal(null));

  const rows = card.querySelectorAll("tbody tr");
  state.tasks.forEach((task, i) => wireRow(rows[i], task.id));
}

function rowHtml(task) {
  const state = getState();
  const cps = state.controlPoints.filter(cp => (cp.taskIds || []).includes(task.id));
  const cpLabel = cps.length ? cps.map(cp => escapeText(cp.name)).join(", ") : "Ei rasteja";
  const slotsLabel = task.unlimitedSlots ? "Rajaton" : String(task.slots);
  return `
    <tr>
      <td>${escapeText(task.name)}</td>
      <td>${slotsLabel}</td>
      <td>${task.fastestTaskMin}</td>
      <td>${task.slowestTaskMin}</td>
      <td>${task.haroilyMin}</td>
      <td class="nowrap">${cpLabel}</td>
      <td class="nowrap">
        <button class="secondary btn-edit">Muokkaa</button>
        <button class="icon-btn btn-del" title="Poista">✕</button>
      </td>
    </tr>
  `;
}

function findTaskIn(st, id) { return st.tasks.find(t => t.id === id); }

function wireRow(tr, taskId) {
  tr.querySelector(".btn-edit").addEventListener("click", () => {
    const task = findTaskIn(getState(), taskId);
    openTaskModal(task);
  });

  tr.querySelector(".btn-del").addEventListener("click", () => {
    const st = getState();
    const task = findTaskIn(st, taskId);
    if (!confirm(`Poistetaanko tehtävä "${task?.name}"? Tämä poistaa sen myös kaikilta rasteilta ja radoilta, joilla se on käytössä.`)) return;
    update(s => {
      s.tasks = s.tasks.filter(t => t.id !== taskId);
      for (const cp of s.controlPoints) cp.taskIds = (cp.taskIds || []).filter(id => id !== taskId);
      for (const course of s.courses) {
        for (const stop of course.stops) stop.taskIds = (stop.taskIds || []).filter(id => id !== taskId);
      }
      for (const cat of s.categories) {
        if (cat.taskOverrides && taskId in cat.taskOverrides) delete cat.taskOverrides[taskId];
      }
    });
    rerender();
  });
}

function openTaskModal(existingTask) {
  const isEdit = !!existingTask;
  const state = getState();
  const seed = isEdit ? existingTask : (state.defaults?.task || {});
  const seedName = isEdit ? existingTask.name : "Uusi tehtävä";

  openModal({
    title: isEdit ? `Muokkaa tehtävää: ${existingTask.name}` : "Uusi tehtävä",
    render(body, close) {
      body.innerHTML = `
        <form id="task-form">
          <div class="row">
            <label>Nimi <input name="name" type="text" ${seedAttr(isEdit, seedName)}></label>
          </div>
          <div class="row">
            <label>Suorituspaikkoja <input name="slots" type="number" min="1" ${seedAttr(isEdit, seed.slots ?? 1)} ${seed.unlimitedSlots ? "disabled" : ""}></label>
            <label style="flex-direction:row; align-items:center;"><input name="unlimitedSlots" class="switch" type="checkbox" ${seed.unlimitedSlots ? "checked" : ""}> Rajaton</label>
          </div>
          <div class="row">
            <label>Nopein (min) <input name="fastestTaskMin" type="number" min="0" ${seedAttr(isEdit, seed.fastestTaskMin ?? 10)}></label>
            <label>Hitain (min) <input name="slowestTaskMin" type="number" min="0" ${seedAttr(isEdit, seed.slowestTaskMin ?? 20)}></label>
            <label>Häröily-lisä (min) <input name="haroilyMin" type="number" min="0" ${seedAttr(isEdit, seed.haroilyMin ?? 0)}></label>
          </div>
          <div class="modal-actions">
            <button type="button" class="secondary" data-cancel>Peruuta</button>
            <button type="submit">Tallenna</button>
          </div>
        </form>
      `;
      const form = body.querySelector("#task-form");
      const field = (n) => form.querySelector(`[name="${n}"]`);
      const slotsI = field("slots"), unlimitedI = field("unlimitedSlots");
      unlimitedI.addEventListener("change", () => { slotsI.disabled = unlimitedI.checked; });
      form.querySelector("[data-cancel]").addEventListener("click", close);

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const values = {
          name: field("name").value.trim() || seedName,
          slots: Math.max(1, Math.round(+field("slots").value || seed.slots || 1)),
          unlimitedSlots: unlimitedI.checked,
          fastestTaskMin: Math.max(0, +field("fastestTaskMin").value || seed.fastestTaskMin || 0),
          slowestTaskMin: Math.max(0, +field("slowestTaskMin").value || seed.slowestTaskMin || 0),
          haroilyMin: Math.max(0, +field("haroilyMin").value || seed.haroilyMin || 0)
        };
        update(st => {
          if (isEdit) Object.assign(findTaskIn(st, existingTask.id), values);
          else st.tasks.push({ id: genId("task"), ...values });
        });
        close();
        rerender();
      });
    }
  });
}
