// Ennuste: on-screen bottleneck ranking + closing-time alert (new in v2, no
// v1 equivalent — kept print-hidden) PLUS a printable report structurally
// matching v1's tulostus.js (master summary, per-day CP occupancy timeline,
// per-category schedule, task-times page). Every section is driven by one
// real simulateRace() call — no more mock/estimated numbers.
import { getState } from "../state.js";
import { simulateRace } from "../model/simulate.js";
import { findCp, findTask, findCourse } from "../util/lookup.js";
import { escapeText, escapeAttr, fmtTime, fmtDuration, weekdayLabel } from "../util/format.js";
import { bindCollapse } from "../util/collapseMemory.js";

const DAY_MIN = 1440;
const SMOOTH_WINDOW_MIN = 31;
const RAMP_STEPS = 4;
const GRADIENT_STOPS = 64;

export function render(root) {
  const state = getState();
  const { teams, taskStats } = simulateRace(state.controlPoints, state.tasks, state.courses, state.categories, state.simulation);
  const rows = taskStats.map(withNames.bind(null, state));

  root.appendChild(toolbarHtml());

  const breaches = closingTimeBreaches(state, taskStats);
  if (breaches.length) {
    const banner = document.createElement("div");
    banner.className = "alert-banner print-hide";
    banner.innerHTML = `
      <span class="alert-icon">⚠</span>
      <div>
        ${breaches.map(b => `<div><strong>${escapeText(b.cp.name)}</strong> — viimeinen arvioitu saapuminen ${fmtTime(b.lastArrivalMin, state.race.startDateISO)}, sulkeutuu ${fmtTime(b.cp.closingTimeMin, state.race.startDateISO)}. Rasti ylittyy noin ${fmtDuration(b.lastArrivalMin - b.cp.closingTimeMin)}.</div>`).join("")}
      </div>
    `;
    root.appendChild(banner);
  }

  root.appendChild(bottleneckCardHtml(rows));

  // ---- v1-parity printable report, driven by the real simulateRace() output ----
  const schedules = state.categories.map(cat => realCategorySchedule(state, cat, teams, taskStats));
  root.appendChild(renderMasterPage(state, taskStats));
  for (const page of renderCpTimelinePages(state, teams)) root.appendChild(page);
  for (const sched of schedules) root.appendChild(renderSarjaPage(state, sched));
  root.appendChild(renderTaskTimesPage(state));
}

function closingTimeBreaches(state, taskStats) {
  const lastArrivalByCp = new Map();
  for (const ts of taskStats) {
    if (ts.lastArrivalMin == null) continue;
    const prev = lastArrivalByCp.get(ts.cpId);
    if (prev == null || ts.lastArrivalMin > prev) lastArrivalByCp.set(ts.cpId, ts.lastArrivalMin);
  }
  const out = [];
  for (const cp of state.controlPoints) {
    if (cp.closingTimeMin == null) continue;
    const lastArrivalMin = lastArrivalByCp.get(cp.id);
    if (lastArrivalMin != null && lastArrivalMin > cp.closingTimeMin) out.push({ cp, lastArrivalMin });
  }
  return out;
}

function toolbarHtml() {
  const wrap = document.createElement("div");
  wrap.className = "toolbar print-hide";
  wrap.innerHTML = `<button onclick="window.print()">Tulosta PDF</button>`;
  return wrap;
}

function withNames(state, r) {
  return { ...r, cp: findCp(state, r.cpId), task: findTask(state, r.taskId) };
}

function severityClass(worstWaitMin) {
  if (worstWaitMin >= 25) return "sev-high";
  if (worstWaitMin >= 10) return "sev-mid";
  return "sev-low";
}

