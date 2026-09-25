/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Runs in a dedicated document: PDF.js needs a DOM, canvas, and font loader. */
import * as pdfjsLib from "resource://zotero/reader/pdf/build/pdf.mjs";

const PDF_ROOT = "resource://zotero/reader/pdf/";
pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_ROOT + "build/pdf.worker.mjs";

// PDF.js's display renderer schedules drawing with requestAnimationFrame. Gecko
// throttles that API in this deliberately invisible document to roughly 1 Hz.
// This document has no displayed animation: use cancellable message tasks here
// so drawing still yields between chunks without waiting for a hidden repaint.
// Keep display intent (including optional-content layers) and leave every actual
// Zotero window's animation scheduler unchanged.
function installBackgroundFrameScheduler(targetWindow) {
  const channel = new targetWindow.MessageChannel();
  const callbacks = new Map();
  const originalRequest = targetWindow.requestAnimationFrame;
  const originalCancel = targetWindow.cancelAnimationFrame;
  let nextID = 0;
  let closed = false;
  const request = callback => {
    if (typeof callback !== "function") throw new TypeError("Animation callback must be a function");
    if (closed) return 0;
    const id = ++nextID;
    callbacks.set(id, callback);
    channel.port2.postMessage(id);
    return id;
  };
  const cancel = id => { callbacks.delete(Number(id)); };
  channel.port1.onmessage = event => {
    const callback = callbacks.get(event.data);
    if (!callback || closed) return;
    callbacks.delete(event.data);
    callback(targetWindow.performance.now());
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    callbacks.clear();
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
    if (targetWindow.requestAnimationFrame === request) targetWindow.requestAnimationFrame = originalRequest;
    if (targetWindow.cancelAnimationFrame === cancel) targetWindow.cancelAnimationFrame = originalCancel;
    targetWindow.removeEventListener("unload", dispose);
  };
  targetWindow.requestAnimationFrame = request;
  targetWindow.cancelAnimationFrame = cancel;
  targetWindow.addEventListener("unload", dispose, { once: true });
}
installBackgroundFrameScheduler(window);

let activeLoadingTask = null;
let activeRenderTask = null;
let activeRangeTransport = null;
let renderGeneration = 0;
let pdfWorker = null;

function getPDFWorker() {
  if (!pdfWorker || pdfWorker.destroyed) {
    pdfWorker = new pdfjsLib.PDFWorker({ verbosity: 0 });
  }
  return pdfWorker;
}

function destroyPDFWorker(worker = pdfWorker) {
  if (pdfWorker === worker) pdfWorker = null;
  try { worker?.destroy(); } catch (_) {}
}

function cancelRendering() {
  renderGeneration++;
  activeRangeTransport?.abort();
  try { activeRenderTask?.cancel(); } catch (_) {}
  try { activeLoadingTask?.destroy().catch(() => {}); } catch (_) {}
  destroyPDFWorker();
}
window.addEventListener("unload", cancelRendering, { once: true });

function canvasFor(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

const PDF_RANGE_CHUNK_SIZE = 64 * 1024;
const PDF_SMALL_FILE_LIMIT = 512 * 1024;
const supportsLocalPDFRange = typeof IOUtils !== "undefined"
  && typeof IOUtils.read === "function" && typeof pdfjsLib.PDFDataRangeTransport === "function";

async function localPDFSource(path, size, onError) {
  if (typeof path !== "string" || !Number.isSafeInteger(size) || size <= 0 || size > 256 * 1024 * 1024) {
    throw new Error("Invalid local PDF source");
  }
  // Several tiny range requests cost more than one read for ordinary short
  // articles. Reserve demand loading for files large enough to benefit from it.
  const initialLength = size <= PDF_SMALL_FILE_LIMIT ? size : PDF_RANGE_CHUNK_SIZE;
  const initialData = await IOUtils.read(path, { maxBytes: initialLength });
  if (initialData.length !== initialLength) throw new Error("PDF file changed while reading");
  if (initialData.length === size) return { data: initialData };
  const range = new class extends pdfjsLib.PDFDataRangeTransport {
    constructor() { super(size, initialData, true); this.aborted = false; }
    requestDataRange(begin, end) {
      if (this.aborted) return;
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > size) {
        onError(new Error("Invalid PDF byte range"));
        return;
      }
      IOUtils.read(path, { offset: begin, maxBytes: end - begin }).then(bytes => {
        if (this.aborted) return;
        if (bytes.length !== end - begin) throw new Error("PDF file changed while reading");
        this.onDataRange(begin, bytes);
      }).catch(error => { if (!this.aborted) onError(error); });
    }
    abort() { this.aborted = true; }
  }();
  // Without both switches PDF.js eagerly fetches the rest of the book even
  // though a thumbnail only needs page one. Damaged PDFs can still request more.
  return { range, rangeChunkSize: PDF_RANGE_CHUNK_SIZE, disableStream: true, disableAutoFetch: true };
}

