import { getState, update, genId } from "../state.js";
import { rerender } from "../router.js";
import { findCp, findTask, coursesUsedBy } from "../util/lookup.js";
import { escapeAttr, escapeText, seedAttr } from "../util/format.js";
import { bindCollapse } from "../util/collapseMemory.js";
import { openModal } from "../util/modal.js";
import { initSearchPicker } from "../util/searchPicker.js";
import { fetchFootRoute } from "../model/route.js";
import { areasToValhalla } from "../model/area.js";
import { showToast } from "../util/demo.js";

export function render(root) {
  const state = getState();
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.innerHTML = `
    <button id="btn-add-course">+ Lisää rata</button>
    <button class="secondary" id="btn-calc-all-distances">Laske etäisyydet</button>
  `;
  root.appendChild(toolbar);
  toolbar.querySelector("#btn-add-course").addEventListener("click", () => openCourseModal(null));
  toolbar.querySelector("#btn-calc-all-distances").addEventListener("click", (e) => calcAllDistances(e.currentTarget));

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
          <span class="stop-name-group" title="${escapeAttr(cp?.name ?? "?")}">
            <span class="stop-cp-name">${escapeText(cp?.name ?? "?")}</span>
            ${overnightBadge}
          </span>
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

// Fetches the real walking distance AND path geometry (routeShape, an
// encoded polyline — see georef's Kartta tab, which draws it instead of a
// straight line between the two rastit) for every leg of every course, in
// the stops' EXISTING order — no reordering, no optimization. One request
// per leg, sent one at a time (not in parallel) to stay a reasonable
// citizen of the public Valhalla server. Legs that fail (no network,
// missing coordinates, routing error) are left with whatever distance/shape
// they already had, and are counted separately rather than aborting the
// whole run.
//
// Each stop remembers a fingerprint of the leg it was last routed for (the
// two endpoint control points' identity and coordinates, plus every enabled
// forbidden area) in `routeFetchKey`. A leg whose fingerprint still matches
// is skipped — nothing about it could have changed the route — so re-running
// this after touching one course doesn't re-fetch every other course too.
// Reordering, re-pointing, or moving a stop changes its neighbour and so its
// fingerprint, which is exactly what should force a re-fetch.
function legFingerprint(prevCp, cp, forbiddenAreas) {
  const areas = (forbiddenAreas || [])
    .filter(a => a.enabled !== false)
    .map(a => `${a.id}:${(a.ring || []).map(p => `${p.lat},${p.lng}`).join(";")}`)
    .sort()
    .join("|");
  // "v2" forces a one-time re-fetch of legs cached under the old fingerprint
  // scheme (distance only, no routeShape) so Kartta can draw the real path.
  return JSON.stringify([prevCp.id, prevCp.lat, prevCp.lng, cp.id, cp.lat, cp.lng, areas, "v2"]);
}

async function calcAllDistances(btn) {
  const state = getState();
  const legs = [];
  for (const course of state.courses) {
    for (let i = 1; i < course.stops.length; i++) {
      legs.push({ courseId: course.id, stopIndex: i });
    }
  }
  if (!legs.length) { showToast("Ei laskettavia välejä."); return; }

  // Figure out up front how many legs would actually need a network round
  // trip, so the confirmation (and the wait) reflects reality rather than
  // always warning about every leg in the file.
  const pending = legs.filter(({ courseId, stopIndex }) => {
    const course = findCourseIn(state, courseId);
    const stop = course.stops[stopIndex];
    const prevCp = findCp(state, course.stops[stopIndex - 1].cpId);
    const cp = findCp(state, stop.cpId);
    if (!prevCp || !cp || prevCp.lat == null || cp.lat == null) return false;
    return stop.routeFetchKey !== legFingerprint(prevCp, cp, state.forbiddenAreas);
  });
  if (!pending.length) { showToast("Kaikki etäisyydet ovat jo ajan tasalla."); return; }
  if (!confirm(`Haetaanko todellinen kävelyetäisyys ${pending.length} muuttuneelle välille reittipalvelusta? (${legs.length - pending.length} on jo ajan tasalla.) Rastien järjestystä ei muuteta.`)) return;

  btn.disabled = true;
  let ok = 0, failed = 0, skipped = 0, cached = 0;
  for (const { courseId, stopIndex } of legs) {
    const st0 = getState();
    const course = findCourseIn(st0, courseId);
    if (!course) continue;
    const stop = course.stops[stopIndex];
    const prevCp = findCp(st0, course.stops[stopIndex - 1].cpId);
    const cp = findCp(st0, stop.cpId);
    if (!prevCp || !cp || prevCp.lat == null || cp.lat == null) { skipped++; continue; }
    const key = legFingerprint(prevCp, cp, st0.forbiddenAreas);
    if (stop.routeFetchKey === key) { cached++; continue; }
    try {
      const { distanceM, shape } = await fetchFootRoute(prevCp, cp, { excludePolygons: areasToValhalla(st0.forbiddenAreas) });
      update(s => {
        const st = findCourseIn(s, courseId).stops[stopIndex];
        st.distanceM = Math.round(distanceM);
        st.routeShape = shape || null;
        st.routeFetchKey = key;
      });
      ok++;
    } catch {
      failed++;
    }
  }
  btn.disabled = false;
  rerender();
  const parts = [`${ok} väliä päivitetty`];
  if (cached) parts.push(`${cached} ennallaan`);
  if (failed) parts.push(`${failed} epäonnistui`);
  if (skipped) parts.push(`${skipped} ohitettu (sijainti puuttuu)`);
  showToast(parts.join(", ") + ".");
}

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
            <label>Nimi <input name="name" type="text" ${seedAttr(isEdit, seedName)}></label>
          </div>
          <div class="row">
            <label>Pohja-häröilyaika (min) <input name="haroilyBaselineMin" type="number" min="0" ${seedAttr(isEdit, seed.haroilyBaselineMin ?? 0)}></label>
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
          name: field("name").value.trim() || seedName,
          haroilyBaselineMin: Math.max(0, +field("haroilyBaselineMin").value || seed.haroilyBaselineMin || 0)
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
