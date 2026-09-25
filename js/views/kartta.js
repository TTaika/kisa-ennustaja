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
import { getMapFile, putMapFile, clearMapFile, mapRevision } from "../io/mapstore.js";
import { renderMapFileToCanvas, canvasEventToRefPx } from "../util/mapRender.js";
import { fitSimilarity, pxToLl, llToPx, calibrationQuality } from "../model/georef.js";
import { haversineM, parseCoords, decodePolyline } from "../model/route.js";
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
let uiMode = "view"; // "view" | "calibrate" | "drawArea" | "placeCp"
let pendingRing = []; // [{lat,lng}, ...] while uiMode === "drawArea"
let placeCpActiveId = null; // which coord-less CP the next map click will place, while uiMode === "placeCp"
const rasterCache = { key: null, canvas: null, refScale: 1, pageCount: 1 };

// Zoom/pan of the map surface itself (not a georeference fit) — lets a user
// zoom in tight to click a precise pixel when calibrating a detailed PDF.
// Ephemeral like the rest of this block; survives rerender() (module-level)
// but resets when a different map file is loaded.
const ZOOM_MIN = 1, ZOOM_MAX = 10;
let mapZoom = 1, mapPanX = 0, mapPanY = 0;

function resetMapView() { mapZoom = 1; mapPanX = 0; mapPanY = 0; }

// The map-wrap's height is user-resizable (native CSS `resize: vertical`
// handle) so a wide/landscape race map has room to actually show more of
// its width. rerender() rebuilds the whole card on nearly every action
// (adding a calibration point, toggling a layer, ...), so without this the
// resized height would snap back to default after almost every click.
let mapWrapHeightPx = null;

// rerender() (router.js) wipes and rebuilds the ENTIRE view from scratch,
// which resets the map-wrap to its "Ladataan karttaa…" loading placeholder
// for a frame before drawMap()'s async work resolves — a visible flicker on
// every single click while placing a CP, drawing a forbidden area, dragging
// a pin, or editing a calibration point. softRefresh() instead only touches
// the map canvas (drawMap on the still-mounted mapWrap, so the previous
// frame stays on screen until the new one is ready) and whichever side
// panel is relevant — set up fresh at the top of render() each time, so any
// click handler anywhere in this module can call it without prop-drilling.
let softRefresh = () => rerender();

