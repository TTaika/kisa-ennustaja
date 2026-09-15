import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pointInRing, segmentsIntersect, segmentCrossesRing, areasCrossedBy,
  ringToValhalla, areasToValhalla, ringAreaM2, pointsInsideAreas
} from "../js/model/area.js";

// A 0.01 x 0.01 degree box in Espoo — roughly 1.1 km north-south.
const BOX = [
  { lat: 60.17, lng: 24.70 },
  { lat: 60.17, lng: 24.71 },
  { lat: 60.18, lng: 24.71 },
  { lat: 60.18, lng: 24.70 }
];

test("pointInRing: inside and outside", () => {
  assert.ok(pointInRing({ lat: 60.175, lng: 24.705 }, BOX));
  assert.ok(!pointInRing({ lat: 60.165, lng: 24.705 }, BOX));
  assert.ok(!pointInRing({ lat: 60.175, lng: 24.695 }, BOX));
  assert.ok(!pointInRing({ lat: 60.185, lng: 24.705 }, BOX));
});

test("pointInRing: a degenerate ring contains nothing", () => {
  assert.ok(!pointInRing({ lat: 60.175, lng: 24.705 }, []));
  assert.ok(!pointInRing({ lat: 60.175, lng: 24.705 }, [BOX[0], BOX[1]]));
  assert.ok(!pointInRing({ lat: 60.175, lng: 24.705 }, null));
});

test("pointInRing: works for a concave ring", () => {
  // An L shape: the notch must read as outside.
  const L = [
    { lat: 0, lng: 0 }, { lat: 0, lng: 4 }, { lat: 2, lng: 4 },
    { lat: 2, lng: 2 }, { lat: 4, lng: 2 }, { lat: 4, lng: 0 }
  ];
  assert.ok(pointInRing({ lat: 1, lng: 1 }, L));
  assert.ok(pointInRing({ lat: 3, lng: 1 }, L));
  assert.ok(!pointInRing({ lat: 3, lng: 3 }, L), "the notch is outside");
});

test("segmentsIntersect: crossing, disjoint, and touching", () => {
  const a = { lat: 0, lng: 0 }, b = { lat: 2, lng: 2 };
  const c = { lat: 0, lng: 2 }, d = { lat: 2, lng: 0 };
  assert.ok(segmentsIntersect(a, b, c, d), "an X crosses");
  assert.ok(!segmentsIntersect(a, b, { lat: 5, lng: 5 }, { lat: 6, lng: 6 }));
  // Touching at an endpoint counts — a leg grazing a boundary is not fine.
  assert.ok(segmentsIntersect(a, b, { lat: 1, lng: 1 }, { lat: 3, lng: 0 }));
});

test("segmentCrossesRing: a leg straight through the middle", () => {
  const a = { lat: 60.175, lng: 24.69 };
  const b = { lat: 60.175, lng: 24.72 };
  assert.ok(segmentCrossesRing(a, b, BOX));
});

test("segmentCrossesRing: a leg passing well clear", () => {
  const a = { lat: 60.16, lng: 24.69 };
  const b = { lat: 60.16, lng: 24.72 };
  assert.ok(!segmentCrossesRing(a, b, BOX));
});

test("segmentCrossesRing: a leg starting or ending inside", () => {
  const inside = { lat: 60.175, lng: 24.705 };
  const outside = { lat: 60.16, lng: 24.69 };
  assert.ok(segmentCrossesRing(inside, outside, BOX));
  assert.ok(segmentCrossesRing(outside, inside, BOX));
});

test("segmentCrossesRing: a leg entirely inside still counts", () => {
  assert.ok(segmentCrossesRing(
    { lat: 60.172, lng: 24.702 }, { lat: 60.178, lng: 24.708 }, BOX));
});

test("segmentCrossesRing: clipping a corner counts", () => {
  // Enters through the south edge at lng 24.708, leaves through the east edge
  // at lat 60.171 — only the corner is inside, but that is still a crossing.
  const a = { lat: 60.169, lng: 24.706 };
  const b = { lat: 60.172, lng: 24.712 };
  assert.ok(segmentCrossesRing(a, b, BOX));
});

test("segmentCrossesRing: passing just outside a corner does not count", () => {
  // Reaches the south edge's latitude at lng 24.7103, a whisker east of the
  // 24.71 boundary, so it never enters.
  const a = { lat: 60.169, lng: 24.709 };
  const b = { lat: 60.171, lng: 24.712 };
  assert.ok(!segmentCrossesRing(a, b, BOX));
});

test("areasCrossedBy: names only the areas actually crossed", () => {
  const far = BOX.map(p => ({ lat: p.lat + 0.1, lng: p.lng }));
  const areas = [{ name: "Ampumarata", ring: BOX }, { name: "Kaukana", ring: far }];
  const hit = areasCrossedBy({ lat: 60.175, lng: 24.69 }, { lat: 60.175, lng: 24.72 }, areas);
  assert.deepEqual(hit, ["Ampumarata"]);
});

