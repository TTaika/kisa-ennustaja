import { getState, update, genId } from "../state.js";
import { rerender } from "../router.js";
import { findCourse } from "../util/lookup.js";
import { escapeAttr, escapeText, minsToHHMM, hhmmToMins } from "../util/format.js";
import { bindCollapse } from "../util/collapseMemory.js";
import { openModal } from "../util/modal.js";
import { initDropdownMenu } from "../util/dropdownMenu.js";

export function render(root) {
  const state = getState();
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.innerHTML = `<button id="btn-add-cat">+ Lisää sarja</button>`;
  root.appendChild(toolbar);
  toolbar.querySelector("#btn-add-cat").addEventListener("click", () => openCatModal(null));

  for (const cat of state.categories) root.appendChild(catCard(cat));
}

function catCard(cat) {
  const state = getState();
  const course = findCourse(state, cat.courseId);
  const wrap = document.createElement("details");
  wrap.className = "card cat-card";
  bindCollapse(wrap, "sarjat-cat-" + cat.id);
  wrap.style.borderLeftColor = cat.color;
  wrap.innerHTML = `
    <summary>
      <div class="cat-header">
        <span class="cat-color-swatch" style="display:inline-block;width:1.1em;height:1.1em;border-radius:4px;background:${escapeAttr(cat.color)};border:1px solid var(--border);flex:0 0 auto;"></span>
        <span class="cat-name-text">${escapeText(cat.name)}</span>
        <div class="cat-actions dropdown-menu-wrap">
          <button type="button" class="icon-btn dropdown-menu-trigger" aria-haspopup="true" aria-expanded="false" title="Lisää" aria-label="Lisää">⋮</button>
          <div class="dropdown-menu">
            <button type="button" class="btn-copy">Kopioi</button>
            <button type="button" class="btn-del danger-item">Poista</button>
          </div>
        </div>
      </div>
    </summary>
    <div class="row" style="margin-top:0.75rem;">
      <button class="secondary btn-edit-cat">Muokkaa</button>
      <span class="text-muted" style="font-size:0.85rem;">
        Rata: ${course ? escapeText(course.name) : "— ei valittu —"} ·
        ${cat.walkSpeedKmh} km/h (${cat.fastestMultiplier}×–${cat.slowestMultiplier}×) ·
        Aloitus ${minsToHHMM(cat.startMinutes1)} ·
        ${cat.teamCount} joukkuetta, lähtöväli ${cat.teamStartIntervalMin} min
      </span>
    </div>
    <h3 class="subhead">Joukkueet</h3>
    <p class="text-muted" style="margin: 0 0 0.25rem; font-size: 0.85rem;">
      Klikkaa joukkuetta merkitäksesi sen ei-starttaavaksi / keskeyttäneeksi (DNS/DNF).
      Joukkue säilyy tiedoissa mutta ei enää kuormita rastien jonoja ennusteessa.
    </p>
    <div class="team-grid">
      ${Array.from({ length: cat.teamCount }, (_, i) => i + 1).map(n => teamChipHtml(cat, n)).join("")}
    </div>
    ${course ? `<p class="text-muted" style="font-size:0.8rem; margin: 0.75rem 0 0;">Radan pohja-häröilyaika: ${course.haroilyBaselineMin} min · ${course.stops.length} pysähdystä</p>` : ""}
  `;

  initDropdownMenu(wrap.querySelector(".dropdown-menu-trigger"), wrap.querySelector(".dropdown-menu"));

  wrap.querySelector(".btn-edit-cat").addEventListener("click", () => {
    openCatModal(findCatIn(getState(), cat.id));
  });

  wrap.querySelector(".btn-copy").addEventListener("click", () => {
    update(st => {
      const orig = findCatIn(st, cat.id);
      st.categories.push({
        ...structuredClone(orig),
        id: genId("cat"),
        name: `${orig.name} (kopio)`
      });
    });
    rerender();
  });
  wrap.querySelector(".btn-del").addEventListener("click", () => {
    if (!confirm(`Poistetaanko sarja "${cat.name}"?`)) return;
    update(st => { st.categories = st.categories.filter(c => c.id !== cat.id); });
    rerender();
  });

  wrap.querySelectorAll(".team-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const n = Number(chip.dataset.team);
      update(st => {
        const c = findCatIn(st, cat.id);
        const set = new Set(c.withdrawnTeamIndices || []);
        if (set.has(n)) set.delete(n); else set.add(n);
        c.withdrawnTeamIndices = [...set];
      });
      rerender();
    });
  });

  return wrap;
}

function findCatIn(st, id) { return st.categories.find(c => c.id === id); }