export function render(root) {
  const state = getState();
  const card = document.createElement("section");
  card.className = "card";
  const courseOptions = state.courses.map(c => `<option value="${escapeAttr(c.id)}">${escapeText(c.name)}</option>`).join("");
  const hasMap = !!state.map.fileName;
  const hasFit = !!currentFit();
  card.innerHTML = `
    <div class="toolbar">
      <input type="file" id="map-file-input" accept="image/*,application/pdf" hidden>
      <button class="secondary" id="btn-load-map">Lataa kartta…</button>
      ${hasMap ? `<button class="secondary" id="btn-clear-map">Poista kartta</button>` : ""}
      <button class="secondary" id="btn-calibrate" ${hasMap ? "" : "disabled title=\"Lataa kartta ensin\""}>${uiMode === "calibrate" ? "Lopeta kalibrointi" : "Kalibroi pisteet"}</button>
      <button class="secondary" id="btn-place-cp" ${hasFit ? "" : "disabled title=\"Kalibroi kartta ensin\""}>${uiMode === "placeCp" ? "Lopeta tuonti" : "Tuo rasteja käsin"}</button>
      <button class="secondary" id="btn-draw-area">${uiMode === "drawArea" ? "Lopeta piirto" : "+ Piirrä kielletty alue"}</button>
      <label style="margin-left:auto; display:flex; align-items:center; gap:0.4rem;">
        Näytä rata
        <select class="course-select">
          <option value="">— ei mitään —</option>
          <option value="__all__">Kaikki radat</option>
          ${courseOptions}
        </select>
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
    ${hasMap && !currentFit() ? `<p class="text-caution">Kartta on ladattu, mutta ei vielä kalibroitu — rastit ja radat eivät näy sen päällä ennen kuin lisäät vähintään 2 kalibrointipistettä ("Kalibroi pisteet").</p>` : ""}
    ${hasMap && currentFit() ? `<p class="text-muted">Voit raahata rastin sen oikealle paikalleen kartalla.</p>` : ""}
    <div id="map-page-nav"></div>
    <div class="map-wrap"><div class="placeholder">Ladataan karttaa…</div></div>
    <div id="map-legend"></div>
    <div id="calibration-panel"></div>
    <div id="place-cp-panel"></div>
    <div id="forbidden-panel"></div>
  `;
  root.appendChild(card);

  const mapWrap = card.querySelector(".map-wrap");
  if (mapWrapHeightPx) mapWrap.style.height = `${mapWrapHeightPx}px`;
  mapWrap.addEventListener("pointerup", () => { mapWrapHeightPx = mapWrap.getBoundingClientRect().height; });
  const courseSelect = card.querySelector(".course-select");
  const layerCps = card.querySelector(".layer-cps");
  const layerRoute = card.querySelector(".layer-route");
  const layerLabels = card.querySelector(".layer-labels");
  const layerDistances = card.querySelector(".layer-distances");
  const layerForbidden = card.querySelector(".layer-forbidden");
  if (state.map.layers.showAllCourses) {
    courseSelect.value = "__all__";
  } else if (state.courses[0] && !courseSelect.value) {
    courseSelect.value = state.courses[0].id;
  }

  initDropdownMenu(card.querySelector(".dropdown-menu-trigger"), card.querySelector(".map-layers-menu"));

  function currentLayers() {
    return {
      showControlPoints: layerCps.checked,
      showRoutes: layerRoute.checked,
      showAllCourses: courseSelect.value === "__all__",
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

  card.querySelector("#btn-load-map").addEventListener("click", () => {
    card.querySelector("#map-file-input").click();
  });
  card.querySelector("#map-file-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      await putMapFile(file);
      rasterCache.key = null; // force a re-decode
      resetMapView();
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
    resetMapView();
    uiMode = "view";
    update(st => { st.map.fileName = null; st.map.pageIndex = 0; st.map.calibration.points = []; });
    rerender();
  });
  card.querySelector("#btn-calibrate").addEventListener("click", () => {
    uiMode = uiMode === "calibrate" ? "view" : "calibrate";
    pendingRing = [];
    rerender();
  });
  card.querySelector("#btn-place-cp").addEventListener("click", () => {
    if (uiMode === "placeCp") {
      uiMode = "view";
    } else {
      uiMode = "placeCp";
      placeCpActiveId = pendingCps(getState())[0]?.id || null;
    }
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

  function refreshSidePanels() {
    const calibEl = card.querySelector("#calibration-panel");
    const placeCpEl = card.querySelector("#place-cp-panel");
    const forbiddenEl = card.querySelector("#forbidden-panel");
    if (!calibEl || !placeCpEl || !forbiddenEl) return; // card was torn down mid-flight
    calibEl.innerHTML = ""; placeCpEl.innerHTML = ""; forbiddenEl.innerHTML = "";
    if (uiMode === "calibrate") calibEl.appendChild(calibrationPanel(redraw));
    if (uiMode === "placeCp") placeCpEl.appendChild(placeCpPanel());
    if (uiMode === "drawArea") forbiddenEl.appendChild(drawAreaToolbar());
    if (uiMode !== "drawArea") forbiddenEl.appendChild(forbiddenAreaList());
  }
  softRefresh = () => { if (mapWrap.isConnected) { redraw(); refreshSidePanels(); } };

  refreshSidePanels();
}

// CPs missing a lat/lng — invisible on the map (nothing to project), and
// what "Tuo rasteja käsin" lets the user place there one by one.
function pendingCps(state) {
  return state.controlPoints.filter(cp => cp.lat == null || cp.lng == null);
}

function placeCpPanel() {
  const state = getState();
  const pending = pendingCps(state);
  const wrap = document.createElement("div");
  wrap.className = "card";
  if (pending.length === 0) {
    wrap.innerHTML = `
      <h3 class="subhead">Tuo rasteja käsin</h3>
      <p class="text-muted">Kaikilla rasteilla on jo sijainti kartalla.</p>
    `;
    return wrap;
  }
  if (!pending.some(cp => cp.id === placeCpActiveId)) placeCpActiveId = pending[0].id;
  const active = pending.find(cp => cp.id === placeCpActiveId);
  wrap.innerHTML = `
    <h3 class="subhead">Tuo rasteja käsin</h3>
    <p class="text-muted">Napauta karttaa sijoittaaksesi rastin <strong>${escapeText(active.name)}</strong> sen oikealle paikalle. Voit valita toisen rastin alta ennen napautusta.</p>
    <div class="team-grid">
      ${pending.map(cp => `<button type="button" class="${cp.id === placeCpActiveId ? "" : "secondary"} place-cp-chip" data-cp-id="${escapeAttr(cp.id)}">${escapeText(cp.name)}</button>`).join("")}
    </div>
  `;
  wrap.querySelectorAll(".place-cp-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      placeCpActiveId = btn.dataset.cpId;
      softRefresh();
    });
  });
  return wrap;
}

