import { getState, update, genId } from "../state.js";
import { rerender } from "../router.js";
import { findCp, findTask, coursesUsedBy } from "../util/lookup.js";
import { escapeAttr, escapeText } from "../util/format.js";
import { bindCollapse } from "../util/collapseMemory.js";
import { openModal } from "../util/modal.js";
import { initSearchPicker } from "../util/searchPicker.js";

export function render(root) {
  const state = getState();
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.innerHTML = `<button id="btn-add-course">+ Lisää rata</button>`;
  root.appendChild(toolbar);
  toolbar.querySelector("#btn-add-course").addEventListener("click", () => openCourseModal(null));

  for (const course of state.courses) root.appendChild(courseCard(course));
}

function courseCard(course) {
  const state = getState();
  const usedBy = coursesUsedBy(state, course.id);
  const wrap = document.createElement("details");
  wrap.className = "card course-card";
  bindCollapse(wrap, "radat-course-" + course.id);
  wrap.innerHTML = `
    <summary>
      <span class="course-name-text">${escapeText(course.name)}</span>
    </summary>
    <div class="course-header">
      <span class="course-baseline">Pohja-häröilyaika: ${course.haroilyBaselineMin} min</span>
      <span class="course-used-by">
        Käytössä: ${usedBy.length ? usedBy.map(c => `<span class="series-dot" style="background:${escapeAttr(c.color)}"></span>${escapeText(c.name)}`).join("&nbsp;&nbsp;") : "ei vielä yhdessäkään sarjassa"}
      </span>
      <div class="cat-actions">
        <button class="secondary btn-edit-course">Muokkaa</button>
        <button class="secondary btn-copy">Kopioi</button>
        <button class="icon-btn btn-del-course" title="Poista">✕</button>
      </div>
    </div>
    <div class="stop-list">
      ${course.stops.map((stop, i) => stopRowHtml(course, stop, i)).join("")}
    </div>
    <div class="toolbar" style="margin-top:0.5rem; margin-bottom:0;">
      <div class="add-stop-picker"></div>
    </div>
  `;

  wrap.querySelector(".btn-edit-course").addEventListener("click", () => {
    openCourseModal(findCourseIn(getState(), course.id));
  });
  wrap.querySelector(".btn-copy").addEventListener("click", () => {
    update(st => {
      const orig = findCourseIn(st, course.id);
      st.courses.push({
        id: genId("course"),
        name: `${orig.name} (kopio)`,
        haroilyBaselineMin: orig.haroilyBaselineMin,
        stops: structuredClone(orig.stops)
      });
    });
    rerender();
  });
  wrap.querySelector(".btn-del-course").addEventListener("click", () => {
    const inUse = coursesUsedBy(getState(), course.id);
    const msg = inUse.length
      ? `Rataa "${course.name}" käyttää ${inUse.length} sarja(a) (${inUse.map(c => c.name).join(", ")}). Poistaminen tyhjentää niiden radan valinnan. Poistetaanko silti?`
      : `Poistetaanko rata "${course.name}"?`;
    if (!confirm(msg)) return;
    update(st => {
      st.courses = st.courses.filter(c => c.id !== course.id);
      for (const cat of st.categories) if (cat.courseId === course.id) cat.courseId = "";
    });
    rerender();
  });
  initSearchPicker(wrap.querySelector(".add-stop-picker"), {
    items: () => getState().controlPoints.map(cp => ({ id: cp.id, label: cp.name })),
    placeholder: "Hae rastia lisätäksesi...",
    onPick(item) {
      update(st => {
        const cp = st.controlPoints.find(c => c.id === item.id);
        findCourseIn(st, course.id).stops.push({
          cpId: item.id, distanceM: 0,
          taskIds: [...(cp?.taskIds || [])],
          parallel: false
        });
      });
      rerender();
    }
  });

  const stopRows = wrap.querySelectorAll(".stop-row");
  course.stops.forEach((stop, i) => wireStopRow(stopRows[i], course.id, i));

  return wrap;
}

