import { test } from "node:test";
import assert from "node:assert/strict";
import {
  haversineM, optimizeRouteOrder, parseCoords, formatCoords,
  decodePolyline, polylineLengthM
} from "../js/model/route.js";

// A real pedestrian leg fetched from the Valhalla FOSSGIS server, Espoo,
// 60.1655,24.6564 -> 60.1750,24.6800. Its trip summary reported 1.964 km.
const VALHALLA_SHAPE = "{vewqBek|_n@iEHBqB@ij@Rs_AHqk@?oHFm[Lch@DoMsK{BuLeCcCg@}NoLuQuK{D}@}DVeChAeFfDuBjAyQ}@qSImDsX_F_ZqDmT_A~@qCnCgAiHk@yDw@aC}IaPo@cAi@Gk@TkAeBgAgBCuAs@kCkC_E_AyAsZue@uBcEa@iAyBcGm[m}@aDaJkByI}@iGm@oFSsGMuGaAu@}AP}Ar@mB?mAa@gFqByBuAy@oBiAsB[_FcJg\\glAijDsB_G{t@e{BiG}Rs@_GdA_FRk@Ui@sByEWm@qB|CsDpBkCCc@gBeAmCuLsTuHmQkd@wkAyEgIkD{J{DrDoFw[_EcR_@cDuAsMcJe]oDqWIsAs@sLiKis@sD{VuBiKiAg@}DyVwEyWtMyHlDe@hEaDhBmBpAeCx@{ED_TXyDl@wAd@q@";

test("haversineM: ~111 km between (0,0) and (1,0) — one degree of latitude", () => {
  const d = haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  // 1° latitude ≈ 111195 m
  assert.ok(Math.abs(d - 111195) < 200, `expected ~111195, got ${d}`);
});

test("haversineM: same point → 0", () => {
  const d = haversineM({ lat: 60.17, lng: 24.94 }, { lat: 60.17, lng: 24.94 });
  assert.equal(d, 0);
});

test("optimizeRouteOrder: 4 points in a square, start at corner 0 → visits corners in cycle order", () => {
  // Square in metres (using tiny degree values near the equator)
  const pts = [
    { lat: 0,        lng: 0 },        // 0  start
    { lat: 0.001,    lng: 0 },        // 1
    { lat: 0.001,    lng: 0.001 },    // 2
    { lat: 0,        lng: 0.001 }     // 3
  ];
  const order = optimizeRouteOrder(pts, 0);
  // Expected: 0 → 1 → 2 → 3 (or 0 → 3 → 2 → 1) — both are optimal cycles.
  assert.equal(order[0], 0);
  assert.equal(order.length, 4);
  // Adjacent in result must also be adjacent on the square (no diagonals).
  const isAdj = (a, b) => {
    const da = Math.abs(a - b);
    return da === 1 || da === 3;
  };
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(isAdj(order[i], order[i+1]), `non-adjacent step at ${i}: ${order[i]}→${order[i+1]}`);
  }
});

test("optimizeRouteOrder: ignores points with null coordinates by excluding them from order", () => {
  const pts = [
    { lat: 0, lng: 0 },
    { lat: null, lng: null },
    { lat: 0.001, lng: 0 }
  ];
  const order = optimizeRouteOrder(pts, 0);
  assert.deepEqual(order, [0, 2]);
});

test("optimizeRouteOrder: when start index has no coords, throws", () => {
  const pts = [{ lat: null, lng: null }, { lat: 0, lng: 0 }];
  assert.throws(() => optimizeRouteOrder(pts, 0), /start/i);
});

test("parseCoords: Google Maps DMS format with apostrophe and double-quote", () => {
  const r = parseCoords(`60°11'43.0"N 24°44'03.8"E`);
  assert.ok(Math.abs(r.lat - 60.195278) < 0.0001, `lat=${r.lat}`);
  assert.ok(Math.abs(r.lng - 24.734389) < 0.0001, `lng=${r.lng}`);
});

test("parseCoords: DMS with prime and double-prime unicode chars", () => {
  const r = parseCoords("60°11′43.0″N 24°44′03.8″E");
  assert.ok(Math.abs(r.lat - 60.195278) < 0.0001);
  assert.ok(Math.abs(r.lng - 24.734389) < 0.0001);
});

test("parseCoords: DMS with South/West hemispheres → negative decimals", () => {
  const r = parseCoords(`33°51'52.0"S 151°12'33.0"W`);
  assert.ok(r.lat < 0);
  assert.ok(r.lng < 0);
});

test("parseCoords: DMS with lng before lat (E/W first)", () => {
  const r = parseCoords(`24°44'03.8"E 60°11'43.0"N`);
  assert.ok(Math.abs(r.lat - 60.195278) < 0.0001);
  assert.ok(Math.abs(r.lng - 24.734389) < 0.0001);
});

