// Round-trip the app state as a multi-sheet .xlsx workbook that opens in
// Excel / Google Sheets / LibreOffice. Sheets and column headers are in
// Finnish so non-technical collaborators can read & edit them; the import
// also accepts the original English key names as a fallback.
//
//   Kilpailu   — single row: nimi, aloituspaiva, skeeman_versio
//   Tehtävät   — one row per task; häröilyaika_lisä_min is this task's own addition
//   Rastit     — one row per CP; sulkeutumisaika + yorasti; tehtävät comma-separated
//   Radat      — one row per course; pohja_häröilyaika_min is the course's baseline
//   Reitit     — one row per (rata, pysähdys), ordered by jarjestys; rinnakkainen per stop
//   Sarjat     — one row per category; radan_tunnus references a Radat row;
//                poissaolevat_joukkueet is a comma-separated DNS/DNF team-number list
//   Sarjakohtaiset_ajat — optional, one row per non-empty per-category task-time override

import { getState, setState, ensureDefaults } from "../state.js";

const SCHEMA_VERSION = 1;

function requireXLSX() {
  if (typeof window === "undefined" || !window.XLSX) {
    throw new Error("XLSX-kirjasto ei latautunut. Tarkista verkkoyhteys.");
  }
  return window.XLSX;
}

// English-key → Finnish-header per sheet. Used by both export (writes
// Finnish headers) and import (reads either Finnish or the English fallback).
const COLS = {
  kilpailu: {
    nimi: "name",
    aloituspaiva: "startDateISO",
    skeeman_versio: "schemaVersion"
  },
  tehtavat: {
    tunnus: "id",
    nimi: "name",
    suorituspaikkoja: "slots",
    rajaton: "unlimitedSlots",
    nopein_min: "fastestTaskMin",
    hitain_min: "slowestTaskMin",
    haroilyaika_lisa_min: "haroilyMin"
  },
  rastit: {
    tunnus: "id",
    nimi: "name",
    leveysaste: "lat",
    pituusaste: "lng",
    sulkeutumisaika: "closingTimeMin",
    yorasti: "isSleepingCp",
    tehtavat: "taskIds"
  },
  radat: {
    tunnus: "id",
    nimi: "name",
    pohja_haroilyaika_min: "haroilyBaselineMin"
  },
  reitit: {
    radan_tunnus: "courseId",
    radan_nimi: "courseName",
    jarjestys: "stopIdx",
    rastin_tunnus: "cpId",
    matka_m: "distanceM",
    tehtavat: "taskIds",
    rinnakkainen: "parallel"
  },
  sarjat: {
    tunnus: "id",
    nimi: "name",
    vari: "color",
    radan_tunnus: "courseId",
    kavelynopeus_kmh: "walkSpeedKmh",
    nopein_kerroin: "fastestMultiplier",
    hitain_kerroin: "slowestMultiplier",
    tehtavien_hajonta: "taskVariance",
    lahto_pv1: "startMinutes1",        // serialised as HH:MM
    lahto_pv2: "startMinutes2",        // serialised as HH:MM
    joukkueita: "teamCount",
    lahtovali_min: "teamStartIntervalMin",
    poissaolevat_joukkueet: "withdrawnTeamIndices"
  },
  ajat: {
    sarjan_tunnus: "catId",
    sarjan_nimi: "catName",
    tehtavan_tunnus: "taskId",
    nopein_min: "fastestTaskMin",
    hitain_min: "slowestTaskMin"
  }
};

// Fields rendered as HH:MM strings instead of raw minute counts.
const TIME_FIELDS = new Set(["startMinutes1", "startMinutes2", "closingTimeMin"]);

