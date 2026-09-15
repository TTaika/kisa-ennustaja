// Time convention matches v1: minutes since the day-1 start-of-day midnight.
// Day 2 = +1440 min. UI formats as HH:MM, prefixed with the race's actual
// Finnish weekday name (e.g. "Lauantai 09:00") once a day boundary is crossed.

const WEEKDAYS_FI = ["Sunnuntai", "Maanantai", "Tiistai", "Keskiviikko", "Torstai", "Perjantai", "Lauantai"];

// dayOffset: 0 = race start day, 1 = the day after, etc.
export function weekdayLabel(startDateISO, dayOffset) {
  if (!startDateISO) return `+${dayOffset}pv`;
  const [y, m, d] = String(startDateISO).split("-").map(Number);
  if (!y || !m || !d) return `+${dayOffset}pv`;
  const dt = new Date(Date.UTC(y, m - 1, d + dayOffset));
  if (Number.isNaN(dt.getTime())) return `+${dayOffset}pv`;
  return WEEKDAYS_FI[dt.getUTCDay()];
}

export function fmtTime(totalMin, startDateISO) {
  if (totalMin == null) return "–";
  const day = Math.floor(totalMin / 1440);
  const inDay = ((totalMin % 1440) + 1440) % 1440;
  const h = Math.floor(inDay / 60);
  const m = Math.round(inDay % 60);
  const hhmm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (day <= 0) return hhmm;
  return startDateISO ? `${weekdayLabel(startDateISO, day)} ${hhmm}` : `+${day}pv ${hhmm}`;
}

export function fmtDuration(min) {
  if (min == null) return "–";
  if (min <= 0) return "0 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function hhmmToMins(s) {
  const [h, m] = String(s).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minsToHHMM(m) {
  const day = Math.floor(m / 1440);
  const inDay = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(inDay / 60)).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")}`;
}

export function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function escapeText(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
