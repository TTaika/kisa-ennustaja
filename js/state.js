// App state: single in-memory object, persisted to localStorage. Pattern
// (schemaVersion + DEFAULT_STATE + getState/update/genId/export/import)
// reused from v1's state.js — the data SHAPE is new (Tasks/Courses/Series
// per the v2 design), so this is a fresh file, not a port.

const STORAGE_KEY = "kisa-ennustaja:v1";
const SCHEMA_VERSION = 1;

// Default "+ Lisää" values for new entities. Editable on the Asetukset tab.
const DEFAULT_TASK_DEFAULTS = {
  slots: 1,
  unlimitedSlots: false,
  fastestTaskMin: 10,
  slowestTaskMin: 20,
  haroilyMin: 0
};
const DEFAULT_CP_DEFAULTS = {
  closingTimeMin: null,
  isSleepingCp: false
};
const DEFAULT_COURSE_DEFAULTS = {
  haroilyBaselineMin: 0
};
const DEFAULT_CATEGORY_DEFAULTS = {
  walkSpeedKmh: 4.0,
  fastestMultiplier: 1.15,
  slowestMultiplier: 0.85,
  taskVariance: 0.15,
  startMinutes1: 540,
  startMinutes2: 540,
  teamCount: 10,
  teamStartIntervalMin: 5
};
const DEFAULT_SIMULATION = {
  disableQueueing: false,       // when true, every tehtävä is treated as Rajaton in the simulator
  fitnessCurve: "normal",       // "normal" = bell, "linear" = evenly spaced, "power" = skewed
  fitnessSharpness: 1.0,        // 0.3..3.0; meaning depends on curve (see simulate.js)
  reverseOvernightOrder: false  // when true, the last team to arrive at the sleeping CP is first to leave next morning
};
const DEFAULT_DISPLAY = {
  showDayPrefix: true,          // when true, day-2+ times show their weekday name (e.g. "Lauantai 09:00")
  showLogo: true                // when true, the uploaded race logo appears on every Ennuste print page
};
// Kartta tab. The map raster itself lives in IndexedDB (see js/io/mapstore.js);
// only the identity and the georeference belong in the exportable state.
// Calibration pixels are in REF_DPI (600) space, so changing renderDpi never
// invalidates them. Full map upload/calibration UI is deferred to a later
// pass — this schema shape is ported now (from v1) so that pass won't need
// its own schemaVersion bump.
const DEFAULT_MAP = {
  fileName: null,
  pageIndex: 0,
  renderDpi: 300,
  paperScale: 20000,
  calibration: { points: [] },
  layers: {
    showControlPoints: true,
    showRoutes: true,
    showAllCourses: false,
    showLabels: true,
    showDistances: false,
    showForbidden: true,
    baseOpacity: 1,
    hiddenCatIds: []
  }
};
const DEFAULT_FORBIDDEN_AREAS = [];

// Two trivial zero-duration marker tasks so LÄHTÖ/MAALI (and any other
// task-less stop) still get a real team.stops entry — the simulator only
// records a stop when a task actually runs there, so a CP with taskIds: []
// would otherwise never have a captured arrival/finish time at all.
const DEFAULT_TASKS = [
  { id: "t_eiapu", name: "Ensiapu", slots: 2, unlimitedSlots: false, fastestTaskMin: 15, slowestTaskMin: 25, haroilyMin: 3 },
  { id: "t_suunta", name: "Suunnistustehtävä", slots: 3, unlimitedSlots: false, fastestTaskMin: 20, slowestTaskMin: 35, haroilyMin: 2 },
  { id: "t_solmut", name: "Solmut", slots: 4, unlimitedSlots: false, fastestTaskMin: 10, slowestTaskMin: 18, haroilyMin: 1 },
  { id: "t_kartta", name: "Kartanluku", slots: 2, unlimitedSlots: false, fastestTaskMin: 12, slowestTaskMin: 20, haroilyMin: 2 },
  { id: "t_majoitus", name: "Majoittautuminen", slots: 1, unlimitedSlots: true, fastestTaskMin: 30, slowestTaskMin: 45, haroilyMin: 5 },
  { id: "t_visa", name: "Turvallisuustietovisa", slots: 6, unlimitedSlots: true, fastestTaskMin: 8, slowestTaskMin: 15, haroilyMin: 0 },
  { id: "t_lahto", name: "Lähtö", slots: 1, unlimitedSlots: true, fastestTaskMin: 0, slowestTaskMin: 0, haroilyMin: 0 },
  { id: "t_maali", name: "Maali", slots: 1, unlimitedSlots: true, fastestTaskMin: 0, slowestTaskMin: 0, haroilyMin: 0 }
];

