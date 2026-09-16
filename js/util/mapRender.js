// Renders an uploaded map file (js/io/mapstore.js record: { name, type, size,
// blob }) onto a <canvas>. Images render at native resolution — 1 canvas
// pixel = 1 reference pixel (georef.js's REF_DPI space). A PDF page has a
// real physical size, so it renders at `renderDpi`, and the returned
// `refScale` (REF_DPI / renderDpi) converts canvas pixels to reference
// pixels — apply it once, at the point where a click becomes a calibration
// point, rather than smuggling it into the render itself.
//
// pdf.js loads lazily from a CDN, only the first time a PDF is actually
// opened, so image-only users never pay for it.
import { REF_DPI } from "../model/georef.js";

const PDFJS_VERSION = "3.11.174";
let pdfjsLoadPromise = null;

function loadPdfJs() {
  if (pdfjsLoadPromise) return pdfjsLoadPromise;
  pdfjsLoadPromise = new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const script = document.createElement("script");
    script.src = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;
      resolve(window.pdfjsLib);
    };
    script.onerror = () => reject(new Error("PDF-kirjaston (pdf.js) lataus epäonnistui — tarkista verkkoyhteys."));
    document.head.appendChild(script);
  });
  return pdfjsLoadPromise;
}

export function isPdf(type) {
  return type === "application/pdf";
}

// Returns { canvas, pageCount, refScale }.
export async function renderMapFileToCanvas(record, { pageIndex = 0, renderDpi = 300 } = {}) {
  if (isPdf(record.type)) {
    const pdfjsLib = await loadPdfJs();
    const buf = await record.blob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const clampedIndex = Math.min(Math.max(pageIndex, 0), pdf.numPages - 1);
    const page = await pdf.getPage(clampedIndex + 1);
    const scale = renderDpi / 72; // PDF units are 1/72 inch
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return { canvas, pageCount: pdf.numPages, refScale: REF_DPI / renderDpi };
  }

  const bitmap = await createImageBitmap(record.blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return { canvas, pageCount: 1, refScale: 1 };
}

// A click/tap on the displayed canvas, in the canvas's own reference-pixel
// space (accounts for the canvas being scaled by CSS to fit its container).
export function canvasEventToRefPx(canvasEl, evt, refScale) {
  const rect = canvasEl.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (canvasEl.width / rect.width);
  const y = (evt.clientY - rect.top) * (canvasEl.height / rect.height);
  return { px: x * refScale, py: y * refScale };
}