function bottleneckCardHtml(rows) {
  const card = document.createElement("details");
  card.className = "card print-hide";
  bindCollapse(card, "ennuste-bottleneck");
  const ranked = rows.slice().sort((a, b) => (b.worstWaitMin - a.worstWaitMin) || (b.peakWaiting - a.peakWaiting)).filter(r => r.peakWaiting > 0);
  card.innerHTML = `
    <summary><h2>Pullonkaulat</h2></summary>
    <ul class="bottleneck-list">
      ${ranked.length ? ranked.slice(0, 3).map((r, i) => bottleneckItemHtml(r, i + 1)).join("") : `<li class="text-muted">Ei jonoja tässä ennusteessa.</li>`}
    </ul>
  `;
  return card;
}

function bottleneckItemHtml(r, rank) {
  const breached = r.cp.closingTimeMin != null && r.lastArrivalMin > r.cp.closingTimeMin;
  return `
    <li class="bottleneck-item ${severityClass(r.worstWaitMin)}">
      <span class="rank">${rank}.</span>
      <div class="bn-main">
        <div class="bn-name">${escapeText(r.cp.name)} — ${escapeText(r.task.name)} ${breached ? '<span class="badge danger">sulkeutumisaika ylittyy</span>' : ""}</div>
        <div class="bn-sub">Jonohuippu ${r.peakWaiting} joukkuetta · ${r.unlimitedSlots ? "rajaton kapasiteetti" : `${r.slots} suorituspaikkaa`}</div>
      </div>
      <div class="bn-severity">${fmtDuration(r.worstWaitMin)}</div>
    </li>
  `;
}

function logoBlock(state) {
  const showLogo = !!state.display?.showLogo;
  return (showLogo && state.race?.logo)
    ? `<div class="print-logo"><img src="${escapeAttr(state.race.logo)}" alt="Logo"></div>`
    : ``;
}

// ── Real per-category schedule, built from simulateRace()'s teams[] ────────
// firstArrive/lastArrive/firstLeave/lastLeave are the min/max across every
// (non-withdrawn) team of this category that actually visited that
// (cp, task) — not an average-pace estimate. worstWaitMin is pulled from the
// global taskStats (not recomputed per-category): a station's slots are
// shared across every category that visits it, so its worst wait is
// legitimately a station property, matching how the simulator itself models it.
function realCategorySchedule(state, cat, teams, taskStats) {
  const course = findCourse(state, cat.courseId);
  if (!course) return { cat, course: null, rows: [] };
  const catTeams = teams.filter(t => t.catId === cat.id);

  const rows = [];
  for (const stop of course.stops) {
    const cp = findCp(state, stop.cpId);
    if (!cp) continue;
    const taskIdsAtStop = stop.taskIds || [];
    if (taskIdsAtStop.length === 0) {
      rows.push({ cp, task: null, distanceM: stop.distanceM, firstArrive: null, lastArrive: null, firstLeave: null, lastLeave: null, worstWaitMin: 0, overnight: cp.isSleepingCp });
      continue;
    }
    for (const taskId of taskIdsAtStop) {
      const task = findTask(state, taskId);
      if (!task) continue;
      let firstArrive = Infinity, lastArrive = -Infinity, firstLeave = Infinity, lastLeave = -Infinity, any = false;
      for (const team of catTeams) {
        const st = team.stops.find(s => s.cpId === stop.cpId && s.taskId === taskId);
        if (!st) continue;
        any = true;
        if (st.arriveMin < firstArrive) firstArrive = st.arriveMin;
        if (st.arriveMin > lastArrive) lastArrive = st.arriveMin;
        if (st.leaveMin < firstLeave) firstLeave = st.leaveMin;
        if (st.leaveMin > lastLeave) lastLeave = st.leaveMin;
      }
      const ts = taskStats.find(x => x.cpId === stop.cpId && x.taskId === taskId);
      rows.push({
        cp, task, distanceM: stop.distanceM,
        firstArrive: any ? firstArrive : null, lastArrive: any ? lastArrive : null,
        firstLeave: any ? firstLeave : null, lastLeave: any ? lastLeave : null,
        worstWaitMin: ts?.worstWaitMin ?? 0,
        overnight: cp.isSleepingCp
      });
    }
  }
  return { cat, course, rows };
}