const DEFAULT_CONTROL_POINTS = [
  { id: "cp_lahto", name: "LÄHTÖ", lat: 61.4981, lng: 23.7610, taskIds: ["t_lahto"], closingTimeMin: null, isSleepingCp: false },
  { id: "cp_metsapirtti", name: "Metsäpirtti", lat: 61.5032, lng: 23.7745, taskIds: ["t_eiapu", "t_solmut"], closingTimeMin: null, isSleepingCp: false },
  { id: "cp_nakotorni", name: "Näkötorni", lat: 61.5088, lng: 23.7902, taskIds: ["t_suunta"], closingTimeMin: null, isSleepingCp: false },
  { id: "cp_kalliopolku", name: "Kalliopolku", lat: 61.5121, lng: 23.8065, taskIds: ["t_kartta"], closingTimeMin: 750, isSleepingCp: false },
  { id: "cp_leiripaikka", name: "Leiripaikka", lat: 61.5177, lng: 23.8211, taskIds: ["t_majoitus"], closingTimeMin: null, isSleepingCp: true },
  { id: "cp_tietovisa", name: "Tietovisapiste", lat: 61.5140, lng: 23.7830, taskIds: ["t_visa"], closingTimeMin: null, isSleepingCp: false },
  { id: "cp_maali", name: "MAALI", lat: 61.4990, lng: 23.7650, taskIds: ["t_maali"], closingTimeMin: null, isSleepingCp: false }
];

const DEFAULT_COURSES = [
  {
    id: "course_kulta",
    name: "Kultainen rata",
    haroilyBaselineMin: 3,
    stops: [
      { cpId: "cp_lahto", distanceM: 0, taskIds: ["t_lahto"], parallel: false },
      { cpId: "cp_metsapirtti", distanceM: 1200, taskIds: ["t_eiapu", "t_solmut"], parallel: true },
      { cpId: "cp_nakotorni", distanceM: 2100, taskIds: ["t_suunta"], parallel: false },
      { cpId: "cp_kalliopolku", distanceM: 1800, taskIds: ["t_kartta"], parallel: false },
      { cpId: "cp_leiripaikka", distanceM: 2600, taskIds: ["t_majoitus"], parallel: true },
      { cpId: "cp_tietovisa", distanceM: 1400, taskIds: ["t_visa"], parallel: false },
      { cpId: "cp_maali", distanceM: 900, taskIds: ["t_maali"], parallel: false }
    ]
  },
  {
    id: "course_hopea",
    name: "Hopearata",
    haroilyBaselineMin: 5,
    stops: [
      { cpId: "cp_lahto", distanceM: 0, taskIds: ["t_lahto"], parallel: false },
      { cpId: "cp_metsapirtti", distanceM: 1200, taskIds: ["t_eiapu", "t_solmut"], parallel: true },
      { cpId: "cp_kalliopolku", distanceM: 2300, taskIds: ["t_kartta"], parallel: false },
      { cpId: "cp_leiripaikka", distanceM: 2600, taskIds: ["t_majoitus"], parallel: true },
      { cpId: "cp_tietovisa", distanceM: 1400, taskIds: ["t_visa"], parallel: false },
      { cpId: "cp_maali", distanceM: 900, taskIds: ["t_maali"], parallel: false }
    ]
  },
  {
    id: "course_vaalea",
    name: "Vaalea rata",
    haroilyBaselineMin: 8,
    stops: [
      { cpId: "cp_lahto", distanceM: 0, taskIds: ["t_lahto"], parallel: false },
      { cpId: "cp_metsapirtti", distanceM: 1200, taskIds: ["t_solmut"], parallel: false },
      { cpId: "cp_leiripaikka", distanceM: 2200, taskIds: ["t_majoitus"], parallel: true },
      { cpId: "cp_tietovisa", distanceM: 1400, taskIds: ["t_visa"], parallel: false },
      { cpId: "cp_maali", distanceM: 900, taskIds: ["t_maali"], parallel: false }
    ]
  }
];

const DEFAULT_CATEGORIES = [
  {
    id: "cat_kulta", name: "Kultainen", color: "#d4af37", courseId: "course_kulta",
    walkSpeedKmh: 4.5, fastestMultiplier: 0.85, slowestMultiplier: 1.15, taskVariance: 0.3,
    startMinutes1: 540, startMinutes2: 480, teamCount: 14, teamStartIntervalMin: 4,
    taskOverrides: { t_eiapu: { fastestTaskMin: 12, slowestTaskMin: 20 } },
    withdrawnTeamIndices: [9]
  },
  {
    id: "cat_hopea", name: "Hopea", color: "#b0b8c1", courseId: "course_hopea",
    walkSpeedKmh: 4.0, fastestMultiplier: 0.85, slowestMultiplier: 1.2, taskVariance: 0.35,
    startMinutes1: 555, startMinutes2: 480, teamCount: 12, teamStartIntervalMin: 4,
    taskOverrides: {}, withdrawnTeamIndices: []
  },
  {
    id: "cat_sininen", name: "Sininen", color: "#4f8cff", courseId: "course_hopea",
    walkSpeedKmh: 4.2, fastestMultiplier: 0.88, slowestMultiplier: 1.18, taskVariance: 0.3,
    startMinutes1: 560, startMinutes2: 480, teamCount: 10, teamStartIntervalMin: 5,
    taskOverrides: {}, withdrawnTeamIndices: []
  },
  {
    id: "cat_vaalea", name: "Vaalea", color: "#e8ecf1", courseId: "course_vaalea",
    walkSpeedKmh: 3.2, fastestMultiplier: 0.85, slowestMultiplier: 1.25, taskVariance: 0.4,
    startMinutes1: 570, startMinutes2: 510, teamCount: 16, teamStartIntervalMin: 3,
    taskOverrides: {}, withdrawnTeamIndices: [4]
  }
];

