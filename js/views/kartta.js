// Real-data read-only visualization: CP pins + a chosen course's route +
// forbidden areas, projected from lat/lng into an illustrative SVG canvas.
// Full georeferencing (map upload, pixel calibration, Valhalla routing) is
// explicitly deferred to a later pass — the three toolbar buttons below stay
// toast-only until then.
import { getState } from "../state.js";
import { escapeText, escapeAttr } from "../util/format.js";

const VB_W = 760, VB_H = 500, PAD = 50;

export function render(root) {
  const state = getState();
  const card = document.createElement("section");
  card.className = "card";
  const courseOptions = state.courses.map(c => `<option value="${escapeAttr(c.id)}">${escapeText(c.name)}</option>`).join("");
  card.innerHTML = `
    <div class="toolbar">
      <button class="secondary" data-demo-action="Kartan lataus (PDF/kuva) ja kalibrointi kytketään taustaan seuraavassa vaiheessa.">Lataa kartta…</button>
      <button class="secondary" data-demo-action="Kalibrointi kytketään taustaan seuraavassa vaiheessa.">Kalibroi pisteet</button>
      <button class="secondary" data-demo-action="Kielletyn alueen piirto kytketään taustaan seuraavassa vaiheessa.">+ Piirrä kielletty alue</button>
      <label style="margin-left:auto; display:flex; align-items:center; gap:0.4rem;">
        Näytä rata
        <select class="course-select">
          <option value="">— ei mitään —</option>
          ${courseOptions}
        </select>
      </label>
    </div>
    <div class="map-wrap"></div>
    <div class="map-layers">
      <label><input class="layer-cps switch" type="checkbox" checked> Rastit</label>
      <label><input class="layer-route switch" type="checkbox" checked> Radat</label>
      <label><input class="layer-labels switch" type="checkbox" checked> Nimet</label>
      <label><input class="layer-forbidden switch" type="checkbox" checked> Kielletyt alueet</label>
    </div>
  `;
  root.appendChild(card);

  const mapWrap = card.querySelector(".map-wrap");
  const courseSelect = card.querySelector(".course-select");
  const layerCps = card.querySelector(".layer-cps");
  const layerRoute = card.querySelector(".layer-route");
  const layerLabels = card.querySelector(".layer-labels");
  const layerForbidden = card.querySelector(".layer-forbidden");

  if (state.courses[0]) courseSelect.value = state.courses[0].id;

  function redraw() {
    mapWrap.innerHTML = mapSvg({
      courseId: courseSelect.value,
      showCps: layerCps.checked,
      showRoute: layerRoute.checked,
      showLabels: layerLabels.checked,
      showForbidden: layerForbidden.checked
    });
  }
  [courseSelect, layerCps, layerRoute, layerLabels, layerForbidden].forEach(el => el.addEventListener("change", redraw));
  redraw();
}

// Linear min/max projection of lat/lng onto the SVG canvas — illustrative
// only (no real map image or calibration behind it yet).
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
  return (p) => {
    if (p.lat == null || p.lng == null) return [VB_W / 2, VB_H / 2];
    const x = PAD + ((p.lng - minLng) / lngSpan) * (VB_W - 2 * PAD);
    const y = PAD + (1 - (p.lat - minLat) / latSpan) * (VB_H - 2 * PAD); // higher lat = smaller y (north-up)
    return [x, y];
  };
}

function mapSvg({ courseId, showCps, showRoute, showLabels, showForbidden }) {
  const state = getState();
  const allPts = [
    ...state.controlPoints,
    ...(state.forbiddenAreas || []).flatMap(a => a.points || (Array.isArray(a) ? a : []))
  ];
  const project = buildProjector(allPts);

  const course = state.courses.find(c => c.id === courseId);

  const gridLines = `
    ${Array.from({ length: 8 }).map((_, i) => `<line x1="0" y1="${i * VB_H / 7}" x2="${VB_W}" y2="${i * VB_H / 7}" stroke="#232830" stroke-width="1"></line>`).join("")}
    ${Array.from({ length: 12 }).map((_, i) => `<line x1="${i * VB_W / 11}" y1="0" x2="${i * VB_W / 11}" y2="${VB_H}" stroke="#232830" stroke-width="1"></line>`).join("")}
  `;

  const forbiddenHtml = showForbidden ? (state.forbiddenAreas || []).map(area => {
    const points = area.points || (Array.isArray(area) ? area : []);
    if (points.length < 3) return "";
    const poly = points.map(p => project(p).join(",")).join(" ");
    const [lx, ly] = project(points[0]);
    return `
      <polygon points="${poly}" fill="rgba(255,107,107,0.18)" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="4 3"></polygon>
      ${showLabels ? `<text x="${lx}" y="${ly - 6}" font-size="11" fill="var(--danger)">${escapeText(area.name || "Kielletty alue")}</text>` : ""}
    `;
  }).join("") : "";

  const routeHtml = (showRoute && course)
    ? `<polyline points="${course.stops.map(s => project(state.controlPoints.find(cp => cp.id === s.cpId) || {}).join(",")).join(" ")}" fill="none" stroke="var(--ok)" stroke-width="2.5" stroke-dasharray="6 4"></polyline>`
    : "";

  const pinsHtml = showCps ? state.controlPoints.map(cp => {
    const [x, y] = project(cp);
    const sleeping = cp.isSleepingCp ? ` stroke="var(--warn)"` : ` stroke="#fff"`;
    return `
      <circle cx="${x}" cy="${y}" r="7" fill="var(--accent)"${sleeping} stroke-width="2"></circle>
      ${showLabels ? `<text x="${x + 11}" y="${y + 4}" font-size="13" fill="#e8ecf1">${escapeText(cp.name)}</text>` : ""}
    `;
  }).join("") : "";

  return `
    <svg class="map-placeholder-svg" viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet">
      <rect x="0" y="0" width="${VB_W}" height="${VB_H}" fill="#171a1f"></rect>
      <g opacity="0.5">${gridLines}</g>
      ${forbiddenHtml}
      ${routeHtml}
      ${pinsHtml}
    </svg>
  `;
}
