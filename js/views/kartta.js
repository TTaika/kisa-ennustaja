// Real-data visualization: CP pins + a chosen course's route + forbidden
// areas. Two rendering modes, chosen automatically:
//   - a real uploaded map (image or PDF), georeferenced by >=2 calibration
//     points and drawn on a <canvas> using georef.js's similarity fit;
//   - an illustrative min/max-projected SVG fallback, used until a map is
//     uploaded and calibrated (never leaves the view broken/empty).
// Calibration-point placement and forbidden-area drawing are both driven by
// clicks on whichever of the two is currently shown.
import { getState, update, genId } from "../state.js";
import { rerender } from "../router.js";
import { escapeText, escapeAttr } from "../util/format.js";
import { getMapFile, putMapFile, clearMapFile } from "../io/mapstore.js";
import { renderMapFileToCanvas, canvasEventToRefPx } from "../util/mapRender.js";
import { fitSimilarity, pxToLl, llToPx, calibrationQuality } from "../model/georef.js";
import { haversineM } from "../model/route.js";
import { initSearchPicker } from "../util/searchPicker.js";
import { showToast } from "../util/demo.js";
import { openModal } from "../util/modal.js";
import { initDropdownMenu } from "../util/dropdownMenu.js";

const VB_W = 760, VB_H = 500, PAD = 50;
// Fixed, theme-independent colors for "show all courses at once" — categorical
// and arbitrary by nature, so unlike the single-course green they don't need
// to track the light/dark palette.
const ROUTE_PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#9a6324"];

// ── Module-local UI state — not persisted, reset on tab switch ─────────────
let uiMode = "view"; // "view" | "calibrate" | "drawArea"
let pendingRing = []; // [{lat,lng}, ...] while uiMode === "drawArea"
const rasterCache = { key: null, canvas: null, refScale: 1, pageCount: 1 };

