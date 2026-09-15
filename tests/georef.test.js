import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REF_DPI, metresPerRefPx, fitSimilarity, pxToLl, llToPx,
  llToLocal, localToLl, localSphereRadius, calibrationQuality
} from "../js/model/georef.js";
import { haversineM } from "../js/model/route.js";

// Espoo — the area the Punkku map covers.
const ORIGIN = { lat: 60.155, lng: 24.66 };

// Build synthetic calibration points by placing pixels through a known
// transform, so the fit has a ground truth to be checked against.
function synth({ mPerPx, bearingDeg, pixels, origin = ORIGIN }) {
  // Map "up" points at `bearingDeg` clockwise from true north.
  const t = -bearingDeg * Math.PI / 180;
  const cos = Math.cos(t), sin = Math.sin(t);
  return pixels.map(([px, py]) => {
    const u = px, v = -py;
    const e = mPerPx * (cos * u - sin * v);
    const n = mPerPx * (sin * u + cos * v);
    const ll = localToLl({ e, n }, origin);
    return { px, py, lat: ll.lat, lng: ll.lng };
  });
}

// The synthetic points are generated in the tangent plane centred on ORIGIN,
// so the fit has to be pinned to the same frame to be compared against them.
// Left to itself the fit centres on the point centroid, and the two frames'
// norths differ by the meridian convergence between the origins.
const PINNED = { origin: ORIGIN };

test("metresPerRefPx: 1:20 000 at 600 dpi → 0.8467 m per reference pixel", () => {
  const mpp = metresPerRefPx(20000);
  assert.ok(Math.abs(mpp - 0.846667) < 0.0001, `got ${mpp}`);
  // The Punkku map's north lines measured 1181.6 px apart; that must be 1 km.
  assert.ok(Math.abs(1181.6 * mpp - 1000) < 1, `1181.6 px = ${1181.6 * mpp} m`);
});

test("REF_DPI is 600 — calibration pixels are independent of render resolution", () => {
  assert.equal(REF_DPI, 600);
});

test("llToLocal / localToLl round-trip", () => {
  const ll = { lat: 60.1701, lng: 24.6712 };
  const back = localToLl(llToLocal(ll, ORIGIN), ORIGIN);
  assert.ok(Math.abs(back.lat - ll.lat) < 1e-9, `lat ${back.lat}`);
  assert.ok(Math.abs(back.lng - ll.lng) < 1e-9, `lng ${back.lng}`);
});

test("llToLocal: a due-north step has no east component", () => {
  const { n, e } = llToLocal({ lat: ORIGIN.lat + 0.01, lng: ORIGIN.lng }, ORIGIN);
  assert.ok(Math.abs(e) < 1e-9, `e=${e}`);
  assert.ok(n > 1100 && n < 1120, `n=${n}`);   // 0.01° of latitude ≈ 1.11 km
});

test("llToLocal: the frame is isotropic — no direction-dependent scale error", () => {
  // This is the property the whole similarity fit depends on. A frame that
  // scales differently along east and north puts a shear into the data that a
  // 4-DOF similarity has no term for, so it lands in the residuals instead.
  // Measure a fixed 4 km step in 24 bearings against an independent haversine.
  const ratios = [];
  for (let deg = 0; deg < 360; deg += 15) {
    const a = deg * Math.PI / 180;
    const ll = localToLl({ e: 4000 * Math.sin(a), n: 4000 * Math.cos(a) }, ORIGIN);
    ratios.push(haversineM(ORIGIN, ll) / 4000);
  }
  const spread = Math.max(...ratios) - Math.min(...ratios);
  // A lat/lng grid scaled by a constant cos(lat) spreads by ~0.5% here.
  assert.ok(spread < 1e-4, `scale varies by ${(spread * 100).toFixed(4)}% with bearing`);
});

test("localSphereRadius: lands between the ellipsoid's meridional and prime-vertical radii", () => {
  const R = localSphereRadius(ORIGIN.lat);
  assert.ok(R > 6383000 && R < 6395000, `R=${R}`);
  // Larger than the 6371 km mean sphere — this far north the earth is flatter.
  assert.ok(R > 6371000);
});

test("fitSimilarity: two points recover the exact scale and rotation", () => {
  const pts = synth({ mPerPx: 0.846667, bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200]] });
  const fit = fitSimilarity(pts, PINNED);
  assert.ok(Math.abs(fit.scale - 0.846667) < 1e-9, `scale ${fit.scale}`);
  assert.ok(Math.abs(fit.mapNorthBearingDeg - 9.2) < 1e-9, `bearing ${fit.mapNorthBearingDeg}`);
  assert.ok(fit.rmseM < 1e-6, `rmse ${fit.rmseM}`);
  assert.equal(fit.pointCount, 2);
});