const DEFAULT_STATE = {
  schemaVersion: SCHEMA_VERSION,
  race: { name: "Syysrastit 2026", startDateISO: "2026-09-19", logo: null },
  defaults: {
    task: structuredClone(DEFAULT_TASK_DEFAULTS),
    controlPoint: structuredClone(DEFAULT_CP_DEFAULTS),
    course: structuredClone(DEFAULT_COURSE_DEFAULTS),
    category: structuredClone(DEFAULT_CATEGORY_DEFAULTS)
  },
  simulation: structuredClone(DEFAULT_SIMULATION),
  display: structuredClone(DEFAULT_DISPLAY),
  map: structuredClone(DEFAULT_MAP),
  forbiddenAreas: structuredClone(DEFAULT_FORBIDDEN_AREAS),
  tasks: structuredClone(DEFAULT_TASKS),
  controlPoints: structuredClone(DEFAULT_CONTROL_POINTS),
  courses: structuredClone(DEFAULT_COURSES),
  categories: structuredClone(DEFAULT_CATEGORIES)
};

let state = load();

export function getState() {
  return state;
}

export function setState(next) {
  state = next;
  save();
}

export function update(mutator) {
  mutator(state);
  save();
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== SCHEMA_VERSION) return structuredClone(DEFAULT_STATE);
    return ensureDefaults(parsed);
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

// Defensive backfilling for a state written by an earlier build within v2's
// own schemaVersion 1 life (e.g. a field added since), NOT a v1→v2 migration
// — no such migration exists by design (v2's shape is a deliberate break).
// Exported so xlsx.js (which builds a partial state from spreadsheet rows)
// can backfill the fields a workbook doesn't carry (defaults/simulation/
// display/map) the same way importJson() does.
export function ensureDefaults(s) {
  if (!s.defaults) s.defaults = {};
  if (!s.defaults.task)         s.defaults.task         = structuredClone(DEFAULT_TASK_DEFAULTS);
  if (!s.defaults.controlPoint) s.defaults.controlPoint = structuredClone(DEFAULT_CP_DEFAULTS);
  if (!s.defaults.course)       s.defaults.course       = structuredClone(DEFAULT_COURSE_DEFAULTS);
  if (!s.defaults.category)     s.defaults.category     = structuredClone(DEFAULT_CATEGORY_DEFAULTS);
  if (!s.simulation) s.simulation = structuredClone(DEFAULT_SIMULATION);
  if (!s.display)    s.display    = structuredClone(DEFAULT_DISPLAY);
  if (!s.map) s.map = structuredClone(DEFAULT_MAP);
  if (!s.map.calibration || !Array.isArray(s.map.calibration.points)) s.map.calibration = { points: [] };
  s.map.layers = { ...structuredClone(DEFAULT_MAP.layers), ...(s.map.layers || {}) };
  if (!Array.isArray(s.map.layers.hiddenCatIds)) s.map.layers.hiddenCatIds = [];
  if (!Array.isArray(s.forbiddenAreas)) s.forbiddenAreas = [];
  if (!Array.isArray(s.tasks)) s.tasks = [];
  if (!Array.isArray(s.controlPoints)) s.controlPoints = [];
  if (!Array.isArray(s.courses)) s.courses = [];
  if (!Array.isArray(s.categories)) s.categories = [];
  for (const cat of s.categories) {
    if (!Array.isArray(cat.withdrawnTeamIndices)) cat.withdrawnTeamIndices = [];
    if (!cat.taskOverrides) cat.taskOverrides = {};
  }
  return s;
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetToDefaults() {
  setState(structuredClone(DEFAULT_STATE));
}

export function genId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

// "<race_name> <date_of_saving>.json" — the save-file naming convention
// decided in the design spec.
export function exportFileName() {
  const name = (state.race?.name || "Kilpailu").trim();
  const date = state.race?.startDateISO || new Date().toISOString().slice(0, 10);
  const safe = name.replace(/[\\/:*?"<>|]/g, "_");
  return `${safe} ${date}.json`;
}

export function exportJson() {
  return JSON.stringify(state, null, 2);
}

export function importJson(text) {
  const parsed = JSON.parse(text);
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Tuntematon schemaVersion (odotettiin ${SCHEMA_VERSION})`);
  }
  if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.controlPoints) ||
      !Array.isArray(parsed.courses) || !Array.isArray(parsed.categories)) {
    throw new Error("Tiedostosta puuttuu pakollisia kenttiä");
  }
  setState(ensureDefaults(parsed));
}