export function render(root) {
  const state = getState();
  const card = document.createElement("section");
  card.className = "card";
  const courseOptions = state.courses.map(c => `<option value="${escapeAttr(c.id)}">${escapeText(c.name)}</option>`).join("");
  const hasMap = !!state.map.fileName;
  card.innerHTML = `
    <div class="toolbar">
      <input type="file" id="map-file-input" accept="image/*,application/pdf" hidden>
      <button class="secondary" id="btn-load-map">Lataa kartta…</button>
      ${hasMap ? `<button class="secondary" id="btn-clear-map">Poista kartta</button>` : ""}
      <button class="secondary" id="btn-calibrate" ${hasMap ? "" : "disabled title=\"Lataa kartta ensin\""}>${uiMode === "calibrate" ? "Lopeta kalibrointi" : "Kalibroi pisteet"}</button>
      <button class="secondary" id="btn-draw-area">${uiMode === "drawArea" ? "Lopeta piirto" : "+ Piirrä kielletty alue"}</button>
      <label style="margin-left:auto; display:flex; align-items:center; gap:0.4rem;">
        Näytä rata
        <select class="course-select" ${state.map.layers.showAllCourses ? "disabled" : ""}>
          <option value="">— ei mitään —</option>
          ${courseOptions}
        </select>
      </label>
      <label style="display:flex; align-items:center; gap:0.4rem;">
        <input type="checkbox" class="layer-all-courses switch" ${state.map.layers.showAllCourses ? "checked" : ""}> Kaikki radat
      </label>
      <div class="dropdown-menu-wrap">
        <button type="button" class="icon-btn dropdown-menu-trigger" aria-haspopup="true" aria-expanded="false" title="Näkyvyysasetukset" aria-label="Näkyvyysasetukset">⋮</button>
        <div class="dropdown-menu map-layers-menu">
          <label><span>Rastit</span><input class="layer-cps switch" type="checkbox" ${state.map.layers.showControlPoints ? "checked" : ""}></label>
          <label><span>Radat</span><input class="layer-route switch" type="checkbox" ${state.map.layers.showRoutes ? "checked" : ""}></label>
          <label><span>Nimet</span><input class="layer-labels switch" type="checkbox" ${state.map.layers.showLabels ? "checked" : ""}></label>
          <label><span>Etäisyydet</span><input class="layer-distances switch" type="checkbox" ${state.map.layers.showDistances ? "checked" : ""}></label>
          <label><span>Kielletyt alueet</span><input class="layer-forbidden switch" type="checkbox" ${state.map.layers.showForbidden ? "checked" : ""}></label>
        </div>
      </div>
    </div>
    ${hasMap ? `<p class="text-muted map-filename">${escapeText(state.map.fileName)}</p>` : ""}
    <div id="map-page-nav"></div>
    <div class="map-wrap"><div class="placeholder">Ladataan karttaa…</div></div>
    <div id="map-legend"></div>
    <div id="calibration-panel"></div>
    <div id="forbidden-panel"></div>
  `;
  root.appendChild(card);

  const mapWrap = card.querySelector(".map-wrap");
  const courseSelect = card.querySelector(".course-select");
  const layerCps = card.querySelector(".layer-cps");
  const layerRoute = card.querySelector(".layer-route");
  const layerAllCourses = card.querySelector(".layer-all-courses");
  const layerLabels = card.querySelector(".layer-labels");
  const layerDistances = card.querySelector(".layer-distances");
  const layerForbidden = card.querySelector(".layer-forbidden");
  if (state.courses[0] && !courseSelect.value) courseSelect.value = state.courses[0].id;

  initDropdownMenu(card.querySelector(".dropdown-menu-trigger"), card.querySelector(".map-layers-menu"));

  function currentLayers() {
    return {
      showControlPoints: layerCps.checked,
      showRoutes: layerRoute.checked,
      showAllCourses: layerAllCourses.checked,
      showLabels: layerLabels.checked,
      showDistances: layerDistances.checked,
      showForbidden: layerForbidden.checked
    };
  }

  function persistLayers() {
    const layers = currentLayers();
    update(st => { Object.assign(st.map.layers, layers); });
  }

  let redraw = () => {};

  [courseSelect, layerCps, layerRoute, layerLabels, layerDistances, layerForbidden].forEach(el => {
    el.addEventListener("change", () => { persistLayers(); redraw(); });
  });
  layerAllCourses.addEventListener("change", () => {
    courseSelect.disabled = layerAllCourses.checked;
    persistLayers();
    redraw();
  });

  card.querySelector("#btn-load-map").addEventListener("click", () => {
    card.querySelector("#map-file-input").click();
  });
  card.querySelector("#map-file-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      await putMapFile(file);
      rasterCache.key = null; // force a re-decode
      update(st => { st.map.fileName = file.name; st.map.pageIndex = 0; });
      rerender();
    } catch (err) {
      showToast(`Kartan tallennus epäonnistui: ${err.message}`);
    }
  });
  card.querySelector("#btn-clear-map")?.addEventListener("click", async () => {
    if (!confirm("Poistetaanko ladattu kartta ja sen kalibrointi?")) return;
    await clearMapFile();
    rasterCache.key = null;
    uiMode = "view";
    update(st => { st.map.fileName = null; st.map.pageIndex = 0; st.map.calibration.points = []; });
    rerender();
  });
  card.querySelector("#btn-calibrate").addEventListener("click", () => {
    uiMode = uiMode === "calibrate" ? "view" : "calibrate";
    pendingRing = [];
    rerender();
  });
  card.querySelector("#btn-draw-area").addEventListener("click", () => {
    if (uiMode === "drawArea") {
      uiMode = "view"; pendingRing = [];
    } else {
      uiMode = "drawArea"; pendingRing = [];
    }
    rerender();
  });

  const pageNav = card.querySelector("#map-page-nav");
  const legendEl = card.querySelector("#map-legend");
  redraw = () => drawMap(mapWrap, pageNav, legendEl, { courseId: courseSelect.value, layers: currentLayers() });
  redraw();

  if (uiMode === "calibrate") card.querySelector("#calibration-panel").appendChild(calibrationPanel(redraw));
  if (uiMode === "drawArea") card.querySelector("#forbidden-panel").appendChild(drawAreaToolbar());
  if (uiMode !== "drawArea") card.querySelector("#forbidden-panel").appendChild(forbiddenAreaList());
}