test("fitSimilarity: a true-north map fits at bearing ~0", () => {
  const pts = synth({ mPerPx: 0.846667, bearingDeg: 0, pixels: [[1000, 9000], [6000, 500]] });
  const fit = fitSimilarity(pts, PINNED);
  assert.ok(Math.abs(fit.mapNorthBearingDeg) < 1e-9, `bearing ${fit.mapNorthBearingDeg}`);
});

test("fitSimilarity: negative (westerly) declination round-trips", () => {
  const pts = synth({ mPerPx: 0.846667, bearingDeg: -7.5, pixels: [[500, 7000], [6500, 900]] });
  const fit = fitSimilarity(pts, PINNED);
  assert.ok(Math.abs(fit.mapNorthBearingDeg + 7.5) < 1e-9, `bearing ${fit.mapNorthBearingDeg}`);
});

test("pxToLl / llToPx round-trip across the whole sheet", () => {
  const pts = synth({ mPerPx: 0.846667, bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200]] });
  const fit = fitSimilarity(pts, PINNED);
  for (const [px, py] of [[0, 0], [3500, 5000], [7016, 9921], [1234.5, 6789.25]]) {
    const ll = pxToLl(fit, px, py);
    const back = llToPx(fit, ll.lat, ll.lng);
    assert.ok(Math.abs(back.px - px) < 1e-4, `px ${px} → ${back.px}`);
    assert.ok(Math.abs(back.py - py) < 1e-4, `py ${py} → ${back.py}`);
  }
});

test("pxToLl: the fitted transform reproduces its own calibration points", () => {
  const pts = synth({ mPerPx: 0.846667, bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200], [3000, 4000]] });
  const fit = fitSimilarity(pts, PINNED);
  for (const p of pts) {
    const ll = pxToLl(fit, p.px, p.py);
    assert.ok(Math.abs(ll.lat - p.lat) < 1e-9, `lat ${ll.lat} vs ${p.lat}`);
    assert.ok(Math.abs(ll.lng - p.lng) < 1e-9, `lng ${ll.lng} vs ${p.lng}`);
  }
});

test("fitSimilarity: 1181.6 px on the fitted map really is 1000 m on the ground", () => {
  const pts = synth({ mPerPx: metresPerRefPx(20000), bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200]] });
  const fit = fitSimilarity(pts, PINNED);
  const a = pxToLl(fit, 1000, 5000);
  const b = pxToLl(fit, 1000 + 1181.6, 5000);
  const la = llToLocal(a, fit.origin), lb = llToLocal(b, fit.origin);
  const d = Math.hypot(lb.e - la.e, lb.n - la.n);
  assert.ok(Math.abs(d - 1000) < 1, `expected ~1000 m, got ${d}`);
});

test("fitSimilarity: 3 exact points still fit perfectly (least squares degenerates to exact)", () => {
  const pts = synth({ mPerPx: 0.846667, bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200], [3500, 4600]] });
  const fit = fitSimilarity(pts, PINNED);
  assert.ok(fit.rmseM < 1e-6, `rmse ${fit.rmseM}`);
  assert.ok(Math.abs(fit.scale - 0.846667) < 1e-9);
});

test("fitSimilarity: a mis-clicked third point shows up in the residuals", () => {
  const pts = synth({ mPerPx: 0.846667, bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200], [3500, 4600]] });
  // Drag the third point 200 px (~170 m) off where it belongs.
  pts[2].px += 200;
  const fit = fitSimilarity(pts, PINNED);
  assert.ok(fit.rmseM > 20, `expected a large rmse, got ${fit.rmseM}`);
  assert.equal(fit.residualsM.length, 3);
  // The bad point must be the worst of the three.
  const worst = fit.residualsM.indexOf(Math.max(...fit.residualsM));
  assert.equal(worst, 2);
});

test("fitSimilarity: an unpinned fit still positions points correctly", () => {
  // Real callers do not pin the origin. The frame then differs from the one
  // the points were built in, but the fit must still reproduce them on the
  // ground — that difference is absorbed by the rotation and translation.
  const pts = synth({ mPerPx: 0.846667, bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200], [3500, 4600]] });
  const fit = fitSimilarity(pts);
  assert.ok(fit.rmseM < 0.01, `rmse ${fit.rmseM}`);
  for (const p of pts) {
    const ll = pxToLl(fit, p.px, p.py);
    assert.ok(haversineM(ll, p) < 0.01, `off by ${haversineM(ll, p)} m`);
  }
});