test("parseCoords: decimal with comma", () => {
  const r = parseCoords("60.17, 24.94");
  assert.equal(r.lat, 60.17);
  assert.equal(r.lng, 24.94);
});

test("parseCoords: decimal with single space", () => {
  const r = parseCoords("60.17 24.94");
  assert.equal(r.lat, 60.17);
  assert.equal(r.lng, 24.94);
});

test("parseCoords: negative decimals", () => {
  const r = parseCoords("-33.8688, 151.2093");
  assert.equal(r.lat, -33.8688);
  assert.equal(r.lng, 151.2093);
});

test("parseCoords: empty / null / garbage → null", () => {
  assert.equal(parseCoords(""), null);
  assert.equal(parseCoords(null), null);
  assert.equal(parseCoords("not coords"), null);
  assert.equal(parseCoords("60°"), null);
});

test("formatCoords: pair → 'lat, lng' with 6 decimals", () => {
  assert.equal(formatCoords({ lat: 60.195278, lng: 24.734389 }), "60.195278, 24.734389");
});

test("formatCoords: missing coords → empty string", () => {
  assert.equal(formatCoords({ lat: null, lng: null }), "");
  assert.equal(formatCoords(null), "");
});

test("decodePolyline: decodes a real Valhalla leg at precision 6", () => {
  const pts = decodePolyline(VALHALLA_SHAPE);
  assert.equal(pts.length, 107);
  // Endpoints snap to the nearest routable way, so allow a short stub.
  assert.ok(haversineM(pts[0], { lat: 60.1655, lng: 24.6564 }) < 30,
    `start is ${haversineM(pts[0], { lat: 60.1655, lng: 24.6564 })} m from the request`);
  assert.ok(haversineM(pts[pts.length - 1], { lat: 60.1750, lng: 24.6800 }) < 30);
});

test("decodePolyline: summed length matches Valhalla's own trip summary", () => {
  const m = polylineLengthM(decodePolyline(VALHALLA_SHAPE));
  assert.ok(Math.abs(m - 1964) < 15, `expected ~1964 m, got ${m}`);
});

test("decodePolyline: the walking route is longer than the straight line", () => {
  const pts = decodePolyline(VALHALLA_SHAPE);
  const straight = haversineM(pts[0], pts[pts.length - 1]);
  const walked = polylineLengthM(pts);
  assert.ok(walked > straight, "a foot route cannot be shorter than the crow flies");
  assert.ok(walked / straight > 1.1, `detour factor was only ${walked / straight}`);
});

test("decodePolyline: precision 5 would misplace the points by continents", () => {
  // Guards against silently decoding a Valhalla shape with Google's precision.
  const p6 = decodePolyline(VALHALLA_SHAPE, 6)[0];
  const p5 = decodePolyline(VALHALLA_SHAPE, 5)[0];
  assert.ok(Math.abs(p5.lat) > 600, `precision 5 gives lat ${p5.lat}`);
  assert.ok(Math.abs(p6.lat - 60.1655) < 0.001);
});

test("decodePolyline: known tiny polyline round-trips to expected coordinates", () => {
  // Google's documented example string, at its native precision 5.
  const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
  assert.equal(pts.length, 3);
  assert.ok(Math.abs(pts[0].lat - 38.5) < 1e-9, `lat ${pts[0].lat}`);
  assert.ok(Math.abs(pts[0].lng + 120.2) < 1e-9, `lng ${pts[0].lng}`);
  assert.ok(Math.abs(pts[1].lat - 40.7) < 1e-9);
  assert.ok(Math.abs(pts[1].lng + 120.95) < 1e-9);
  assert.ok(Math.abs(pts[2].lat - 43.252) < 1e-9);
  assert.ok(Math.abs(pts[2].lng + 126.453) < 1e-9);
});

test("decodePolyline: empty / null input → empty array", () => {
  assert.deepEqual(decodePolyline(""), []);
  assert.deepEqual(decodePolyline(null), []);
  assert.deepEqual(decodePolyline(undefined), []);
});

test("decodePolyline: truncated input returns the points decoded so far", () => {
  const full = decodePolyline(VALHALLA_SHAPE);
  const cut = decodePolyline(VALHALLA_SHAPE.slice(0, 40));
  assert.ok(cut.length > 0 && cut.length < full.length);
  // Whatever survived must still be correct, not garbage.
  assert.ok(haversineM(cut[0], full[0]) < 1e-6);
});

test("polylineLengthM: fewer than two points has no length", () => {
  assert.equal(polylineLengthM([]), 0);
  assert.equal(polylineLengthM([{ lat: 60, lng: 24 }]), 0);
});