// ── Master summary page ─────────────────────────────────────────────────
function renderMasterPage(state, taskStats) {
  const page = document.createElement("details");
  page.className = "card print-page";
  bindCollapse(page, "ennuste-master");

  let rowNumber = 0;
  const rowsHtml = [];
  for (const cp of state.controlPoints) {
    if ((cp.taskIds || []).length === 0) {
      rowsHtml.push(masterRowHtml(state, ++rowNumber, cp, null, "—", null, null, null, null, 0));
      continue;
    }
    for (const taskId of cp.taskIds) {
      const task = findTask(state, taskId);
      if (!task) continue;
      const m = taskStats.find(r => r.cpId === cp.id && r.taskId === taskId);
      const slots = task.unlimitedSlots ? "Rajaton" : String(task.slots ?? 1);
      rowsHtml.push(masterRowHtml(state, ++rowNumber, cp, task, slots, m?.firstArrivalMin, m?.lastArrivalMin, m?.firstLeaveMin, m?.lastLeaveMin, m?.worstWaitMin || 0));
    }
  }

  const totalTeams = state.categories.reduce((s, c) => s + c.teamCount, 0);
  const sarjaCount = state.categories.length;
  const sarjaLista = state.categories.map(c => `${escapeText(c.name)} (${c.teamCount})`).join(", ");
  const earliestStart = sarjaCount ? Math.min(...state.categories.map(c => c.startMinutes1)) : null;
  const latestStart = sarjaCount ? Math.max(...state.categories.map(c => c.startMinutes1)) : null;

  page.innerHTML = `
    <summary><h2>Yhteenveto</h2></summary>
    <header class="print-header">
      <div class="print-title">
        <div class="print-race">${escapeText(state.race.name || "Kilpailu")}</div>
        <h1>Yhteenveto</h1>
      </div>
      ${logoBlock(state)}
      <div class="print-meta">
        <div><strong>${totalTeams}</strong> joukkuetta yhteensä</div>
        <div><strong>${sarjaCount}</strong> sarjaa</div>
        <div>Aikaisin lähtö: <strong>${earliestStart == null ? "—" : fmtTime(earliestStart, state.race.startDateISO)}</strong></div>
        <div>Viimeisin lähtö: <strong>${latestStart == null ? "—" : fmtTime(latestStart, state.race.startDateISO)}</strong></div>
        <div>Sarjat: <strong>${sarjaLista}</strong></div>
        <div></div>
      </div>
    </header>
    <table class="print-table">
      <thead>
        <tr>
          <th>#</th><th>Rasti</th><th>Tehtävä</th><th class="nowrap">Suorituspaikat</th>
          <th class="nowrap">Ensimm. saapuu</th><th class="nowrap">Viim. saapuu</th>
          <th class="nowrap">Ensimm. lähtee</th><th class="nowrap">Viim. lähtee</th>
          <th class="nowrap">Pahin odotus</th>
        </tr>
      </thead>
      <tbody>${rowsHtml.join("")}</tbody>
    </table>
  `;
  return page;
}

function masterRowHtml(state, num, cp, task, slots, firstArrive, lastArrive, firstLeave, lastLeave, maxWait) {
  const overnight = cp.isSleepingCp;
  return `
    <tr class="${overnight ? "overnight" : ""}">
      <td>${num}</td>
      <td>${escapeText(cp.name)}${overnight ? ' <span class="overnight-tag">YÖ</span>' : ""}</td>
      <td>${task ? escapeText(task.name) : "—"}</td>
      <td class="nowrap">${escapeText(slots)}</td>
      <td class="nowrap">${firstArrive == null ? "—" : fmtTime(firstArrive, state.race.startDateISO)}</td>
      <td class="nowrap">${lastArrive == null ? "—" : fmtTime(lastArrive, state.race.startDateISO)}</td>
      <td class="nowrap">${firstLeave == null ? "—" : fmtTime(firstLeave, state.race.startDateISO)}</td>
      <td class="nowrap">${lastLeave == null ? "—" : fmtTime(lastLeave, state.race.startDateISO)}</td>
      <td class="nowrap">${Math.round(maxWait || 0)}</td>
    </tr>
  `;
}