// ── Raster loading + drawing ────────────────────────────────────────────
async function ensureRaster(mapWrap) {
  const state = getState();
  if (!state.map.fileName) { rasterCache.key = null; return null; }
  // Keyed off state (synchronously known) rather than the IndexedDB record,
  // so a cache hit — the common case, since drawMap() runs on every map
  // interaction — never has to await an IndexedDB read at all.
  const key = `${mapRevision()}|${state.map.fileName}|${state.map.pageIndex}|${state.map.renderDpi}`;
  if (rasterCache.key === key) return rasterCache;
  const record = await getMapFile();
  if (!record) { rasterCache.key = null; return null; }
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
    softRefresh();
  });
  pageNav.querySelector("#btn-next-page")?.addEventListener("click", () => {
    rasterCache.key = null;
    update(st => { st.map.pageIndex = Math.min(raster.pageCount - 1, st.map.pageIndex + 1); });
    softRefresh();
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

// ── Zoom/pan wiring ──────────────────────────────────────────────────────
// Wires wheel-to-zoom (centered on the cursor) and drag-to-pan onto `el` (a
// freshly created canvas/svg just appended into mapWrap) via CSS transform.
// getBoundingClientRect-based coordinate math elsewhere (canvasEventToRefPx,
// svgClickToLatLng's getScreenCTM) already accounts for CSS transforms, so
// calibration/area-drawing clicks stay pixel-accurate at any zoom level —
// that precision is the whole point of adding this for PDF calibration.
// Uses property-assignment (mapWrap.onwheel = ...) rather than
// addEventListener: mapWrap itself is NOT recreated between redraw() calls
// within one render() (only its children are), so addEventListener would
// otherwise pile up a new listener on every layer toggle.
function applyMapTransform(el) {
  el.style.transform = `translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom})`;
}

function zoomBy(factor, cx = 0, cy = 0) {
  const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, mapZoom * factor));
  if (newZoom === mapZoom) return;
  // Keep the map point under (cx, cy) — relative to mapWrap's center —
  // stationary on screen as the zoom level changes.
  mapPanX = cx - (cx - mapPanX) * (newZoom / mapZoom);
  mapPanY = cy - (cy - mapPanY) * (newZoom / mapZoom);
  mapZoom = newZoom;
}

function zoomControlsEl(el) {
  const wrap = document.createElement("div");
  wrap.className = "map-zoom-controls";
  wrap.innerHTML = `
    <button type="button" class="icon-btn zoom-in" title="Lähennä">+</button>
    <span class="zoom-level">${Math.round(mapZoom * 100)}%</span>
    <button type="button" class="icon-btn zoom-out" title="Loitonna">−</button>
    <button type="button" class="icon-btn zoom-reset" title="Nollaa näkymä">⤾</button>
  `;
  const levelEl = wrap.querySelector(".zoom-level");
  const refresh = () => { applyMapTransform(el); levelEl.textContent = `${Math.round(mapZoom * 100)}%`; };
  wrap.querySelector(".zoom-in").addEventListener("click", () => { zoomBy(1.25); refresh(); });
  wrap.querySelector(".zoom-out").addEventListener("click", () => { zoomBy(1 / 1.25); refresh(); });
  wrap.querySelector(".zoom-reset").addEventListener("click", () => { resetMapView(); refresh(); });
  return wrap;
}