// ── Raster loading + drawing ────────────────────────────────────────────
async function ensureRaster(mapWrap) {
  const state = getState();
  if (!state.map.fileName) { rasterCache.key = null; return null; }
  const record = await getMapFile();
  if (!record) { rasterCache.key = null; return null; }
  const key = `${record.size}|${record.type}|${state.map.pageIndex}|${state.map.renderDpi}`;
  if (rasterCache.key === key) return rasterCache;
  try {
    const { canvas, refScale, pageCount } = await renderMapFileToCanvas(record, {
      pageIndex: state.map.pageIndex,
      renderDpi: state.map.renderDpi
    });
    Object.assign(rasterCache, { key, canvas, refScale, pageCount });
    return rasterCache;
  } catch (err) {
    showToast(`Kartan näyttäminen epäonnistui: ${err.message}`);
    rasterCache.key = null;
    return null;
  }
}

function renderPageNav(pageNav, raster) {
  if (!raster || raster.pageCount <= 1) { pageNav.innerHTML = ""; return; }
  const state = getState();
  const idx = state.map.pageIndex;
  pageNav.innerHTML = `
    <div class="toolbar" style="margin-bottom:0.5rem;">
      <button class="secondary" id="btn-prev-page" ${idx <= 0 ? "disabled" : ""}>◀ Edellinen sivu</button>
      <span class="text-muted">Sivu ${idx + 1} / ${raster.pageCount}</span>
      <button class="secondary" id="btn-next-page" ${idx >= raster.pageCount - 1 ? "disabled" : ""}>Seuraava sivu ▶</button>
    </div>
  `;
  pageNav.querySelector("#btn-prev-page")?.addEventListener("click", () => {
    rasterCache.key = null;
    update(st => { st.map.pageIndex = Math.max(0, st.map.pageIndex - 1); });
    rerender();
  });
  pageNav.querySelector("#btn-next-page")?.addEventListener("click", () => {
    rasterCache.key = null;
    update(st => { st.map.pageIndex = Math.min(raster.pageCount - 1, st.map.pageIndex + 1); });
    rerender();
  });
}

function currentFit() {
  const points = getState().map.calibration.points;
  const usable = points.filter(p => p && Number.isFinite(p.px) && Number.isFinite(p.lat));
  if (usable.length < 2) return null;
  try {
    return fitSimilarity(points);
  } catch {
    return null;
  }
}

async function drawMap(mapWrap, pageNav, legendEl, { courseId, layers }) {
  const state = getState();
  // Calibrating needs the raster on screen even before any fit exists — that
  // is the whole point of the mode. Otherwise the raster is only useful once
  // it can be correctly overlaid, i.e. once >=2 points give a fit.
  const raster = (uiMode === "calibrate" || state.map.fileName) ? await ensureRaster(mapWrap) : null;
  // Bail out if the view has moved on (e.g. tab switched) while we awaited.
  if (!mapWrap.isConnected) return;

  renderPageNav(pageNav, raster);
  const fit = raster ? currentFit() : null;

  if (uiMode === "calibrate" && raster) {
    const scene = buildScene(state, courseId, layers, fit);
    renderLegend(legendEl, scene);
    drawCalibrationCanvas(mapWrap, raster, fit, scene);
    return;
  }

  const scene = buildScene(state, courseId, layers, fit);
  renderLegend(legendEl, scene);

  if (raster && fit) {
    const canvas = document.createElement("canvas");
    canvas.className = "map-canvas";
    canvas.width = raster.canvas.width;
    canvas.height = raster.canvas.height;
    mapWrap.innerHTML = "";
    mapWrap.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(raster.canvas, 0, 0);
    drawSceneOnCanvas(ctx, scene, (lat, lng) => {
      const { px, py } = llToPx(fit, lat, lng);
      return [px / raster.refScale, py / raster.refScale];
    });
    if (uiMode === "drawArea") {
      canvas.addEventListener("click", (evt) => {
        const { px, py } = canvasEventToRefPx(canvas, evt, raster.refScale);
        pendingRing.push(pxToLl(fit, px, py));
        rerender();
      });
    }
  } else {
    mapWrap.innerHTML = illustrativeSvg(state, scene);
    const svg = mapWrap.querySelector("svg");
    if (uiMode === "drawArea") {
      svg.addEventListener("click", (evt) => {
        const ll = svgClickToLatLng(svg, evt, scene.projector);
        if (ll) { pendingRing.push(ll); rerender(); }
      });
    }
  }
}