// ── Rastien aikataulu (per-day CP occupancy timeline) ───────────────────
// Ported from v1's tulostus.js sweep/smooth/ramp algorithm. Presence
// intervals now come from real per-team stops instead of a category-level
// average-pace estimate.

function collectCpPresenceFromTeams(teams) {
  const byCp = new Map();
  for (const team of teams) {
    let run = null;
    for (const st of team.stops) {
      if (run && run.cpId === st.cpId) {
        run.start = Math.min(run.start, st.arriveMin);
        run.end = Math.max(run.end, st.leaveMin);
        continue;
      }
      if (run) pushPresence(byCp, run);
      run = { cpId: st.cpId, start: st.arriveMin, end: st.leaveMin, weight: 1 };
    }
    if (run) pushPresence(byCp, run);
  }
  return byCp;
}

function pushPresence(byCp, run) {
  if (!byCp.has(run.cpId)) byCp.set(run.cpId, []);
  byCp.get(run.cpId).push({ start: run.start, end: Math.max(run.end, run.start + 1), weight: run.weight });
}

function occupancySegments(intervals, from, to) {
  const deltas = new Map();
  for (const iv of intervals) {
    const start = Math.max(iv.start, from);
    const end = Math.min(iv.end, to);
    if (end <= start) continue;
    deltas.set(start, (deltas.get(start) || 0) + iv.weight);
    deltas.set(end, (deltas.get(end) || 0) - iv.weight);
  }
  const times = [...deltas.keys()].sort((a, b) => a - b);
  const segs = [];
  let count = 0;
  for (let i = 0; i < times.length; i++) {
    count += deltas.get(times[i]);
    const next = times[i + 1];
    if (next == null || next <= times[i]) continue;
    segs.push({ start: times[i], end: next, count });
  }
  return segs;
}

function dayWindowStart(presenceByCp, dayStart, dayEnd) {
  let first = Infinity;
  for (const intervals of presenceByCp.values()) {
    for (const iv of intervals) {
      if (iv.start >= dayStart && iv.start < dayEnd && iv.start < first) first = iv.start;
      if (iv.end > dayStart && iv.end < dayEnd && iv.end < first) first = iv.end;
    }
  }
  return Number.isFinite(first) ? first : dayStart;
}

function buildDayModel(state, day, presenceByCp) {
  const dayStart = day * DAY_MIN;
  const dayEnd = dayStart + DAY_MIN;
  const windowStart = dayWindowStart(presenceByCp, dayStart, dayEnd);
  const rows = [];
  for (const cp of state.controlPoints) {
    const intervals = presenceByCp.get(cp.id);
    if (!intervals) continue;
    const segs = occupancySegments(intervals, windowStart, dayEnd);
    if (segs.length === 0) continue;
    const openMin = segs[0].start;
    const closeMin = segs[segs.length - 1].end;
    let peak = 0;
    for (const seg of segs) if (seg.count > peak) peak = seg.count;
    rows.push({
      cp, openMin, closeMin, peak, curve: smoothOccupancy(segs, openMin, closeMin),
      clipStart: intervals.some(iv => iv.start < windowStart && iv.end > windowStart),
      clipEnd: intervals.some(iv => iv.end > dayEnd && iv.start < dayEnd),
    });
  }
  return { day, dayStart, dayEnd, rows };
}

function smoothOccupancy(segs, openMin, closeMin) {
  const n = Math.max(1, Math.round(closeMin - openMin));
  const raw = new Float64Array(n);
  for (const seg of segs) {
    const from = Math.max(0, Math.round(seg.start - openMin));
    const to = Math.min(n, Math.round(seg.end - openMin));
    for (let i = from; i < to; i++) raw[i] = seg.count;
  }
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + raw[i];
  const half = Math.floor(SMOOTH_WINDOW_MIN / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(n, i + half + 1);
    out[i] = (prefix[to] - prefix[from]) / (to - from);
  }
  return out;
}

