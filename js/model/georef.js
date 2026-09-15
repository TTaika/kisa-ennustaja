// Georeferencing for a printed/scanned race map.
//
// The map is a rigid sheet printed at a known paper scale (e.g. 1:20 000),
// so the pixel → ground relationship is a *similarity* transform: rotation,
// one uniform scale, translation. Four degrees of freedom, no shear, no
// separate x/y scale. Fitting a full 6-DOF affine instead would let three
// slightly-misclicked reference points be absorbed into fake shear, quietly
// distorting the whole sheet; a similarity fit can't hide error that way —
// it shows up in the residuals, where the user can see it.
//
// Pixel coordinates are always expressed in REFERENCE PIXELS: the page
// rasterised at REF_DPI. Storing calibration in that space means changing
// the on-screen render resolution never invalidates a calibration.

export const REF_DPI = 600;

// Ground metres per reference pixel for a map printed at 1:paperScale.
// At 600 dpi and 1:20 000 this is 0.8467 m/px.
export function metresPerRefPx(paperScale) {
  return (25.4 / REF_DPI) / 1000 * paperScale;
}

// Ground frame: an orthographic tangent plane centred on the calibration
// origin, on the local sphere that best fits the WGS84 ellipsoid there.
//
// The naive alternative — treating lat/lng as a rectangular grid scaled by a
// constant cos(lat) — is not good enough at Finnish latitudes: cos(lat) varies
// across the sheet and the north/east scales come out biased differently, a
// ~0.5% *anisotropic* distortion. A similarity transform has no shear term to
// absorb that, so it would surface as tens of metres of residual and make a
// perfectly good calibration look broken. Orthographic is isotropic to about
// 0.3 ppm over a sheet this size (radial scale cos(d/R) ≈ 1 - d²/2R²), leaving
// only the ellipsoid's own M≠N mismatch — under ~3 m at the sheet corners,
// which is below the precision of a hand-placed reference point anyway.
const WGS84_A = 6378137;
const WGS84_E2 = 0.00669437999014132;

// Gaussian mean radius √(MN) at this latitude.
export function localSphereRadius(latDeg) {
  const s = Math.sin(latDeg * Math.PI / 180);
  const w = 1 - WGS84_E2 * s * s;
  const N = WGS84_A / Math.sqrt(w);                       // prime vertical
  const M = WGS84_A * (1 - WGS84_E2) / (w * Math.sqrt(w)); // meridional
  return Math.sqrt(M * N);
}

// { lat, lng } → metres east/north of `origin`.
export function llToLocal(ll, origin) {
  const rad = Math.PI / 180;
  const R = localSphereRadius(origin.lat);
  const lat0 = origin.lat * rad, lat = ll.lat * rad;
  const dLng = (ll.lng - origin.lng) * rad;
  const cos0 = Math.cos(lat0), sin0 = Math.sin(lat0);
  const cosP = Math.cos(lat), sinP = Math.sin(lat);
  return {
    e: R * cosP * Math.sin(dLng),
    n: R * (cos0 * sinP - sin0 * cosP * Math.cos(dLng))
  };
}

// Metres east/north of `origin` → { lat, lng }.
export function localToLl(local, origin) {
  const rad = Math.PI / 180;
  const R = localSphereRadius(origin.lat);
  const lat0 = origin.lat * rad, lng0 = origin.lng * rad;
  const rho = Math.hypot(local.e, local.n);
  if (rho < 1e-12) return { lat: origin.lat, lng: origin.lng };
  const c = Math.asin(Math.min(1, rho / R));
  const cosC = Math.cos(c), sinC = Math.sin(c);
  const cos0 = Math.cos(lat0), sin0 = Math.sin(lat0);
  const lat = Math.asin(cosC * sin0 + local.n * sinC * cos0 / rho);
  const lng = lng0 + Math.atan2(
    local.e * sinC,
    rho * cosC * cos0 - local.n * sinC * sin0
  );
  return { lat: lat / rad, lng: lng / rad };
}