// Calibration mode: always shows the raster (that's what's being clicked
// on). If a fit already exists (re-calibrating / adding a point), the full
// scene is drawn too, so existing rasti positions can be checked visually;
// the calibration points themselves are always drawn on top, numbered, so a
// mis-click is easy to spot before it's given coordinates below.
function drawCalibrationCanvas(mapWrap, raster, fit, scene) {
  const canvas = document.createElement("canvas");
  canvas.className = "map-canvas";
  canvas.width = raster.canvas.width;
  canvas.height = raster.canvas.height;
  mapWrap.innerHTML = "";
  mapWrap.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(raster.canvas, 0, 0);
  if (fit) {
    drawSceneOnCanvas(ctx, scene, (lat, lng) => {
      const { px, py } = llToPx(fit, lat, lng);
      return [px / raster.refScale, py / raster.refScale];
    });
  }
  const points = getState().map.calibration.points;
  points.forEach((p, i) => {
    const x = p.px / raster.refScale, y = p.py / raster.refScale;
    const resolved = p.lat != null && p.lng != null;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, 2 * Math.PI);
    ctx.fillStyle = resolved ? "#fff" : "rgba(255,255,255,0.35)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = cssVar("--danger", "#c8461f");
    ctx.stroke();
    ctx.fillStyle = "#141414";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), x, y + 4);
    ctx.textAlign = "left";
  });
  canvas.addEventListener("click", (evt) => {
    const { px, py } = canvasEventToRefPx(canvas, evt, raster.refScale);
    addCalibrationPoint(px, py);
  });
}

// A plain-data description of what to draw — shared by both render paths.
// One or many routes: "Kaikki radat" draws every course at once, each in its
// own palette color with a legend; otherwise just the one picked in the
// select, in the plain course-green used throughout the rest of the app.
function buildScene(state, courseId, layers, fit) {
  const cps = layers.showControlPoints ? state.controlPoints : [];
  const coursesToShow = !layers.showRoutes ? []
    : layers.showAllCourses ? state.courses
    : state.courses.filter(c => c.id === courseId);
  const routes = coursesToShow.map((course, i) => ({
    id: course.id,
    name: course.name,
    color: layers.showAllCourses ? ROUTE_PALETTE[i % ROUTE_PALETTE.length] : "var(--ok)",
    stops: course.stops.map(s => state.controlPoints.find(cp => cp.id === s.cpId)).filter(Boolean)
  }));
  const areas = layers.showForbidden ? (state.forbiddenAreas || []) : [];
  const allPts = [...state.controlPoints, ...areas.flatMap(a => a.ring || [])];
  const projector = fit ? null : buildProjector(allPts);
  return { cps, routes, areas, showLabels: layers.showLabels, showDistances: layers.showDistances, projector, pendingRing: uiMode === "drawArea" ? pendingRing : [] };
}