function teamChipHtml(cat, teamNumber) {
  const withdrawn = (cat.withdrawnTeamIndices || []).includes(teamNumber);
  return `<span class="team-chip ${withdrawn ? "withdrawn" : ""}" data-team="${teamNumber}">${escapeText(cat.name)} ${teamNumber}${withdrawn ? " · DNS" : ""}</span>`;
}

function openCatModal(existingCat) {
  const isEdit = !!existingCat;
  const state = getState();
  const seed = isEdit ? existingCat : (state.defaults?.category || {});
  const seedName = isEdit ? existingCat.name : "Uusi sarja";
  const seedColor = isEdit ? existingCat.color : "#4f8cff";
  const seedCourseId = isEdit ? existingCat.courseId : (state.courses[0]?.id || "");

  openModal({
    title: isEdit ? `Muokkaa sarjaa: ${existingCat.name}` : "Uusi sarja",
    render(body, close) {
      body.innerHTML = `
        <form id="cat-form">
          <div class="row">
            <label>Väri <input name="color" type="color" value="${escapeAttr(seedColor)}" style="width:3rem; padding:0.2rem;"></label>
            <label style="flex:1;">Nimi <input name="name" type="text" required value="${escapeAttr(seedName)}"></label>
          </div>
          <div class="row">
            <label style="flex:1;">Rata
              <select name="courseId">
                <option value="">— ei valittu —</option>
                ${state.courses.map(c => `<option value="${escapeAttr(c.id)}" ${c.id === seedCourseId ? "selected" : ""}>${escapeText(c.name)}</option>`).join("")}
              </select>
            </label>
          </div>
          <div class="row">
            <label>Kävelynopeus (km/h) <input name="walkSpeedKmh" type="number" step="0.1" value="${seed.walkSpeedKmh ?? 4.0}"></label>
            <label>Nopein kerroin <input name="fastestMultiplier" type="number" step="0.05" value="${seed.fastestMultiplier ?? 1.15}"></label>
            <label>Hitain kerroin <input name="slowestMultiplier" type="number" step="0.05" value="${seed.slowestMultiplier ?? 0.85}"></label>
          </div>
          <div class="row">
            <label>Tehtävien hajonta <input name="taskVariance" type="number" step="0.05" value="${seed.taskVariance ?? 0.15}"></label>
            <label>Joukkueita <input name="teamCount" type="number" min="1" value="${seed.teamCount ?? 10}"></label>
            <label>Lähtöväli (min) <input name="teamStartIntervalMin" type="number" min="0" value="${seed.teamStartIntervalMin ?? 5}"></label>
          </div>
          <div class="row">
            <label>Aloitus pv 1 <input name="startMinutes1" type="time" value="${minsToHHMM(seed.startMinutes1 ?? 540)}"></label>
            <label>Aloitus (yön jälkeen) <input name="startMinutes2" type="time" value="${minsToHHMM(seed.startMinutes2 ?? 540)}"></label>
          </div>
          <div class="modal-actions">
            <button type="button" class="secondary" data-cancel>Peruuta</button>
            <button type="submit">Tallenna</button>
          </div>
        </form>
      `;
      const form = body.querySelector("#cat-form");
      const field = (n) => form.querySelector(`[name="${n}"]`);
      form.querySelector("[data-cancel]").addEventListener("click", close);

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const newTeamCount = Math.max(1, Math.round(+field("teamCount").value || 1));
        const values = {
          name: field("name").value.trim() || "Nimetön sarja",
          color: field("color").value || "#4f8cff",
          courseId: field("courseId").value,
          walkSpeedKmh: Math.max(0, +field("walkSpeedKmh").value || 0),
          fastestMultiplier: +field("fastestMultiplier").value || 0,
          slowestMultiplier: +field("slowestMultiplier").value || 0,
          taskVariance: Math.max(0, +field("taskVariance").value || 0),
          startMinutes1: hhmmToMins(field("startMinutes1").value),
          startMinutes2: hhmmToMins(field("startMinutes2").value),
          teamCount: newTeamCount,
          teamStartIntervalMin: Math.max(0, +field("teamStartIntervalMin").value || 0)
        };
        update(st => {
          if (isEdit) {
            const c = findCatIn(st, existingCat.id);
            Object.assign(c, values);
            c.withdrawnTeamIndices = (c.withdrawnTeamIndices || []).filter(n => n <= newTeamCount);
          } else {
            st.categories.push({
              id: genId("cat"), ...values,
              taskOverrides: {}, withdrawnTeamIndices: []
            });
          }
        });
        close();
        rerender();
      });
    }
  });
}