// A calibration point is { px, py, lat, lng }. Returns a plain, JSON-safe fit
// object; 2 points give an exact solution, 3+ a least-squares one.
//
// Internally the pixel y axis is flipped (v = -py) so that the map frame is
// right-handed like the ground frame — the fit is then a proper rotation.
//
// `options.origin` pins the tangent-plane centre; by default it is the
// centroid of the calibration points, which keeps the projection error
// smallest across the sheet. Pin it when a fit must stay bit-comparable to
// another one, since the frame's "north" is true north *at the origin* and
// meridian convergence tilts it slightly elsewhere.
export function fitSimilarity(points, options = {}) {
  const all = points || [];
  // Track where each usable point came from: a half-filled point must not
  // shift the residuals of the ones after it when they are shown per row.
  const pts = [], sourceIndex = [];
  all.forEach((p, i) => {
    if (p && Number.isFinite(p.px) && Number.isFinite(p.py) &&
        Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
      pts.push(p);
      sourceIndex.push(i);
    }
  });
  if (pts.length < 2) {
    throw new Error("Kalibrointiin tarvitaan vähintään 2 pistettä, joilla on koordinaatit.");
  }

  const origin = options.origin || {
    lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
    lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length
  };
  const src = pts.map(p => ({ u: p.px, v: -p.py }));
  const dst = pts.map(p => llToLocal(p, origin));

  const uBar = mean(src, s => s.u), vBar = mean(src, s => s.v);
  const eBar = mean(dst, d => d.e), nBar = mean(dst, d => d.n);

  let sumSq = 0, a = 0, b = 0;
  for (let i = 0; i < pts.length; i++) {
    const u = src[i].u - uBar, v = src[i].v - vBar;
    const e = dst[i].e - eBar, n = dst[i].n - nBar;
    sumSq += u * u + v * v;
    a += u * e + v * n;   // dot product   → cos component
    b += u * n - v * e;   // cross product → sin component
  }
  if (sumSq < 1e-9) {
    throw new Error("Kalibrointipisteet ovat samassa kohdassa kartalla.");
  }
  const scale = Math.hypot(a, b) / sumSq;
  if (!(scale > 0) || !Number.isFinite(scale)) {
    throw new Error("Kalibrointi epäonnistui: pisteiden koordinaatit ovat samat.");
  }
  const thetaRad = Math.atan2(b, a);
  const cos = Math.cos(thetaRad), sin = Math.sin(thetaRad);
  const tx = eBar - scale * (cos * uBar - sin * vBar);
  const ty = nBar - scale * (sin * uBar + cos * vBar);

  const fit = {
    origin, scale, thetaRad, tx, ty,
    // Bearing of "up" on the map, clockwise from true north. ~0° means the
    // map is drawn to true/grid north; in southern Finland a magnetic-north
    // map lands near +9°.
    mapNorthBearingDeg: normalizeDeg(-thetaRad * 180 / Math.PI),
    pointCount: pts.length,
    // Aligned to the *input* array — null where a point was unusable.
    residualsM: new Array(all.length).fill(null),
    rmseM: 0
  };

  let sumSqErr = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const back = llToLocal(pxToLl(fit, p.px, p.py), origin);
    const truth = llToLocal(p, origin);
    const d = Math.hypot(back.e - truth.e, back.n - truth.n);
    fit.residualsM[sourceIndex[i]] = d;
    sumSqErr += d * d;
  }
  fit.rmseM = Math.sqrt(sumSqErr / pts.length);
  return fit;
}

// Reference pixel → metres east/north of fit.origin.
export function pxToLocal(fit, px, py) {
  const u = px, v = -py;
  const cos = Math.cos(fit.thetaRad), sin = Math.sin(fit.thetaRad);
  return {
    e: fit.scale * (cos * u - sin * v) + fit.tx,
    n: fit.scale * (sin * u + cos * v) + fit.ty
  };
}

// Reference pixel → { lat, lng }.
export function pxToLl(fit, px, py) {
  return localToLl(pxToLocal(fit, px, py), fit.origin);
}

// { lat, lng } → reference pixel { px, py }.
export function llToPx(fit, lat, lng) {
  const { e, n } = llToLocal({ lat, lng }, fit.origin);
  const dx = (e - fit.tx) / fit.scale;
  const dy = (n - fit.ty) / fit.scale;
  const cos = Math.cos(fit.thetaRad), sin = Math.sin(fit.thetaRad);
  const u =  cos * dx + sin * dy;   // rotate by -theta
  const v = -sin * dx + cos * dy;
  return { px: u, py: -v };
}

// Compare the fitted scale against the one implied by the printed paper
// scale. A calibration that is geometrically self-consistent but built on a
// mis-clicked point usually shows up here as a percent-level scale error,
// even when only two points were used (where residuals are always 0).
export function calibrationQuality(fit, paperScale) {
  const expectedMPerPx = metresPerRefPx(paperScale);
  const scaleErrorPct = (fit.scale - expectedMPerPx) / expectedMPerPx * 100;
  return {
    expectedMPerPx,
    actualMPerPx: fit.scale,
    scaleErrorPct,
    // 2 points always fit perfectly, so RMSE only means something from 3 up.
    residualsMeaningful: fit.pointCount >= 3
  };
}

function mean(arr, f) {
  return arr.reduce((acc, x) => acc + f(x), 0) / arr.length;
}

function normalizeDeg(d) {
  let v = d % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v;
}