// Map { englishKey → value } → { finnishHeader → finnishValue } using the
// per-sheet COLS mapping. Cells are coerced to spreadsheet-friendly types:
//   booleans → "TRUE"/"FALSE" (so they show as labels in Google Sheets)
//   time fields → "HH:MM"
//   arrays (string or number) → comma-separated string
//   null/undefined → "" (e.g. a CP with no sulkeutumisaika)
function rowToFinnish(sheet, row) {
  const cols = COLS[sheet];
  const out = {};
  for (const [fi, en] of Object.entries(cols)) {
    let v = row[en];
    if (v === undefined || v === null) v = "";
    else if (typeof v === "boolean") v = v ? "TRUE" : "FALSE";
    else if (Array.isArray(v)) v = v.join(",");
    else if (TIME_FIELDS.has(en) && typeof v === "number") v = minToHHMM(v);
    out[fi] = v;
  }
  return out;
}

// Resolve a row from the spreadsheet by English key name, accepting both
// the Finnish header (new) and the original English header (legacy files).
function rowGetter(sheet, row) {
  const cols = COLS[sheet];
  return (en) => {
    for (const [fi, eng] of Object.entries(cols)) {
      if (eng === en && row[fi] !== undefined && row[fi] !== "") return row[fi];
    }
    return row[en];
  };
}