function renderLegend(legendEl, scene) {
  if (scene.routes.length < 2) { legendEl.innerHTML = ""; return; }
  legendEl.innerHTML = `
    <div class="map-legend">
      ${scene.routes.map(r => `<span class="map-legend-item"><span class="map-legend-swatch" style="background:${escapeAttr(r.color)}"></span>${escapeText(r.name)}</span>`).join("")}
    </div>
  `;
}

// ── Real-map (canvas) drawing ────────────────────────────────────────────
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function haloText(ctx, text, x, y) {
  ctx.font = "13px sans-serif";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.fillRect(x - 3, y - 12, w + 6, 16);
  ctx.fillStyle = "#141414";
  ctx.fillText(text, x, y);
}

// Canvas 2D ignores CSS custom properties — resolve "var(--x)" strings to an
// actual color here; a literal hex (the multi-course palette) passes through.
function resolveCanvasColor(color) {
  const m = /^var\((--[a-z-]+)\)$/.exec(color);
  return m ? cssVar(m[1], color) : color;
}

function drawSceneOnCanvas(ctx, scene, project) {
  const accent = cssVar("--accent", "#9c3a98");
  const danger = cssVar("--danger", "#c8461f");

  if (scene.areas.length) {
    for (const area of scene.areas) {
      if (area.enabled === false || !area.ring || area.ring.length < 3) continue;
      ctx.beginPath();
      area.ring.forEach((p, i) => {
        const [x, y] = project(p.lat, p.lng);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = danger + "2e";
      ctx.fill();
      ctx.strokeStyle = danger;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      if (scene.showLabels && area.name) {
        const [lx, ly] = project(area.ring[0].lat, area.ring[0].lng);
        haloText(ctx, area.name, lx, ly - 6);
      }
    }
  }

  for (const route of scene.routes) {
    if (route.stops.length < 2) continue;
    ctx.beginPath();
    route.stops.forEach((cp, i) => {
      const [x, y] = project(cp.lat, cp.lng);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = resolveCanvasColor(route.color);
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (scene.showDistances) {
      for (let i = 1; i < route.stops.length; i++) {
        const a = route.stops[i - 1], b = route.stops[i];
        const [ax, ay] = project(a.lat, a.lng), [bx, by] = project(b.lat, b.lng);
        const m = Math.round(haversineM(a, b));
        haloText(ctx, `${m} m`, (ax + bx) / 2, (ay + by) / 2);
      }
    }
  }

  if (scene.pendingRing.length) {
    ctx.beginPath();
    scene.pendingRing.forEach((p, i) => {
      const [x, y] = project(p.lat, p.lng);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
    });
    ctx.strokeStyle = danger;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  for (const cp of scene.cps) {
    if (cp.lat == null || cp.lng == null) continue;
    const [x, y] = project(cp.lat, cp.lng);
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, 2 * Math.PI);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = cp.isSleepingCp ? cssVar("--warn", "#33366b") : "#fff";
    ctx.stroke();
    if (scene.showLabels) haloText(ctx, cp.name, x + 11, y + 4);
  }
}

// ── Illustrative SVG fallback (no georeferenced map yet) ────────────────
function buildProjector(points) {
  const pts = points.filter(p => p.lat != null && p.lng != null);
  if (pts.length === 0) return () => [VB_W / 2, VB_H / 2];
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const latSpan = maxLat - minLat || 1;
  const lngSpan = maxLng - minLng || 1;
  const project = (lat, lng) => {
    if (lat == null || lng == null) return [VB_W / 2, VB_H / 2];
    const x = PAD + ((lng - minLng) / lngSpan) * (VB_W - 2 * PAD);
    const y = PAD + (1 - (lat - minLat) / latSpan) * (VB_H - 2 * PAD);
    return [x, y];
  };
  project.invert = (x, y) => ({
    lat: maxLat - ((y - PAD) / (VB_H - 2 * PAD)) * latSpan,
    lng: minLng + ((x - PAD) / (VB_W - 2 * PAD)) * lngSpan
  });
  return project;
}

function svgClickToLatLng(svg, evt, projector) {
  if (!projector || !projector.invert) return null;
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  if (p.x < 0 || p.x > VB_W || p.y < 0 || p.y > VB_H) return null;
  return projector.invert(p.x, p.y);
}

function illustrativeSvg(state, scene) {
  const project = scene.projector;
  const gridLines = `
    ${Array.from({ length: 8 }).map((_, i) => `<line x1="0" y1="${i * VB_H / 7}" x2="${VB_W}" y2="${i * VB_H / 7}" stroke="#232830" stroke-width="1"></line>`).join("")}
    ${Array.from({ length: 12 }).map((_, i) => `<line x1="${i * VB_W / 11}" y1="0" x2="${i * VB_W / 11}" y2="${VB_H}" stroke="#232830" stroke-width="1"></line>`).join("")}
  `;

  const forbiddenHtml = scene.areas.map(area => {
    if (area.enabled === false) return "";
    const ring = area.ring || [];
    if (ring.length < 3) return "";
    const poly = ring.map(p => project(p.lat, p.lng).join(",")).join(" ");
    const [lx, ly] = project(ring[0].lat, ring[0].lng);
    return `
      <polygon points="${poly}" fill="rgba(200,70,31,0.18)" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="4 3"></polygon>
      ${scene.showLabels ? `<text x="${lx}" y="${ly - 6}" font-size="11" fill="var(--danger)">${escapeText(area.name || "Kielletty alue")}</text>` : ""}
    `;
  }).join("");

  const routeHtml = scene.routes.map(route => route.stops.length > 1
    ? `<polyline points="${route.stops.map(cp => project(cp.lat, cp.lng).join(",")).join(" ")}" fill="none" stroke="${escapeAttr(route.color)}" stroke-width="2.5" stroke-dasharray="6 4"></polyline>`
    : ""
  ).join("");

  const distanceHtml = scene.showDistances ? scene.routes.map(route => route.stops.length > 1
    ? route.stops.slice(1).map((cp, i) => {
        const a = route.stops[i], b = cp;
        const [ax, ay] = project(a.lat, a.lng), [bx, by] = project(b.lat, b.lng);
        const m = Math.round(haversineM(a, b));
        return `<text x="${(ax + bx) / 2}" y="${(ay + by) / 2}" font-size="11" fill="#e8ecf1">${m} m</text>`;
      }).join("")
    : ""
  ).join("") : "";

  const pendingHtml = scene.pendingRing.length ? `
    <polyline points="${scene.pendingRing.map(p => project(p.lat, p.lng).join(",")).join(" ")}" fill="none" stroke="var(--danger)" stroke-width="2"></polyline>
    ${scene.pendingRing.map(p => { const [x, y] = project(p.lat, p.lng); return `<circle cx="${x}" cy="${y}" r="4" fill="#fff"></circle>`; }).join("")}
  ` : "";

  const pinsHtml = scene.cps.map(cp => {
    if (cp.lat == null || cp.lng == null) return "";
    const [x, y] = project(cp.lat, cp.lng);
    const sleeping = cp.isSleepingCp ? ` stroke="var(--warn)"` : ` stroke="#fff"`;
    return `
      <circle cx="${x}" cy="${y}" r="7" fill="var(--accent)"${sleeping} stroke-width="2"></circle>
      ${scene.showLabels ? `<text x="${x + 11}" y="${y + 4}" font-size="13" fill="#e8ecf1">${escapeText(cp.name)}</text>` : ""}
    `;
  }).join("");

  return `
    <svg class="map-placeholder-svg" viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet">
      <rect x="0" y="0" width="${VB_W}" height="${VB_H}" fill="#171a1f"></rect>
      <g opacity="0.5">${gridLines}</g>
      ${forbiddenHtml}
      ${routeHtml}
      ${distanceHtml}
      ${pendingHtml}
      ${pinsHtml}
    </svg>
  `;
}

// ── Calibration panel ────────────────────────────────────────────────────
function addCalibrationPoint(px, py) {
  update(st => { st.map.calibration.points.push({ px, py, lat: null, lng: null }); });
  rerender();
}

function severityClass(value, okMax, cautionMax) {
  if (value <= okMax) return "text-ok";
  if (value <= cautionMax) return "text-caution";
  return "text-danger";
}

function calibrationPanel(redraw) {
  const state = getState();
  const points = state.map.calibration.points;
  const wrap = document.createElement("div");
  wrap.className = "card calibration-panel";

  let fit = null, fitError = null;
  const usable = points.filter(p => p && Number.isFinite(p.px) && Number.isFinite(p.lat));
  if (usable.length >= 2) {
    try { fit = fitSimilarity(points); } catch (e) { fitError = e.message; }
  }

  const qualityHtml = (() => {
    if (fitError) return `<p class="text-danger">${escapeText(fitError)}</p>`;
    if (!fit) return `<p class="text-muted">Lisää vähintään 2 pistettä, joilla on sekä sijainti kartalla että koordinaatit.</p>`;
    const q = calibrationQuality(fit, state.map.paperScale);
    const rmseClass = severityClass(fit.rmseM, 10, 30);
    const scaleClass = severityClass(Math.abs(q.scaleErrorPct), 2, 5);
    return `
      <p>
        <strong>${fit.pointCount}</strong> pistettä ·
        RMSE <span class="${q.residualsMeaningful ? rmseClass : "text-muted"}">${q.residualsMeaningful ? fit.rmseM.toFixed(1) + " m" : "—"}</span> ·
        mittakaavavirhe <span class="${scaleClass}">${q.scaleErrorPct >= 0 ? "+" : ""}${q.scaleErrorPct.toFixed(1)}%</span>
      </p>
      ${!q.residualsMeaningful ? `<p class="text-muted">Lisää kolmas piste nähdäksesi tarkkuuden.</p>` : ""}
    `;
  })();

  wrap.innerHTML = `
    <h3 class="subhead">Kalibrointipisteet</h3>
    <p class="text-muted">Napauta karttaa lisätäksesi kalibrointipisteen kohtaan, jonka koordinaatit tiedät.</p>
    ${qualityHtml}
    <div class="calib-list">
      ${points.map((p, i) => calibRowHtml(p, i, fit)).join("") || `<p class="text-muted">Ei pisteitä vielä.</p>`}
    </div>
  `;

  points.forEach((p, i) => wireCalibRow(wrap, i, redraw));
  return wrap;
}

function calibRowHtml(p, index, fit) {
  const residual = fit && fit.residualsM[index] != null ? `${fit.residualsM[index].toFixed(1)} m` : "—";
  const coordsVal = (p.lat != null && p.lng != null) ? `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}` : "";
  return `
    <div class="calib-row" data-index="${index}">
      <span class="calib-px nowrap text-muted">px ${Math.round(p.px)}, ${Math.round(p.py)}</span>
      <input class="calib-coords" type="text" placeholder="lat, lng" value="${escapeAttr(coordsVal)}">
      <div class="calib-picker"></div>
      <span class="calib-residual nowrap text-muted">${residual}</span>
      <button class="icon-btn calib-del" title="Poista piste">✕</button>
    </div>
  `;
}

function wireCalibRow(wrap, index, redraw) {
  const row = wrap.querySelector(`.calib-row[data-index="${index}"]`);
  if (!row) return;
  const state = getState();

  row.querySelector(".calib-coords").addEventListener("change", (e) => {
    const parsed = parseCoordsLocal(e.target.value);
    update(st => {
      const point = st.map.calibration.points[index];
      point.lat = parsed ? parsed.lat : null;
      point.lng = parsed ? parsed.lng : null;
    });
    rerender();
  });
  row.querySelector(".calib-del").addEventListener("click", () => {
    update(st => { st.map.calibration.points.splice(index, 1); });
    rerender();
  });
  initSearchPicker(row.querySelector(".calib-picker"), {
    items: () => state.controlPoints.filter(cp => cp.lat != null).map(cp => ({ id: cp.id, label: cp.name })),
    placeholder: "...tai valitse rasti",
    onPick(item) {
      const cp = state.controlPoints.find(c => c.id === item.id);
      update(st => {
        const point = st.map.calibration.points[index];
        point.lat = cp.lat; point.lng = cp.lng;
      });
      rerender();
    }
  });
}

function parseCoordsLocal(input) {
  const m = String(input || "").trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  return m ? { lat: parseFloat(m[1]), lng: parseFloat(m[2]) } : null;
}

// ── Forbidden-area drawing + management ─────────────────────────────────
function drawAreaToolbar() {
  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.innerHTML = `
    <h3 class="subhead">Piirrä kielletty alue</h3>
    <p class="text-muted">Napauta karttaa lisätäksesi alueen kulmapisteitä (vähintään 3). Napauta "Valmis" kun alue on piirretty.</p>
    <p class="text-muted">${pendingRing.length} pistettä piirretty.</p>
    <div class="toolbar">
      <button id="btn-finish-area" ${pendingRing.length < 3 ? "disabled" : ""}>Valmis</button>
      <button class="secondary" id="btn-cancel-area">Peruuta</button>
    </div>
  `;
  wrap.querySelector("#btn-cancel-area").addEventListener("click", () => {
    pendingRing = []; uiMode = "view"; rerender();
  });
  wrap.querySelector("#btn-finish-area").addEventListener("click", () => {
    finishArea();
  });
  return wrap;
}

function finishArea() {
  const ring = pendingRing;
  openModal({
    title: "Nimeä kielletty alue",
    render(body, close) {
      body.innerHTML = `
        <form id="area-form">
          <div class="row"><label>Nimi <input name="name" type="text" required value="Kielletty alue"></label></div>
          <div class="modal-actions">
            <button type="button" class="secondary" data-cancel>Peruuta</button>
            <button type="submit">Tallenna</button>
          </div>
        </form>
      `;
      body.querySelector("[data-cancel]").addEventListener("click", close);
      body.querySelector("#area-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const name = body.querySelector("[name=name]").value.trim() || "Kielletty alue";
        update(st => {
          st.forbiddenAreas.push({ id: genId("area"), name, enabled: true, ring });
        });
        pendingRing = []; uiMode = "view";
        close();
        rerender();
      });
    }
  });
}

function forbiddenAreaList() {
  const state = getState();
  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.innerHTML = `
    <h3 class="subhead">Kielletyt alueet</h3>
    ${state.forbiddenAreas.length ? state.forbiddenAreas.map(areaRowHtml).join("") : `<p class="text-muted">Ei kiellettyjä alueita vielä.</p>`}
  `;
  state.forbiddenAreas.forEach(area => {
    const row = wrap.querySelector(`[data-area-id="${area.id}"]`);
    row?.querySelector(".area-enabled").addEventListener("change", (e) => {
      update(st => { st.forbiddenAreas.find(a => a.id === area.id).enabled = e.target.checked; });
      rerender();
    });
    row?.querySelector(".area-del").addEventListener("click", () => {
      if (!confirm(`Poistetaanko alue "${area.name}"?`)) return;
      update(st => { st.forbiddenAreas = st.forbiddenAreas.filter(a => a.id !== area.id); });
      rerender();
    });
  });
  return wrap;
}

function areaRowHtml(area) {
  return `
    <div class="row" data-area-id="${escapeAttr(area.id)}" style="justify-content:space-between;">
      <label style="flex-direction:row; align-items:center;">
        <input class="area-enabled switch" type="checkbox" ${area.enabled !== false ? "checked" : ""}>
        ${escapeText(area.name)} <span class="text-muted nowrap">(${(area.ring || []).length} pistettä)</span>
      </label>
      <button class="icon-btn area-del" title="Poista">✕</button>
    </div>
  `;
}

