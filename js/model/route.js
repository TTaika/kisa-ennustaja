const R = 6371000; // Earth radius in metres

// Parse a coordinate pair into { lat, lng } decimal degrees.
// Accepts:
//   - Decimal: "60.17, 24.94" | "60.17 24.94" | "-33.87,151.21"
//   - Google Maps DMS: `60°11'43.0"N 24°44'03.8"E` (with ' " or ′ ″)
// Returns null if the string can't be parsed.
export function parseCoords(input) {
  if (input == null) return null;
  const text = String(input).trim();
  if (!text) return null;

  const dec = text.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (dec) {
    return { lat: parseFloat(dec[1]), lng: parseFloat(dec[2]) };
  }

  const dms = /(\d+(?:\.\d+)?)\s*°\s*(\d+(?:\.\d+)?)\s*['′]\s*(\d+(?:\.\d+)?)\s*["″]\s*([NSEW])/gi;
  const matches = [...text.matchAll(dms)];
  if (matches.length === 2) {
    const toDec = (m) => {
      const v = parseFloat(m[1]) + parseFloat(m[2]) / 60 + parseFloat(m[3]) / 3600;
      return /[SW]/i.test(m[4]) ? -v : v;
    };
    const v0 = toDec(matches[0]);
    const v1 = toDec(matches[1]);
    const firstIsLat = /[NS]/i.test(matches[0][4]);
    return firstIsLat ? { lat: v0, lng: v1 } : { lat: v1, lng: v0 };
  }
  return null;
}

// Format a { lat, lng } pair as decimal degrees with 6 decimals.
// Returns "" if either coordinate is missing.
export function formatCoords(coord) {
  if (!coord || coord.lat == null || coord.lng == null) return "";
  return `${coord.lat.toFixed(6)}, ${coord.lng.toFixed(6)}`;
}

// Decode an encoded-polyline string into [{ lat, lng }, ...].
// Valhalla encodes at precision 6; Google's original format is precision 5.
export function decodePolyline(str, precision = 6) {
  if (!str) return [];
  const factor = Math.pow(10, precision);
  const out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    let shift = 0, result = 0, byte;
    do {
      if (i >= str.length) return out;   // truncated input: keep what we have
      byte = str.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      if (i >= str.length) return out;
      byte = str.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push({ lat: lat / factor, lng: lng / factor });
  }
  return out;
}

// Summed great-circle length of a decoded polyline, in metres.
export function polylineLengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

// Fetch the walking route between two points from the public Valhalla FOSSGIS
// server (no API key, pedestrian costing). Returns { distanceM, shape }, where
// `shape` is the raw encoded polyline — kept encoded because it is ~4 bytes per
// point that way versus ~40 as JSON numbers, and it goes into localStorage.
// Throws on network failure, non-OK HTTP, missing input, or unexpected
// response shape — callers should catch and fall back.
//
// Note the returned geometry starts and ends on the nearest routable way, not
// exactly at the requested points; snapping was ~10-15 m in testing. Callers
// that draw it should join the real endpoints to the shape themselves.
export async function fetchFootRoute(a, b, { signal, excludePolygons } = {}) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) {
    throw new Error("Coordinates missing");
  }
  const body = {
    locations: [
      { lat: a.lat, lon: a.lng },
      { lat: b.lat, lon: b.lng }
    ],
    costing: "pedestrian",
    directions_type: "none",
    units: "kilometers"
  };
  // Forbidden areas. Omitted entirely when there are none — sending an empty
  // array is a different request and there is no reason to risk it.
  if (excludePolygons && excludePolygons.length) body.exclude_polygons = excludePolygons;
  const res = await fetch("https://valhalla1.openstreetmap.de/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) throw new Error(`Routing server returned HTTP ${res.status}`);
  const data = await res.json();
  const km = data?.trip?.summary?.length;
  if (typeof km !== "number") throw new Error("Routing server returned no length");
  // Two locations means exactly one leg. Encoded polylines are delta-encoded,
  // so leg shapes cannot simply be concatenated — take the single leg's shape
  // rather than pretending a multi-leg join would work.
  const shape = data?.trip?.legs?.[0]?.shape || "";
  return { distanceM: km * 1000, shape };
}

// Distance-only wrapper, for callers that don't want the geometry.
export async function fetchFootDistanceM(a, b, opts = {}) {
  return (await fetchFootRoute(a, b, opts)).distanceM;
}

export function haversineM(a, b) {
  const toRad = d => d * Math.PI / 180;
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Returns a permutation of indices into `points` (excluding ones without coords),
// starting at `startIdx`, that visits all remaining coordinated points using
// nearest-neighbour, then improved with 2-opt swaps until no improvement.
// Order is an open path (start → end, no return to start).
export function optimizeRouteOrder(points, startIdx) {
  const eligible = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p && p.lat != null && p.lng != null)
    .map(({ i }) => i);

  if (!eligible.includes(startIdx)) {
    throw new Error("start index has no coordinates");
  }

  // Nearest neighbour
  const remaining = new Set(eligible);
  remaining.delete(startIdx);
  const order = [startIdx];
  while (remaining.size > 0) {
    const last = order[order.length - 1];
    let bestIdx = null, bestDist = Infinity;
    for (const idx of remaining) {
      const d = haversineM(points[last], points[idx]);
      if (d < bestDist) { bestDist = d; bestIdx = idx; }
    }
    order.push(bestIdx);
    remaining.delete(bestIdx);
  }

  // 2-opt polish (open path: keep order[0] fixed)
  const pathLen = (arr) => {
    let total = 0;
    for (let i = 0; i < arr.length - 1; i++) total += haversineM(points[arr[i]], points[arr[i+1]]);
    return total;
  };
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const reversed = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
        if (pathLen(reversed) + 1e-6 < pathLen(order)) {
          for (let x = 0; x < order.length; x++) order[x] = reversed[x];
          improved = true;
        }
      }
    }
  }
  return order;
}
