// Forbidden areas — ground the vartiot must not cross.
//
// An area is a closed ring of { lat, lng } vertices. Rings are stored in real
// coordinates rather than map pixels so that they survive re-calibrating or
// swapping the map file, and so they can be handed straight to a router.
//
// Two consumers, needing different things:
//   - the walking-route fetch, which sends them to Valhalla as exclusions and
//     gets a route that genuinely goes around;
//   - the straight-line distance fill, which cannot avoid anything, so the
//     best it can do is notice that a leg cuts through one and say so.

// Ray casting. Points exactly on an edge are not treated specially: an area
// boundary is drawn by hand and its precise edge is not meaningful.
export function pointInRing(pt, ring) {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lng;
    const yj = ring[j].lat, xj = ring[j].lng;
    const straddles = (yi > pt.lat) !== (yj > pt.lat);
    if (straddles && pt.lng < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function orient(a, b, c) {
  return (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
}

// Proper intersection of two segments. Collinear touching counts as crossing:
// a leg running along a forbidden boundary is not something to wave through.
export function segmentsIntersect(a, b, c, d) {
  const d1 = orient(c, d, a), d2 = orient(c, d, b);
  const d3 = orient(a, b, c), d4 = orient(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSeg = (p, q, r) =>
    Math.min(p.lng, q.lng) <= r.lng && r.lng <= Math.max(p.lng, q.lng) &&
    Math.min(p.lat, q.lat) <= r.lat && r.lat <= Math.max(p.lat, q.lat);
  if (d1 === 0 && onSeg(c, d, a)) return true;
  if (d2 === 0 && onSeg(c, d, b)) return true;
  if (d3 === 0 && onSeg(a, b, c)) return true;
  if (d4 === 0 && onSeg(a, b, d)) return true;
  return false;
}

// Does the straight line from `a` to `b` enter this ring at all?
export function segmentCrossesRing(a, b, ring) {
  if (!ring || ring.length < 3) return false;
  if (pointInRing(a, ring) || pointInRing(b, ring)) return true;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (segmentsIntersect(a, b, ring[j], ring[i])) return true;
  }
  return false;
}

// Names of the areas a straight leg would cut through.
export function areasCrossedBy(a, b, areas) {
  if (!a || !b || a.lat == null || b.lat == null) return [];
  return (areas || [])
    .filter(area => segmentCrossesRing(a, b, area.ring || []))
    .map(area => area.name || "alue");
}

// Points that fall inside an enabled area.
//
// This is worth checking before asking a router for anything: no router will
// start or end a route inside a polygon it has been told to avoid — Valhalla
// answers HTTP 400 — so a rasti inside a forbidden area silently breaks every
// leg that touches it. Catching it here turns "the routing service did not
// answer" into "this rasti is inside this area".
export function pointsInsideAreas(points, areas) {
  const live = (areas || []).filter(a => a && a.enabled !== false && (a.ring || []).length >= 3);
  const out = [];
  for (const p of points || []) {
    if (!p || p.lat == null || p.lng == null) continue;
    for (const area of live) {
      if (pointInRing(p, area.ring)) out.push({ point: p, area });
    }
  }
  return out;
}

// Valhalla wants [lng, lat] pairs and an explicitly closed ring.
export function ringToValhalla(ring) {
  if (!ring || ring.length < 3) return null;
  const out = ring.map(p => [p.lng, p.lat]);
  const first = out[0], last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

export function areasToValhalla(areas) {
  const polys = (areas || [])
    .filter(a => a && a.enabled !== false)
    .map(a => ringToValhalla(a.ring))
    .filter(Boolean);
  return polys.length ? polys : null;
}

// Spherical excess is overkill for a hand-drawn out-of-bounds box; project to
// a local tangent plane and use the shoelace formula. Returns square metres.
export function ringAreaM2(ring) {
  if (!ring || ring.length < 3) return 0;
  const lat0 = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
  const mPerDegLat = 111132;
  const mPerDegLng = 111320 * Math.cos(lat0 * Math.PI / 180);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng * mPerDegLng, yi = ring[i].lat * mPerDegLat;
    const xj = ring[j].lng * mPerDegLng, yj = ring[j].lat * mPerDegLat;
    sum += xj * yi - xi * yj;
  }
  return Math.abs(sum) / 2;
}