test("areasCrossedBy: missing coordinates or no areas → empty", () => {
  assert.deepEqual(areasCrossedBy(null, { lat: 60, lng: 24 }, [{ ring: BOX }]), []);
  assert.deepEqual(areasCrossedBy({ lat: null, lng: null }, { lat: 60, lng: 24 },
    [{ ring: BOX }]), []);
  assert.deepEqual(areasCrossedBy({ lat: 60, lng: 24 }, { lat: 61, lng: 25 }, []), []);
  assert.deepEqual(areasCrossedBy({ lat: 60, lng: 24 }, { lat: 61, lng: 25 }, null), []);
});

test("ringToValhalla: emits [lng, lat] and closes the ring", () => {
  const v = ringToValhalla(BOX);
  assert.equal(v.length, 5, "four corners plus the repeated first");
  assert.deepEqual(v[0], [24.70, 60.17], "lng first, as Valhalla expects");
  assert.deepEqual(v[0], v[v.length - 1], "ring must be closed");
});

test("ringToValhalla: an already-closed ring is not closed twice", () => {
  const closed = [...BOX, BOX[0]];
  assert.equal(ringToValhalla(closed).length, 5);
});

test("ringToValhalla: fewer than 3 vertices is not a polygon", () => {
  assert.equal(ringToValhalla([BOX[0], BOX[1]]), null);
  assert.equal(ringToValhalla([]), null);
  assert.equal(ringToValhalla(null), null);
});

test("areasToValhalla: collects rings, skipping disabled and degenerate ones", () => {
  const areas = [
    { name: "a", ring: BOX },
    { name: "b", ring: BOX, enabled: false },
    { name: "c", ring: [BOX[0]] }
  ];
  const out = areasToValhalla(areas);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 5);
});

test("areasToValhalla: nothing usable → null, so no request field is sent", () => {
  assert.equal(areasToValhalla([]), null);
  assert.equal(areasToValhalla(null), null);
  assert.equal(areasToValhalla([{ ring: [] }]), null);
  assert.equal(areasToValhalla([{ ring: BOX, enabled: false }]), null);
});

test("ringAreaM2: a 0.01 degree box in Espoo is about 0.6 km2", () => {
  const a = ringAreaM2(BOX);
  // 0.01 deg lat = 1111 m; 0.01 deg lng at 60 N = ~554 m => ~0.62 km2
  assert.ok(a > 5.5e5 && a < 6.5e5, `got ${a} m2`);
});

test("ringAreaM2: winding order does not change the area", () => {
  assert.ok(Math.abs(ringAreaM2(BOX) - ringAreaM2([...BOX].reverse())) < 1);
});

test("pointsInsideAreas: finds a rasti sitting inside a forbidden area", () => {
  // The case that makes Valhalla answer HTTP 400 and every leg fail.
  const cps = [
    { name: "R1", lat: 60.175, lng: 24.705 },
    { name: "R2", lat: 60.16,  lng: 24.69 }
  ];
  const hits = pointsInsideAreas(cps, [{ name: "Ampumarata", ring: BOX }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].point.name, "R1");
  assert.equal(hits[0].area.name, "Ampumarata");
});

test("pointsInsideAreas: a disabled area traps nothing", () => {
  const cps = [{ name: "R1", lat: 60.175, lng: 24.705 }];
  assert.deepEqual(pointsInsideAreas(cps, [{ ring: BOX, enabled: false }]), []);
});

test("pointsInsideAreas: points without coordinates are skipped", () => {
  const cps = [{ name: "R1", lat: null, lng: null }, { name: "R2" }];
  assert.deepEqual(pointsInsideAreas(cps, [{ ring: BOX }]), []);
});

test("pointsInsideAreas: one point inside two overlapping areas is reported twice", () => {
  const shifted = BOX.map(p => ({ lat: p.lat + 0.002, lng: p.lng + 0.002 }));
  const cps = [{ name: "R1", lat: 60.175, lng: 24.705 }];
  const hits = pointsInsideAreas(cps, [{ name: "a", ring: BOX }, { name: "b", ring: shifted }]);
  assert.equal(hits.length, 2);
});

test("pointsInsideAreas: empty inputs are safe", () => {
  assert.deepEqual(pointsInsideAreas([], [{ ring: BOX }]), []);
  assert.deepEqual(pointsInsideAreas(null, null), []);
  assert.deepEqual(pointsInsideAreas([{ lat: 60.175, lng: 24.705 }], []), []);
});

test("ringAreaM2: a degenerate ring has no area", () => {
  assert.equal(ringAreaM2([BOX[0], BOX[1]]), 0);
  assert.equal(ringAreaM2([]), 0);
});
