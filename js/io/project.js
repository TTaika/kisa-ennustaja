// Full-project save file: the app state (which already carries the logo as a
// data URL) plus the race map file from IndexedDB, so one file is everything
// another user needs. The map is embedded as a data URL — a big map makes
// this file several MB, which is why plain "Tallenna JSON" still leaves it out.
import { getState, exportFileName, importJson, importState } from "../state.js";
import { getMapFile, putMapFile, clearMapFile } from "./mapstore.js";
import { importXlsxArrayBuffer } from "./xlsx.js";

const FORMAT = "kisa-ennustaja-projekti";
const FORMAT_VERSION = 1;

export function projectFileName() {
  return exportFileName().replace(/\.json$/i, " projekti.json");
}

export async function exportProjectBlob() {
  const state = getState();
  const record = state.map.fileName ? await getMapFile() : null;
  const bundle = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    state,
    mapFile: record
      ? { name: record.name, type: record.type, dataUrl: await blobToDataUrl(record.blob) }
      : null
  };
  return new Blob([JSON.stringify(bundle)], { type: "application/json" });
}

// One entry point for every "Tuo" button: a project bundle, a plain state
// JSON, or an XLSX export.
export async function importFile(file) {
  if (!/\.json$/i.test(file.name)) {
    importXlsxArrayBuffer(await file.arrayBuffer());
    return;
  }
  const text = await file.text();
  const parsed = JSON.parse(text);
  if (parsed?.format !== FORMAT) {
    importJson(text);
    return;
  }
  if (parsed.formatVersion !== FORMAT_VERSION) {
    throw new Error(`Tuntematon projektitiedoston versio (odotettiin ${FORMAT_VERSION})`);
  }
  // Map first: if storing it fails, the current project is left untouched.
  if (parsed.mapFile?.dataUrl) {
    const blob = await (await fetch(parsed.mapFile.dataUrl)).blob();
    await putMapFile(new File([blob], parsed.mapFile.name || "kartta", { type: parsed.mapFile.type || blob.type }));
  } else {
    await clearMapFile();
  }
  importState(parsed.state);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Karttatiedoston lukeminen epäonnistui"));
    reader.readAsDataURL(blob);
  });
}