function rampColor(value, peak) {
  if (value <= 0.02) return "var(--occ-0)";
  const p = value < 1 ? value : 1 + Math.min(1, (value - 1) / Math.max(1e-6, peak - 1)) * (RAMP_STEPS - 1);
  const i = Math.max(0, Math.min(RAMP_STEPS - 1, Math.floor(p)));
  const f = p - i;
  if (f < 0.02) return `var(--occ-${i})`;
  if (f > 0.98) return `var(--occ-${i + 1})`;
  return `color-mix(in srgb, var(--occ-${i}) ${Math.round((1 - f) * 100)}%, var(--occ-${i + 1}))`;
}

function barGradient(curve, peak) {
  const n = curve.length;
  const stopCount = Math.max(2, Math.min(GRADIENT_STOPS, n));
  const stops = [];
  for (let k = 0; k < stopCount; k++) {
    const frac = k / (stopCount - 1);
    const value = curve[Math.round(frac * (n - 1))];
    stops.push(`${rampColor(value, peak)} ${(frac * 100).toFixed(2)}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function legendGradient(peak) {
  const stops = [];
  for (let k = 0; k < 24; k++) {
    const frac = k / 23;
    stops.push(`${rampColor(frac * peak, peak)} ${(frac * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function pct(t, axisStart, span) { return `${(((t - axisStart) / span) * 100).toFixed(4)}%`; }
function pctSpan(len, span) { return `${((len / span) * 100).toFixed(4)}%`; }

function clockOf(min, day) {
  if (min >= (day + 1) * DAY_MIN) return "24:00";
  const total = Math.round(((min % DAY_MIN) + DAY_MIN) % DAY_MIN);
  if (total >= DAY_MIN) return "24:00";
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function raceDayLabel(state, dayIdx) {
  const iso = state.race?.startDateISO;
  if (!iso) return null;
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d + dayIdx));
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getUTCDate()}.${dt.getUTCMonth() + 1}.${dt.getUTCFullYear()}`;
}

function renderCpTimelinePages(state, teams) {
  const presenceByCp = collectCpPresenceFromTeams(teams);
  if (presenceByCp.size === 0) return [];

  let firstMin = Infinity, lastMin = -Infinity;
  for (const intervals of presenceByCp.values()) {
    for (const iv of intervals) {
      if (iv.start < firstMin) firstMin = iv.start;
      if (iv.end > lastMin) lastMin = iv.end;
    }
  }
  if (!Number.isFinite(firstMin)) return [];

  const firstDay = Math.floor(firstMin / DAY_MIN);
  const lastDay = Math.floor(Math.max(firstMin, lastMin - 1) / DAY_MIN);
  const models = [];
  for (let day = firstDay; day <= lastDay; day++) {
    const model = buildDayModel(state, day, presenceByCp);
    if (model.rows.length) models.push(model);
  }
  if (models.length === 0) return [];

  let peakTeams = 1;
  for (const model of models) for (const row of model.rows) if (row.peak > peakTeams) peakTeams = row.peak;

  return models.map(model => renderCpTimelinePage(state, model, peakTeams));
}

function renderCpTimelinePage(state, model, peakTeams) {
  const { day, rows } = model;
  const axisStart = Math.max(model.dayStart, Math.floor(Math.min(...rows.map(r => r.openMin)) / 60) * 60);
  let axisEnd = Math.min(model.dayEnd, Math.ceil(Math.max(...rows.map(r => r.closeMin)) / 60) * 60);
  if (axisEnd <= axisStart) axisEnd = Math.min(model.dayEnd, axisStart + 60);
  const span = axisEnd - axisStart;

  const hours = [];
  for (let t = axisStart; t <= axisEnd; t += 60) hours.push(t);
  const stepMin = ([1, 2, 3, 4, 6, 12].find(h => (span / 60) / h <= 12) || 12) * 60;
  const labelled = new Set([axisStart, axisEnd]);
  for (let t = Math.ceil(axisStart / stepMin) * stepMin; t <= axisEnd; t += stepMin) labelled.add(t);
  const ticks = [...labelled].sort((a, b) => a - b);

  const gridHtml = hours.map(t =>
    `<i class="${labelled.has(t) ? "tl-hour-major" : ""}" style="left:${pct(t, axisStart, span)}"></i>`
  ).join("");

  const rowsHtml = rows.map(row => {
    const clipCls = `${row.clipStart ? " clip-start" : ""}${row.clipEnd ? " clip-end" : ""}`;
    const windowLabel = `${clockOf(row.openMin, day)}–${clockOf(row.closeMin, day)}`;
    const title = `${row.cp.name} — ${windowLabel}, enintään ${row.peak} joukkuetta yhtä aikaa`;
    return `
      <div class="tl-row">
        <div class="tl-label">
          <span class="tl-name">${escapeText(row.cp.name)}</span>
          <span class="tl-sub">${windowLabel} · enint. ${row.peak}</span>
        </div>
        <div class="tl-track">
          <div class="tl-bar${clipCls}" title="${escapeAttr(title)}"
               style="left:${pct(row.openMin, axisStart, span)};width:${pctSpan(row.closeMin - row.openMin, span)};background:${barGradient(row.curve, peakTeams)}"></div>
        </div>
      </div>
    `;
  }).join("");

  const weekday = weekdayLabel(state.race.startDateISO, day);
  const dateLabel = raceDayLabel(state, day);

  const page = document.createElement("details");
  page.className = "card print-page";
  bindCollapse(page, "ennuste-timeline-" + day);
  page.innerHTML = `
    <summary><h2>Rastien aikataulu — ${escapeText(weekday)}</h2></summary>
    <header class="print-header">
      <div class="print-title">
        <div class="print-race">${escapeText(state.race.name || "Kilpailu")}</div>
        <h1>Rastien aikataulu — ${escapeText(weekday)}</h1>
      </div>
      ${logoBlock(state)}
      <div class="print-meta">
        <div><strong>${rows.length}</strong> rastia</div>
        <div>Aikaväli: <strong>${clockOf(axisStart, day)}–${clockOf(axisEnd, day)}</strong></div>
        <div>${dateLabel ? `Päivämäärä: <strong>${escapeText(dateLabel)}</strong>` : ""}</div>
      </div>
    </header>
    <div class="cp-timeline">
      <div class="tl-row tl-axis">
        <div class="tl-label"></div>
        <div class="tl-track">
          ${ticks.map(t => {
            const edge = t === axisStart ? " tl-tick-first" : (t === axisEnd ? " tl-tick-last" : "");
            return `<span class="tl-tick${edge}" style="left:${pct(t, axisStart, span)}">${clockOf(t, day)}</span>`;
          }).join("")}
        </div>
      </div>
      <div class="tl-body">
        ${rowsHtml}
        <div class="tl-grid" aria-hidden="true">${gridHtml}</div>
      </div>
      <div class="tl-legend">
        <span class="tl-legend-cap">Joukkueita rastilla yhtä aikaa</span>
        <span class="tl-legend-end">0</span>
        <i class="tl-legend-ramp" style="background:${legendGradient(peakTeams)}"></i>
        <span class="tl-legend-end">${peakTeams}</span>
      </div>
    </div>
  `;
  return page;
}

// ── Per-category schedule page ──────────────────────────────────────────
function renderSarjaPage(state, sched) {
  const { cat, course, rows } = sched;
  const page = document.createElement("details");
  page.className = "card print-page";
  bindCollapse(page, "ennuste-sarja-" + cat.id);

  if (!course) {
    page.innerHTML = `<summary><h2>${escapeText(cat.name)}</h2></summary><p class="text-muted">Sarjalla ei ole rataa valittuna.</p>`;
    return page;
  }

  // Split the course's distance per calendar day: a stop's distance counts
  // toward the day it's walked on, and each Yörasti the route passes through
  // advances every following stop to the next day. Generalizes to any number
  // of overnight stops, not just a single day-1/day-2 split.
  const dayDistances = [0];
  let dayIdx = 0;
  course.stops.forEach(s => {
    dayDistances[dayIdx] += s.distanceM || 0;
    if (findCp(state, s.cpId)?.isSleepingCp) { dayIdx++; dayDistances[dayIdx] = 0; }
  });
  const totalDistance = dayDistances.reduce((a, b) => a + b, 0);
  const dayDistanceHtml = dayDistances
    .map((d, i) => `<div>Päivä ${i + 1} matka: <strong>${(d / 1000).toFixed(2)} km</strong></div>`)
    .join("");

  let rowNumber = 0;
  const rowsHtml = rows.map(r => sarjaRowHtml(state, ++rowNumber, r)).join("");

  page.innerHTML = `
    <summary><h2 style="color:${escapeAttr(cat.color || "var(--fg)")}">${escapeText(cat.name)}</h2></summary>
    <header class="print-header">
      <div class="print-title">
        <div class="print-race">${escapeText(state.race.name || "Kilpailu")}</div>
        <h1 style="color:${escapeAttr(cat.color || "var(--fg)")}">${escapeText(cat.name)}</h1>
      </div>
      ${logoBlock(state)}
      <div class="print-meta">
        <div><strong>${cat.teamCount}</strong> joukkuetta</div>
        <div>Kävelynopeus: <strong>${cat.walkSpeedKmh} km/h</strong> (${cat.fastestMultiplier}×–${cat.slowestMultiplier}×)</div>
        <div>Rata: <strong>${escapeText(course.name)}</strong></div>
        <div>Lähtö pv 1: <strong>${fmtTime(cat.startMinutes1, state.race.startDateISO)}</strong></div>
        <div>Lähtö (yön jälkeen): <strong>${fmtTime(cat.startMinutes2, state.race.startDateISO)}</strong></div>
        <div>Lähtöväli: <strong>${cat.teamStartIntervalMin} min</strong></div>
        <div>Kokonaismatka: <strong>${(totalDistance / 1000).toFixed(2)} km</strong></div>
        ${dayDistanceHtml}
      </div>
    </header>
    <table class="print-table">
      <thead>
        <tr>
          <th>#</th><th>Rasti</th><th>Tehtävä</th><th class="nowrap">Matka (m)</th>
          <th class="nowrap">Ensimm. saapuu</th><th class="nowrap">Viim. saapuu</th>
          <th class="nowrap">Ensimm. lähtee</th><th class="nowrap">Viim. lähtee</th>
          <th class="nowrap">Pahin odotus</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
  return page;
}

function sarjaRowHtml(state, num, r) {
  return `
    <tr class="${r.overnight ? "overnight" : ""}">
      <td>${num}</td>
      <td>${escapeText(r.cp.name)}${r.overnight ? ' <span class="overnight-tag">YÖ</span>' : ""}</td>
      <td>${r.task ? escapeText(r.task.name) : "—"}</td>
      <td class="nowrap">${r.distanceM > 0 ? r.distanceM : "—"}</td>
      <td class="nowrap">${fmtTime(r.firstArrive, state.race.startDateISO)}</td>
      <td class="nowrap">${fmtTime(r.lastArrive, state.race.startDateISO)}</td>
      <td class="nowrap">${fmtTime(r.firstLeave, state.race.startDateISO)}</td>
      <td class="nowrap">${fmtTime(r.lastLeave, state.race.startDateISO)}</td>
      <td class="nowrap">${Math.round(r.worstWaitMin || 0)}</td>
    </tr>
  `;
}

// ── Task-times page ──────────────────────────────────────────────────────
function renderTaskTimesPage(state) {
  const page = document.createElement("details");
  page.className = "card print-page";
  bindCollapse(page, "ennuste-tasktimes");

  const firstCpIndex = new Map();
  const cpNamesByTask = new Map();
  state.controlPoints.forEach((cp, idx) => {
    for (const taskId of cp.taskIds || []) {
      if (!firstCpIndex.has(taskId)) firstCpIndex.set(taskId, idx);
      if (!cpNamesByTask.has(taskId)) cpNamesByTask.set(taskId, []);
      cpNamesByTask.get(taskId).push(cp.name);
    }
  });
  const orderedTasks = state.tasks
    .map((task, origIdx) => ({ task, origIdx, key: firstCpIndex.has(task.id) ? firstCpIndex.get(task.id) : Infinity }))
    .sort((a, b) => (a.key - b.key) || (a.origIdx - b.origIdx))
    .map(x => x.task);

  let anyOverride = false;
  let rowNumber = 0;
  const rowsHtml = [];
  for (const task of orderedTasks) {
    const cpNames = cpNamesByTask.get(task.id) || [];
    const cpLabel = cpNames.length ? cpNames.join(", ") : "—";
    const slots = task.unlimitedSlots ? "Rajaton" : String(task.slots ?? 1);
    const baseFast = task.fastestTaskMin ?? 0;
    const baseSlow = task.slowestTaskMin ?? 0;

    const diffs = [];
    for (const cat of state.categories) {
      const ov = cat.taskOverrides?.[task.id];
      if (!ov) continue;
      const effFast = ov.fastestTaskMin ?? baseFast;
      const effSlow = ov.slowestTaskMin ?? baseSlow;
      if (effFast !== baseFast || effSlow !== baseSlow) {
        diffs.push({ name: cat.name, color: cat.color, fast: effFast, slow: effSlow });
      }
    }
    if (diffs.length) anyOverride = true;
    const diffHtml = diffs.length === 0
      ? '<span class="text-muted">—</span>'
      : diffs.map(d =>
          `<span class="series-diff"><span class="series-dot" style="background:${escapeAttr(d.color || "transparent")}"></span>${escapeText(d.name)}: ${d.fast}/${d.slow}</span>`
        ).join("<br>");

    rowsHtml.push(`
      <tr>
        <td>${++rowNumber}</td>
        <td>${escapeText(task.name)}</td>
        <td>${escapeText(cpLabel)}</td>
        <td class="nowrap">${escapeText(slots)}</td>
        <td class="nowrap">${baseFast}</td>
        <td class="nowrap">${baseSlow}</td>
        <td>${diffHtml}</td>
      </tr>
    `);
  }

  const subtitle = anyOverride
    ? "Tehtävien oletusajat sekä sarjakohtaiset poikkeukset (nopein / hitain, minuuttia)."
    : "Kaikki sarjat käyttävät samoja aikoja — ei sarjakohtaisia poikkeuksia.";

  page.innerHTML = `
    <summary><h2>Tehtävien kestot</h2></summary>
    <header class="print-header">
      <div class="print-title">
        <div class="print-race">${escapeText(state.race.name || "Kilpailu")}</div>
        <h1>Tehtävien kestot</h1>
      </div>
      ${logoBlock(state)}
      <div class="print-meta">
        <div><strong>${orderedTasks.length}</strong> tehtävää</div>
        <div>Ajat minuutteina</div>
        <div></div>
      </div>
    </header>
    <p class="print-subtitle">${escapeText(subtitle)}</p>
    <table class="print-table">
      <thead>
        <tr>
          <th>#</th><th>Tehtävä</th><th>Rasti</th><th class="nowrap">Suorituspaikat</th>
          <th class="nowrap">Nopein (min)</th><th class="nowrap">Hitain (min)</th><th>Sarjakohtaiset erot</th>
        </tr>
      </thead>
      <tbody>${rowsHtml.join("")}</tbody>
    </table>
  `;
  return page;
}