// onClick(evt) fires only for a genuine click (pointerdown→up with no real
// movement) — pass null in view mode, where a click has nothing to do.
function wirePanZoom(mapWrap, el, onClick) {
  applyMapTransform(el);

  let dragging = false, moved = false;
  let startX = 0, startY = 0, startPanX = 0, startPanY = 0;

  mapWrap.onwheel = (evt) => {
    evt.preventDefault();
    const rect = mapWrap.getBoundingClientRect();
    zoomBy(evt.deltaY < 0 ? 1.25 : 1 / 1.25, evt.clientX - rect.left - rect.width / 2, evt.clientY - rect.top - rect.height / 2);
    applyMapTransform(el);
    const levelEl = mapWrap.querySelector(".zoom-level");
    if (levelEl) levelEl.textContent = `${Math.round(mapZoom * 100)}%`;
  };
  mapWrap.onpointerdown = (evt) => {
    if (evt.button !== 0 || evt.target.closest(".map-zoom-controls")) return;
    dragging = true; moved = false;
    startX = evt.clientX; startY = evt.clientY;
    startPanX = mapPanX; startPanY = mapPanY;
    mapWrap.setPointerCapture(evt.pointerId);
    mapWrap.classList.add("dragging");
  };
  mapWrap.onpointermove = (evt) => {
    if (!dragging) return;
    const dx = evt.clientX - startX, dy = evt.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    if (moved) {
      mapPanX = startPanX + dx;
      mapPanY = startPanY + dy;
      applyMapTransform(el);
    }
  };
  mapWrap.onpointerup = (evt) => {
    if (!dragging) return;
    dragging = false;
    mapWrap.classList.remove("dragging");
    if (!moved) onClick?.(evt);
  };
  mapWrap.onpointercancel = () => { dragging = false; mapWrap.classList.remove("dragging"); };

  mapWrap.appendChild(zoomControlsEl(el));
}

// ── CP-pin dragging (view mode, calibrated map only) ────────────────────
// Lets the user place a rasti directly on the georeferenced map by dragging
// its pin, instead of typing lat/lng by hand — the whole point of having
// calibrated a real map in the first place. Wired on the canvas itself (a
// fresh element every redraw, so plain addEventListener is safe here,
// unlike mapWrap's persistent listeners above) and takes priority over
// wirePanZoom's drag-to-pan via stopPropagation when a pin is actually hit.
const CP_HIT_RADIUS_SCREEN_PX = 14;