function stopRowHtml(course, stop, index) {
  const state = getState();
  const cp = findCp(state, stop.cpId);
  const cpTasks = (cp?.taskIds || []).map(id => findTask(state, id)).filter(Boolean);
  const taskBoxes = cpTasks.length
    ? cpTasks.map(task => {
        const checked = (stop.taskIds || []).includes(task.id) ? "checked" : "";
        const total = course.haroilyBaselineMin + task.haroilyMin;
        return `<label title="Häröilyaika: pohja ${course.haroilyBaselineMin} min + tehtävän lisä ${task.haroilyMin} min = ${total} min">
          <input type="checkbox" data-task-id="${escapeAttr(task.id)}" ${checked}> ${escapeText(task.name)}
        </label>`;
      }).join("")
    : `<span class="text-muted">Tällä rastilla ei ole tehtäviä</span>`;
  const overnightBadge = cp?.isSleepingCp
    ? `<span class="badge warn" title="Yörasti valitaan Rastit-välilehdellä">🌙</span>`
    : "";
  return `
    <div class="stop-row">
      <div class="stop-index">${index + 1}</div>
      <div class="stop-main">
        <div class="stop-top">
          <span class="stop-cp-name">${escapeText(cp?.name ?? "?")}</span>
          ${overnightBadge}
          <span class="stop-distance"><input class="distance" type="number" min="0" step="10" value="${stop.distanceM}"> m</span>
          <label class="stop-parallel"><input class="parallel switch" type="checkbox" ${stop.parallel ? "checked" : ""}> Rinnakkain</label>
          <span class="stop-actions">
            <button class="icon-btn btn-up" title="Siirrä ylös" ${index === 0 ? "disabled" : ""}>↑</button>
            <button class="icon-btn btn-down" title="Siirrä alas" ${index === course.stops.length - 1 ? "disabled" : ""}>↓</button>
            <button class="icon-btn btn-del-stop" title="Poista rasti">✕</button>
          </span>
        </div>
        <div class="stop-tasks">${taskBoxes}</div>
      </div>
    </div>
  `;
}

function findCourseIn(st, id) { return st.courses.find(c => c.id === id); }

function wireStopRow(row, courseId, stopIndex) {
  const distanceI = row.querySelector(".distance");
  const parallelI = row.querySelector(".parallel");
  const taskBoxes = row.querySelectorAll(".stop-tasks input[type=checkbox]");
  const upBtn = row.querySelector(".btn-up");
  const downBtn = row.querySelector(".btn-down");
  const delBtn = row.querySelector(".btn-del-stop");

  distanceI.addEventListener("input", () => {
    update(st => { findCourseIn(st, courseId).stops[stopIndex].distanceM = Math.max(0, +distanceI.value || 0); });
  });
  parallelI.addEventListener("change", () => {
    update(st => { findCourseIn(st, courseId).stops[stopIndex].parallel = parallelI.checked; });
  });
  taskBoxes.forEach(box => {
    box.addEventListener("change", () => {
      const taskId = box.dataset.taskId;
      update(st => {
        const stop = findCourseIn(st, courseId).stops[stopIndex];
        const set = new Set(stop.taskIds || []);
        if (box.checked) set.add(taskId); else set.delete(taskId);
        stop.taskIds = [...set];
      });
    });
  });
  upBtn?.addEventListener("click", () => {
    update(st => {
      const stops = findCourseIn(st, courseId).stops;
      if (stopIndex > 0) [stops[stopIndex - 1], stops[stopIndex]] = [stops[stopIndex], stops[stopIndex - 1]];
    });
    rerender();
  });
  downBtn?.addEventListener("click", () => {
    update(st => {
      const stops = findCourseIn(st, courseId).stops;
      if (stopIndex < stops.length - 1) [stops[stopIndex + 1], stops[stopIndex]] = [stops[stopIndex], stops[stopIndex + 1]];
    });
    rerender();
  });
  delBtn.addEventListener("click", () => {
    if (!confirm("Poistetaanko tämä pysähdys radalta?")) return;
    update(st => {
      findCourseIn(st, courseId).stops.splice(stopIndex, 1);
    });
    rerender();
  });
}

function openCourseModal(existingCourse) {
  const isEdit = !!existingCourse;
  const state = getState();
  const seed = isEdit ? existingCourse : (state.defaults?.course || {});
  const seedName = isEdit ? existingCourse.name : "Uusi rata";

  openModal({
    title: isEdit ? `Muokkaa rataa: ${existingCourse.name}` : "Uusi rata",
    render(body, close) {
      body.innerHTML = `
        <form id="course-form">
          <div class="row">
            <label>Nimi <input name="name" type="text" required value="${escapeAttr(seedName)}"></label>
          </div>
          <div class="row">
            <label>Pohja-häröilyaika (min) <input name="haroilyBaselineMin" type="number" min="0" value="${seed.haroilyBaselineMin ?? 0}"></label>
          </div>
          <div class="modal-actions">
            <button type="button" class="secondary" data-cancel>Peruuta</button>
            <button type="submit">Tallenna</button>
          </div>
        </form>
      `;
      const form = body.querySelector("#course-form");
      const field = (n) => form.querySelector(`[name="${n}"]`);
      form.querySelector("[data-cancel]").addEventListener("click", close);

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const values = {
          name: field("name").value.trim() || "Nimetön rata",
          haroilyBaselineMin: Math.max(0, +field("haroilyBaselineMin").value || 0)
        };
        update(st => {
          if (isEdit) Object.assign(findCourseIn(st, existingCourse.id), values);
          else st.courses.push({ id: genId("course"), ...values, stops: [] });
        });
        close();
        rerender();
      });
    }
  });
}