export function exportXlsxArray() {
  const XLSX = requireXLSX();
  const state = getState();
  const wb = XLSX.utils.book_new();

  appendSheet(wb, "Kilpailu", [
    rowToFinnish("kilpailu", {
      name: state.race?.name ?? "",
      startDateISO: state.race?.startDateISO ?? "",
      schemaVersion: state.schemaVersion ?? SCHEMA_VERSION
    })
  ]);

  appendSheet(wb, "Tehtävät", state.tasks.map(t => rowToFinnish("tehtavat", {
    id: t.id, name: t.name, slots: t.slots,
    unlimitedSlots: !!t.unlimitedSlots,
    fastestTaskMin: t.fastestTaskMin, slowestTaskMin: t.slowestTaskMin,
    haroilyMin: t.haroilyMin ?? 0
  })));

  appendSheet(wb, "Rastit", state.controlPoints.map(c => rowToFinnish("rastit", {
    id: c.id, name: c.name,
    lat: c.lat ?? "", lng: c.lng ?? "",
    closingTimeMin: c.closingTimeMin ?? null,
    isSleepingCp: !!c.isSleepingCp,
    taskIds: c.taskIds || []
  })));

  appendSheet(wb, "Radat", state.courses.map(course => rowToFinnish("radat", {
    id: course.id, name: course.name,
    haroilyBaselineMin: course.haroilyBaselineMin ?? 0
  })));

  const reitit = [];
  for (const course of state.courses) {
    (course.stops || []).forEach((stop, idx) => {
      reitit.push(rowToFinnish("reitit", {
        courseId: course.id, courseName: course.name, stopIdx: idx + 1,
        cpId: stop.cpId, distanceM: stop.distanceM,
        taskIds: stop.taskIds || [],
        parallel: !!stop.parallel
      }));
    });
  }
  appendSheet(wb, "Reitit", reitit);

  appendSheet(wb, "Sarjat", state.categories.map(c => rowToFinnish("sarjat", {
    id: c.id, name: c.name, color: c.color || "",
    courseId: c.courseId || "",
    walkSpeedKmh: c.walkSpeedKmh,
    fastestMultiplier: c.fastestMultiplier,
    slowestMultiplier: c.slowestMultiplier,
    taskVariance: c.taskVariance ?? 0.15,
    startMinutes1: c.startMinutes1,
    startMinutes2: c.startMinutes2,
    teamCount: c.teamCount,
    teamStartIntervalMin: c.teamStartIntervalMin,
    withdrawnTeamIndices: c.withdrawnTeamIndices || []
  })));

  const ajat = [];
  for (const c of state.categories) {
    if (!c.taskOverrides) continue;
    for (const [taskId, ov] of Object.entries(c.taskOverrides)) {
      if (ov.fastestTaskMin == null && ov.slowestTaskMin == null) continue;
      ajat.push(rowToFinnish("ajat", {
        catId: c.id, catName: c.name, taskId,
        fastestTaskMin: ov.fastestTaskMin ?? "",
        slowestTaskMin: ov.slowestTaskMin ?? ""
      }));
    }
  }
  if (ajat.length > 0) appendSheet(wb, "Sarjakohtaiset_ajat", ajat);

  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

export function importXlsxArrayBuffer(arrayBuffer) {
  const XLSX = requireXLSX();
  const wb = XLSX.read(arrayBuffer, { type: "array" });

  const read = name => {
    const sh = wb.Sheets[name];
    return sh ? XLSX.utils.sheet_to_json(sh, { defval: "" }) : [];
  };

  const kilpailuRows = read("Kilpailu");
  let kilpailu = {};
  if (kilpailuRows.length > 0) {
    const g = rowGetter("kilpailu", kilpailuRows[0]);
    kilpailu = {
      name: g("name"),
      startDateISO: g("startDateISO"),
      schemaVersion: g("schemaVersion")
    };
  }

  const tasks = read("Tehtävät")
    .map(r => ({ g: rowGetter("tehtavat", r) }))
    .filter(({ g }) => nonEmpty(g("id")))
    .map(({ g }) => ({
      id: String(g("id")),
      name: String(g("name") ?? ""),
      slots: numberOr(g("slots"), 1, 1),
      unlimitedSlots: toBool(g("unlimitedSlots")),
      fastestTaskMin: numberOr(g("fastestTaskMin"), 0),
      slowestTaskMin: numberOr(g("slowestTaskMin"), 0),
      haroilyMin: numberOr(g("haroilyMin"), 0)
    }));

  const controlPoints = read("Rastit")
    .map(r => ({ g: rowGetter("rastit", r) }))
    .filter(({ g }) => nonEmpty(g("id")))
    .map(({ g }) => ({
      id: String(g("id")),
      name: String(g("name") ?? ""),
      lat: nullableNumber(g("lat")),
      lng: nullableNumber(g("lng")),
      closingTimeMin: nonEmpty(g("closingTimeMin")) ? parseTimeOrNumber(g("closingTimeMin"), null) : null,
      isSleepingCp: toBool(g("isSleepingCp")),
      taskIds: parseList(g("taskIds"))
    }));

  const courses = read("Radat")
    .map(r => ({ g: rowGetter("radat", r) }))
    .filter(({ g }) => nonEmpty(g("id")))
    .map(({ g }) => ({
      id: String(g("id")),
      name: String(g("name") ?? ""),
      haroilyBaselineMin: numberOr(g("haroilyBaselineMin"), 0),
      stops: []
    }));

  const categories = read("Sarjat")
    .map(r => ({ g: rowGetter("sarjat", r) }))
    .filter(({ g }) => nonEmpty(g("id")))
    .map(({ g }) => ({
      id: String(g("id")),
      name: String(g("name") ?? ""),
      color: g("color") ? String(g("color")) : "",
      courseId: g("courseId") ? String(g("courseId")) : "",
      walkSpeedKmh: numberOr(g("walkSpeedKmh"), 4),
      fastestMultiplier: numberOr(g("fastestMultiplier"), 1.15),
      slowestMultiplier: numberOr(g("slowestMultiplier"), 0.85),
      taskVariance: nonEmpty(g("taskVariance")) ? numberOr(g("taskVariance"), 0.15) : 0.15,
      startMinutes1: parseTimeOrNumber(g("startMinutes1"), 540),
      startMinutes2: parseTimeOrNumber(g("startMinutes2"), 540),
      teamCount: numberOr(g("teamCount"), 1, 1),
      teamStartIntervalMin: numberOr(g("teamStartIntervalMin"), 0),
      withdrawnTeamIndices: parseNumberList(g("withdrawnTeamIndices")),
      taskOverrides: {}
    }));

  const courseById = Object.fromEntries(courses.map(c => [c.id, c]));
  const routeRows = read("Reitit")
    .map(r => ({ g: rowGetter("reitit", r) }))
    .filter(({ g }) => nonEmpty(g("courseId")))
    .map(({ g }) => ({ g, _idx: numberOr(g("stopIdx"), 1e9) }))
    .sort((a, b) => a._idx - b._idx);
  for (const { g } of routeRows) {
    const course = courseById[String(g("courseId"))];
    if (!course) continue;
    course.stops.push({
      cpId: String(g("cpId") ?? ""),
      distanceM: numberOr(g("distanceM"), 0),
      taskIds: parseList(g("taskIds")),
      parallel: toBool(g("parallel"))
    });
  }

  const catById = Object.fromEntries(categories.map(c => [c.id, c]));
  for (const r of read("Sarjakohtaiset_ajat")) {
    const g = rowGetter("ajat", r);
    const cat = catById[String(g("catId") ?? "")];
    if (!cat) continue;
    const taskId = String(g("taskId") ?? "");
    if (!taskId) continue;
    const ov = {};
    if (nonEmpty(g("fastestTaskMin"))) ov.fastestTaskMin = numberOr(g("fastestTaskMin"), 0);
    if (nonEmpty(g("slowestTaskMin"))) ov.slowestTaskMin = numberOr(g("slowestTaskMin"), 0);
    if (Object.keys(ov).length === 0) continue;
    cat.taskOverrides[taskId] = ov;
  }

  const next = ensureDefaults({
    schemaVersion: SCHEMA_VERSION,
    race: {
      name: String(kilpailu.name ?? "Kilpailu"),
      startDateISO: String(kilpailu.startDateISO ?? ""),
      logo: null
    },
    forbiddenAreas: [],
    tasks, controlPoints, courses, categories
  });
  setState(next);
  return summarizeImport(next);
}

function appendSheet(wb, name, rows) {
  const XLSX = window.XLSX;
  const ws = rows.length > 0
    ? XLSX.utils.json_to_sheet(rows)
    : XLSX.utils.aoa_to_sheet([["(tyhjä)"]]);
  XLSX.utils.book_append_sheet(wb, ws, name);
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (v == null || v === "") return false;
  if (typeof v === "number") return v !== 0;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "tosi" || s === "kyllä" || s === "x";
}

function nonEmpty(v) {
  return v !== undefined && v !== null && v !== "";
}

function nullableNumber(v) {
  if (!nonEmpty(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numberOr(v, fallback, min) {
  if (!nonEmpty(v)) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (min != null && n < min) return min;
  return n;
}

function parseList(v) {
  if (!nonEmpty(v)) return [];
  return String(v).split(",").map(s => s.trim()).filter(Boolean);
}

// Like parseList but coerces each entry to a finite number — for
// withdrawnTeamIndices (team numbers), not id strings.
function parseNumberList(v) {
  return parseList(v).map(Number).filter(Number.isFinite);
}

// Accepts "09:00", "9:00", "9.00", "09.00", 540 (number), Date-like.
// Returns minutes since midnight, or `fallback` (which may be null) if empty.
function parseTimeOrNumber(v, fallback) {
  if (!nonEmpty(v)) return fallback;
  if (typeof v === "number") {
    if (v < 24 && v > 0 && Number.isFinite(v)) {
      // Excel may give time-of-day as a fraction of a day
      return Math.round(v * 1440);
    }
    return Math.round(v);
  }
  const s = String(v).trim().replace(",", ".");
  const m = s.match(/^(\d{1,2})[.:](\d{1,2})$/);
  if (m) {
    const h = +m[1], mm = +m[2];
    return h * 60 + mm;
  }
  const n = Number(s);
  if (Number.isFinite(n)) return Math.round(n);
  return fallback;
}

function minToHHMM(m) {
  const total = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function summarizeImport(state) {
  return {
    tasks: state.tasks.length,
    controlPoints: state.controlPoints.length,
    courses: state.courses.length,
    categories: state.categories.length,
    routeStops: state.courses.reduce((n, c) => n + c.stops.length, 0)
  };
}