async function renderPDF({ bytes, path, size }, maxWidth, maxHeight) {
  let canvas;
  let task;
  let rejectRead;
  const generation = renderGeneration;
  const readFailure = new Promise((_, reject) => { rejectRead = reject; });
  const source = supportsLocalPDFRange && path ? await localPDFSource(path, size, rejectRead) : { data: bytes };
  if (generation !== renderGeneration) {
    source.range?.abort();
    throw new Error("Thumbnail render cancelled");
  }
  activeRangeTransport = source.range || null;
  const worker = getPDFWorker();
  try {
    task = pdfjsLib.getDocument({
      ...source,
      // Each renderer handles one document at a time. Retain its worker between
      // jobs, avoiding worker startup and PDF.js initialization for every card.
      worker,
      cMapUrl: PDF_ROOT + "web/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: PDF_ROOT + "web/standard_fonts/",
      wasmUrl: PDF_ROOT + "web/wasm/",
      iccUrl: PDF_ROOT + "web/iccs/",
      // Previews never execute PDF actions, scripting, or external requests.
      isEvalSupported: false,
      enableXfa: false,
      useWorkerFetch: false,
      stopAtErrors: false,
      verbosity: 0,
      maxImageSize: 32 * 1024 * 1024
    });
    activeLoadingTask = task;
    return await Promise.race([readFailure, (async () => {
      // Password-protected files produce a placeholder without asking for a password.
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(maxWidth / original.width, maxHeight / original.height);
      const viewport = page.getViewport({ scale });
      canvas = canvasFor(viewport.width, viewport.height);
      activeRenderTask = page.render({
        canvasContext: canvas.getContext("2d", { alpha: false }),
        viewport,
        background: "rgb(255,255,255)",
        annotationMode: pdfjsLib.AnnotationMode.DISABLE
      });
      await activeRenderTask.promise;
      return { src: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
    })()]);
  }
  finally {
    source.range?.abort();
    if (activeRangeTransport === source.range) activeRangeTransport = null;
    activeRenderTask = null;
    if (activeLoadingTask === task) activeLoadingTask = null;
    if (canvas) canvas.width = canvas.height = 0;
    // An explicitly supplied PDFWorker is not owned by the loading task. This
    // releases PDF bytes, pages, fonts, and canvases while keeping the worker warm.
    try { await task?.destroy(); }
    catch (_) {
      // Never reuse a worker whose document resources could not be released.
      destroyPDFWorker(worker);
    }
  }
}

async function renderImage(bytes, mime, maxWidth, maxHeight) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  let canvas;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight
      || image.naturalWidth * image.naturalHeight > 32 * 1024 * 1024) return null;
    const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
    canvas = canvasFor(image.naturalWidth * scale, image.naturalHeight * scale);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { src: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
  }
  finally {
    URL.revokeObjectURL(url);
    if (canvas) canvas.width = canvas.height = 0;
  }
}

window.LibraryThumbnailRenderer = {
  supportsLocalPDFRange,
  async render({ bytes, path, size, mime, maxWidth = 360, maxHeight = 480 }) {
    if (mime === "application/pdf") return renderPDF({ bytes, path, size }, maxWidth, maxHeight);
    if (mime.startsWith("image/")) return renderImage(bytes, mime, maxWidth, maxHeight);
    return null;
  },
  cancel: cancelRendering
};
window.dispatchEvent(new Event("library-thumbnail-renderer-ready"));