function wireCpDrag(canvas, raster, fit, scene, ctx) {
  const accent = cssVar("--accent", "#9c3a98");
  const project = (lat, lng) => {
    const { px, py } = llToPx(fit, lat, lng);
    return [px / raster.refScale, py / raster.refScale];
  };
  let draggingCp = null;

  function canvasNativeXY(evt) {
    const rect = canvas.getBoundingClientRect();
    return [
      (evt.clientX - rect.left) * (canvas.width / rect.width),
      (evt.clientY - rect.top) * (canvas.height / rect.height)
    ];
  }

  function hitTestCp(mx, my, rect) {
    const hitR = CP_HIT_RADIUS_SCREEN_PX * (canvas.width / rect.width);
    let best = null, bestDist = hitR;
    for (const cp of scene.cps) {
      if (cp.lat == null || cp.lng == null) continue;
      const [x, y] = project(cp.lat, cp.lng);
      const d = Math.hypot(x - mx, y - my);
      if (d <= bestDist) { best = cp; bestDist = d; }
    }
    return best;
  }

  function redrawWithDraggedPin(mx, my) {
    ctx.drawImage(raster.canvas, 0, 0);
    drawSceneOnCanvas(ctx, { ...scene, cps: scene.cps.filter(c => c.id !== draggingCp.id) }, project);
    drawCpPin(ctx, mx, my, draggingCp, scene.showLabels, accent);
  }

  canvas.addEventListener("pointerdown", (evt) => {
    if (evt.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const [mx, my] = canvasNativeXY(evt);
    const cp = hitTestCp(mx, my, rect);
    if (!cp) return;
    evt.stopPropagation(); // pin drag, not a map pan
    draggingCp = cp;
    canvas.setPointerCapture(evt.pointerId);
    canvas.classList.add("cp-dragging");
    canvas.style.cursor = "grabbing";
    redrawWithDraggedPin(mx, my);
  });
  canvas.addEventListener("pointermove", (evt) => {
    const [mx, my] = canvasNativeXY(evt);
    if (draggingCp) { redrawWithDraggedPin(mx, my); return; }
    // Hover feedback so a pin reads as draggable before the user commits.
    canvas.style.cursor = hitTestCp(mx, my, canvas.getBoundingClientRect()) ? "grab" : "";
  });
  canvas.addEventListener("pointerleave", () => {
    if (!draggingCp) canvas.style.cursor = "";
  });
  canvas.addEventListener("pointerup", (evt) => {
    if (!draggingCp) return;
    const cpId = draggingCp.id;
    draggingCp = null;
    canvas.classList.remove("cp-dragging");
    canvas.style.cursor = "";
    const [mx, my] = canvasNativeXY(evt);
    const ll = pxToLl(fit, mx * raster.refScale, my * raster.refScale);
    update(st => {
      const cp = st.controlPoints.find(c => c.id === cpId);
      if (cp) { cp.lat = ll.lat; cp.lng = ll.lng; }
    });
    softRefresh();
  });
  canvas.addEventListener("pointercancel", () => {
    draggingCp = null;
    canvas.classList.remove("cp-dragging");
    canvas.style.cursor = "";
  });
}

// Click handling on the calibrated raster canvas — differs per uiMode; null
// (no click action) for plain "view", where wireCpDrag handles pin drags.
function mapClickHandler(canvas, raster, fit) {
  if (uiMode === "drawArea") {
    return (evt) => {
      const { px, py } = canvasEventToRefPx(canvas, evt, raster.refScale);
      pendingRing.push(pxToLl(fit, px, py));
      softRefresh();
    };
  }
  if (uiMode === "placeCp") {
    return (evt) => {
      const pending = pendingCps(getState());
      const target = pending.find(cp => cp.id === placeCpActiveId) || pending[0];
      if (!target) return;
      const { px, py } = canvasEventToRefPx(canvas, evt, raster.refScale);
      const ll = pxToLl(fit, px, py);
      update(st => {
        const cp = st.controlPoints.find(c => c.id === target.id);
        cp.lat = ll.lat; cp.lng = ll.lng;
      });
      // target now has coords, so it's already out of the pending list.
      placeCpActiveId = pendingCps(getState())[0]?.id || null;
      softRefresh();
    };
  }
  return null;
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

  if (raster && fit) {
    const scene = buildScene(state, courseId, layers, fit);
    renderLegend(legendEl, scene);
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
    if (uiMode === "view") wireCpDrag(canvas, raster, fit, scene, ctx);
    wirePanZoom(mapWrap, canvas, mapClickHandler(canvas, raster, fit));
  } else if (raster) {
    // Uploaded but not yet calibrated: show the raw file as-is so the user
    // can see it actually loaded — there's no fit yet to correctly place
    // rastit/radat on top of it (that's what "Kalibroi pisteet" is for).
    renderLegend(legendEl, { routes: [] });
    const canvas = document.createElement("canvas");
    canvas.className = "map-canvas";
    canvas.width = raster.canvas.width;
    canvas.height = raster.canvas.height;
    mapWrap.innerHTML = "";
    mapWrap.appendChild(canvas);
    canvas.getContext("2d").drawImage(raster.canvas, 0, 0);
    wirePanZoom(mapWrap, canvas, null);
  } else {
    const scene = buildScene(state, courseId, layers, fit);
    renderLegend(legendEl, scene);
    mapWrap.innerHTML = illustrativeSvg(state, scene);
    const svg = mapWrap.querySelector("svg");
    wirePanZoom(mapWrap, svg, uiMode === "drawArea" ? (evt) => {
      const ll = svgClickToLatLng(svg, evt, scene.projector);
      if (ll) { pendingRing.push(ll); softRefresh(); }
    } : null);
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
  wirePanZoom(mapWrap, canvas, (evt) => {
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
  const routes = coursesToShow.map((course, i) => {
    // legs carry the REAL walked path (decoded from routeShape, fetched by
    // "Laske etäisyydet" in Radat) when available, snapped to the exact CP
    // endpoints — the routing server's own geometry starts/ends ~10-15m off
    // the requested point. Falls back to a straight line for any leg whose
    // distance hasn't been fetched yet, same as before this existed.
    const legs = [];
    let prevCp = null;
    for (const stop of course.stops) {
      const cp = state.controlPoints.find(c => c.id === stop.cpId);
      if (!cp) continue;
      if (prevCp) {
        const routed = stop.routeShape ? decodePolyline(stop.routeShape) : null;
        const points = routed && routed.length ? [prevCp, ...routed, cp] : [prevCp, cp];
        legs.push({ points, distanceM: stop.distanceM ?? null });
      }
      prevCp = cp;
    }
    return {
      id: course.id,
      name: course.name,
      color: layers.showAllCourses ? ROUTE_PALETTE[i % ROUTE_PALETTE.length] : "var(--ok)",
      legs
    };
  });
  const areas = layers.showForbidden ? (state.forbiddenAreas || []) : [];
  // Include route-shape points too, not just the CPs — a detoured real path
  // can bow out well past the straight line between its two endpoints, and
  // the illustrative view's bounding box needs to cover that or the route
  // gets clipped/squished against the edge.
  const allPts = [...state.controlPoints, ...areas.flatMap(a => a.ring || []), ...routes.flatMap(r => r.legs.flatMap(l => l.points))];
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
    if (route.legs.length === 0) continue;
    ctx.beginPath();
    route.legs.forEach((leg, legIdx) => {
      leg.points.forEach((p, i) => {
        const [x, y] = project(p.lat, p.lng);
        (legIdx === 0 && i === 0) ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
    });
    ctx.strokeStyle = resolveCanvasColor(route.color);
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (scene.showDistances) {
      for (const leg of route.legs) {
        const mid = leg.points[Math.floor(leg.points.length / 2)];
        const [x, y] = project(mid.lat, mid.lng);
        const m = Math.round(leg.distanceM ?? haversineM(leg.points[0], leg.points[leg.points.length - 1]));
        haloText(ctx, `${m} m`, x, y);
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
    drawCpPin(ctx, x, y, cp, scene.showLabels, accent);
  }
}

function drawCpPin(ctx, x, y, cp, showLabel, accent) {
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, 2 * Math.PI);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = cp.isSleepingCp ? cssVar("--warn", "#33366b") : "#fff";
  ctx.stroke();
  if (showLabel) haloText(ctx, cp.name, x + 11, y + 4);
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

  const routeHtml = scene.routes.map(route => route.legs.map(leg =>
    `<polyline points="${leg.points.map(p => project(p.lat, p.lng).join(",")).join(" ")}" fill="none" stroke="${escapeAttr(route.color)}" stroke-width="2.5" stroke-dasharray="6 4"></polyline>`
  ).join("")).join("");

  const distanceHtml = scene.showDistances ? scene.routes.map(route =>
    route.legs.map(leg => {
      const mid = leg.points[Math.floor(leg.points.length / 2)];
      const [x, y] = project(mid.lat, mid.lng);
      const m = Math.round(leg.distanceM ?? haversineM(leg.points[0], leg.points[leg.points.length - 1]));
      return `<text x="${x}" y="${y}" font-size="11" fill="#e8ecf1">${m} m</text>`;
    }).join("")
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
  softRefresh();
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
    const parsed = parseCoords(e.target.value);
    update(st => {
      const point = st.map.calibration.points[index];
      point.lat = parsed ? parsed.lat : null;
      point.lng = parsed ? parsed.lng : null;
    });
    softRefresh();
  });
  row.querySelector(".calib-del").addEventListener("click", () => {
    update(st => { st.map.calibration.points.splice(index, 1); });
    softRefresh();
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
      softRefresh();
    }
  });
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
      softRefresh();
    });
    row?.querySelector(".area-del").addEventListener("click", () => {
      if (!confirm(`Poistetaanko alue "${area.name}"?`)) return;
      update(st => { st.forbiddenAreas = st.forbiddenAreas.filter(a => a.id !== area.id); });
      softRefresh();
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