test("fitSimilarity: residuals stay aligned to the input array around a half-filled point", () => {
  // A row the user has clicked but not yet given coordinates to must not
  // shift every residual below it onto the wrong row.
  const good = synth({ mPerPx: 0.846667, bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200], [3500, 4600]] });
  good[2].px += 200;                              // make the last one clearly wrong
  const pts = [good[0], { id: "cal_x", px: 4000, py: 4000, lat: null, lng: null }, good[1], good[2]];
  const fit = fitSimilarity(pts, PINNED);
  assert.equal(fit.pointCount, 3);
  assert.equal(fit.residualsM.length, 4);
  assert.equal(fit.residualsM[1], null, "the point without coordinates has no residual");
  for (const i of [0, 2, 3]) assert.ok(Number.isFinite(fit.residualsM[i]), `index ${i}`);
  // The mis-clicked point is last in the input, so it must be worst there.
  const worst = fit.residualsM.indexOf(Math.max(...fit.residualsM.filter(Number.isFinite)));
  assert.equal(worst, 3);
});

test("calibrationQuality: a correct fit reports ~0% scale error", () => {
  const pts = synth({ mPerPx: metresPerRefPx(20000), bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200]] });
  const q = calibrationQuality(fitSimilarity(pts, PINNED), 20000);
  assert.ok(Math.abs(q.scaleErrorPct) < 1e-6, `scale error ${q.scaleErrorPct}%`);
  assert.equal(q.residualsMeaningful, false);
});

test("calibrationQuality: catches a bad 2-point calibration that residuals cannot", () => {
  // Two points fit perfectly by construction, so RMSE stays 0 — but the
  // implied scale is 20% off, which is the only signal that a point is wrong.
  const pts = synth({ mPerPx: metresPerRefPx(20000) * 1.2, bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200]] });
  const fit = fitSimilarity(pts, PINNED);
  assert.ok(fit.rmseM < 1e-6, "two points always fit exactly");
  const q = calibrationQuality(fit, 20000);
  assert.ok(Math.abs(q.scaleErrorPct - 20) < 0.01, `scale error ${q.scaleErrorPct}%`);
});

test("calibrationQuality: residuals become meaningful at 3 points", () => {
  const pts = synth({ mPerPx: metresPerRefPx(20000), bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200], [3500, 4600]] });
  assert.equal(calibrationQuality(fitSimilarity(pts, PINNED), 20000).residualsMeaningful, true);
});

test("fitSimilarity: fewer than 2 usable points throws", () => {
  assert.throws(() => fitSimilarity([]), /vähintään 2/);
  assert.throws(() => fitSimilarity([{ px: 1, py: 2, lat: 60, lng: 24 }]), /vähintään 2/);
  // Points missing coordinates are filtered out before the count check.
  assert.throws(() => fitSimilarity([
    { px: 1, py: 2, lat: 60, lng: 24 },
    { px: 5, py: 6, lat: null, lng: null }
  ]), /vähintään 2/);
});

test("fitSimilarity: two points at the same pixel throws", () => {
  assert.throws(() => fitSimilarity([
    { px: 100, py: 100, lat: 60.1, lng: 24.6 },
    { px: 100, py: 100, lat: 60.2, lng: 24.7 }
  ]), /samassa kohdassa/);
});

test("fitSimilarity: two points at the same coordinates throws", () => {
  assert.throws(() => fitSimilarity([
    { px: 100, py: 100, lat: 60.1, lng: 24.6 },
    { px: 900, py: 900, lat: 60.1, lng: 24.6 }
  ]), /koordinaatit ovat samat/);
});

test("fitSimilarity: ignores extra properties on calibration points", () => {
  const pts = synth({ mPerPx: 0.846667, bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200]] })
    .map((p, i) => ({ ...p, id: `cal_${i}`, label: `K${i}` }));
  const fit = fitSimilarity(pts, PINNED);
  assert.ok(Math.abs(fit.scale - 0.846667) < 1e-9);
});

test("fit object survives a JSON round-trip", () => {
  const pts = synth({ mPerPx: 0.846667, bearingDeg: 9.2, pixels: [[900, 8000], [6800, 1200]] });
  const fit = JSON.parse(JSON.stringify(fitSimilarity(pts, PINNED)));
  const ll = pxToLl(fit, 3500, 5000);
  const back = llToPx(fit, ll.lat, ll.lng);
  assert.ok(Math.abs(back.px - 3500) < 1e-4);
  assert.ok(Math.abs(back.py - 5000) < 1e-4);
});
