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

function canvasFor(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

async function renderPDF(bytes, maxWidth, maxHeight) {
  let canvas;
  let pdf;
  const task = pdfjsLib.getDocument({
    data: bytes,
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
  try {
    // Password-protected files produce a placeholder without asking for a password.
    pdf = await task.promise;
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
  }
  finally {
    activeRenderTask = null;
    if (activeLoadingTask === task) activeLoadingTask = null;
    if (canvas) canvas.width = canvas.height = 0;
    // Destroy the whole document/worker so processing a library cannot retain PDFs.
    try { await task.destroy(); }
    catch (_) { /* A watchdog may have already torn down this document. */ }
  }
}

async function renderImage(bytes, mime, maxWidth, maxHeight) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  let canvas;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) return null;
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
  async render({ bytes, mime, maxWidth = 360, maxHeight = 480 }) {
    if (mime === "application/pdf") return renderPDF(bytes, maxWidth, maxHeight);
    if (mime.startsWith("image/")) return renderImage(bytes, mime, maxWidth, maxHeight);
    return null;
  },
  cancel() {
    try { activeRenderTask?.cancel(); } catch (_) {}
    try { activeLoadingTask?.destroy().catch(() => {}); } catch (_) {}
  }
};
window.dispatchEvent(new Event("library-thumbnail-renderer-ready"));
