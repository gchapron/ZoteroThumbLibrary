const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../thumbnail-renderer.js"), "utf8")
  .replace(/^import \* as pdfjsLib from [^\n]+;\n/m, "");

function fixture({ imageWidth = 300, imageHeight = 450, readPDF } = {}) {
  const messages = [], channels = [], listeners = new Map(), canvases = [], workers = [];
  const originalRequest = () => { throw new Error("Hidden document animation frames must not be used"); };
  const originalCancel = () => {};
  const imageState = { revoked: [], draws: [] };
  class MessageChannel {
    constructor() {
      this.port1 = { closed: false, onmessage: null, close() { this.closed = true; } };
      this.port2 = { closed: false, close() { this.closed = true; }, postMessage: value => {
        messages.push(() => {
          if (!this.port1.closed) this.port1.onmessage?.({ data: value });
        });
      } };
      channels.push(this);
    }
  }
  const window = {
    MessageChannel, performance: { now: () => 123.5 },
    requestAnimationFrame: originalRequest, cancelAnimationFrame: originalCancel,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); }
  };
  const pdfjsLib = { GlobalWorkerOptions: {}, AnnotationMode: { DISABLE: 0 },
    PDFDataRangeTransport: class {
      constructor(length, initialData, progressiveDone) {
        Object.assign(this, { length, initialData, progressiveDone });
      }
      onDataRange(begin, bytes) { this.onRange?.(begin, bytes); }
    },
    PDFWorker: class {
      constructor() { this.destroyed = false; this.destroyCalls = 0; workers.push(this); }
      destroy() { this.destroyed = true; this.destroyCalls++; }
    }
  };
  const document = { createElement(type) {
    assert.equal(type, "canvas");
    const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {},
      drawImage(image, x, y, width, height) { imageState.draws.push({ x, y, width, height }); }
    }), toDataURL: () => "data:image/png;base64,fixture" };
    canvases.push(canvas);
    return canvas;
  } };
  vm.runInNewContext(source, { window, document, pdfjsLib, Blob, ...(readPDF ? { IOUtils: { read: readPDF } } : {}),
    URL: { createObjectURL: () => "blob:cover", revokeObjectURL: value => imageState.revoked.push(value) },
    Image: class { constructor() { this.naturalWidth = imageWidth; this.naturalHeight = imageHeight; } async decode() {} },
    Event: class { constructor(type) { this.type = type; } } });
  return { window, pdfjsLib, channels, messages, canvases, workers, originalRequest, originalCancel, imageState,
    flushOne() { messages.shift()?.(); }, unload() { window.dispatchEvent({ type: "unload" }); } };
}

test("private renderer frames are asynchronous and receive a high-resolution timestamp", () => {
  const harness = fixture();
  let calls = 0;
  harness.window.requestAnimationFrame(timestamp => { calls++; assert.equal(timestamp, 123.5); });
  assert.equal(calls, 0);
  harness.flushOne();
  assert.equal(calls, 1);
  assert.equal(harness.messages.length, 0);
  harness.unload();
});

test("frame cancellation drops only its callback and nested frames yield another task", () => {
  const harness = fixture();
  const calls = [];
  const cancelled = harness.window.requestAnimationFrame(() => calls.push("cancelled"));
  harness.window.cancelAnimationFrame(cancelled);
  harness.window.requestAnimationFrame(() => {
    calls.push("first");
    harness.window.requestAnimationFrame(() => calls.push("second"));
  });
  harness.flushOne();
  assert.deepEqual(calls, []);
  harness.flushOne();
  assert.deepEqual(calls, ["first"]);
  harness.flushOne();
  assert.deepEqual(calls, ["first", "second"]);
  harness.unload();
});

test("unloading restores the original APIs, closes both ports, and drops pending work", () => {
  const harness = fixture();
  let called = false;
  harness.window.requestAnimationFrame(() => { called = true; });
  harness.unload();
  harness.flushOne();
  assert.equal(called, false);
  assert.equal(harness.window.requestAnimationFrame, harness.originalRequest);
  assert.equal(harness.window.cancelAnimationFrame, harness.originalCancel);
  assert.ok(harness.channels.every(channel => channel.port1.closed && channel.port2.closed));
});

test("PDF thumbnail rendering keeps display intent and releases its canvas and document", async () => {
  const harness = fixture();
  let renderOptions, destroyed = 0;
  const page = {
    getViewport({ scale }) { return { width: 612 * scale, height: 792 * scale }; },
    render(options) {
      renderOptions = options;
      return { promise: new Promise(resolve => harness.window.requestAnimationFrame(resolve)) };
    }
  };
  harness.pdfjsLib.getDocument = () => ({
    promise: Promise.resolve({ getPage: async () => page }),
    async destroy() { destroyed++; }
  });
  const resultPromise = harness.window.LibraryThumbnailRenderer.render({ bytes: new Uint8Array([1]), mime: "application/pdf" });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(renderOptions);
  assert.equal(renderOptions.intent ?? "display", "display");
  assert.equal(renderOptions.annotationMode, 0);
  harness.flushOne();
  const result = await resultPromise;
  assert.equal(result.width, 360);
  assert.equal(result.height, 466);
  assert.equal(destroyed, 1);
  assert.equal(harness.workers.length, 1);
  assert.equal(harness.workers[0].destroyed, false);
  assert.ok(harness.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  harness.unload();
  assert.equal(harness.workers[0].destroyed, true);
});

test("successive PDF documents reuse one worker but each document is destroyed before returning", async () => {
  const harness = fixture();
  const documents = [];
  harness.pdfjsLib.getDocument = options => {
    const state = { options, destroyed: false };
    documents.push(state);
    return {
      promise: Promise.resolve({ getPage: async () => ({
        getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve() })
      }) }),
      async destroy() { await Promise.resolve(); state.destroyed = true; }
    };
  };
  for (let i = 0; i < 3; i++) {
    await harness.window.LibraryThumbnailRenderer.render({ bytes: new Uint8Array([i]), mime: "application/pdf" });
    assert.ok(documents.every(document => document.destroyed));
  }
  assert.equal(harness.workers.length, 1);
  assert.ok(documents.every(document => document.options.worker === harness.workers[0]));
  assert.equal(harness.workers[0].destroyCalls, 0);
  harness.unload();
  assert.equal(harness.workers[0].destroyCalls, 1);
});

test("cancelling active PDF work releases its worker and the next request starts a new one", async () => {
  const harness = fixture();
  let rejectRender, cancels = 0, destroyedDocuments = 0;
  harness.pdfjsLib.getDocument = () => ({
    promise: Promise.resolve({ getPage: async () => ({
      getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
      render: () => ({
        promise: new Promise((_, reject) => { rejectRender = reject; }),
        cancel() { cancels++; rejectRender(new Error("cancelled")); }
      })
    }) }),
    async destroy() { destroyedDocuments++; }
  });
  const pending = harness.window.LibraryThumbnailRenderer.render({ bytes: new Uint8Array([1]), mime: "application/pdf" });
  await new Promise(resolve => setImmediate(resolve));
  harness.window.LibraryThumbnailRenderer.cancel();
  await assert.rejects(pending, /cancelled/);
  assert.equal(cancels, 1);
  assert.ok(destroyedDocuments >= 1);
  assert.equal(harness.workers[0].destroyed, true);
  assert.ok(harness.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  harness.pdfjsLib.getDocument = () => ({ promise: Promise.reject(new Error("invalid PDF")), async destroy() {} });
  await assert.rejects(harness.window.LibraryThumbnailRenderer.render({
    bytes: new Uint8Array([2]), mime: "application/pdf"
  }), /invalid PDF/);
  assert.equal(harness.workers.length, 2);
  assert.equal(harness.workers[1].destroyed, false);
  harness.unload();
  assert.equal(harness.workers[1].destroyed, true);
});

test("failed document cleanup discards its worker before another PDF request", async () => {
  const harness = fixture();
  harness.pdfjsLib.getDocument = () => ({
    promise: Promise.reject(new Error("invalid PDF")),
    async destroy() { throw new Error("worker cleanup failed"); }
  });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(harness.window.LibraryThumbnailRenderer.render({
      bytes: new Uint8Array([i]), mime: "application/pdf"
    }), /invalid PDF/);
    assert.equal(harness.workers.length, i + 1);
    assert.equal(harness.workers[i].destroyed, true);
  }
  harness.unload();
});

test("cover rendering preserves the image aspect ratio without page-sized white padding", async () => {
  const harness = fixture({ imageWidth: 600, imageHeight: 900 });
  const result = await harness.window.LibraryThumbnailRenderer.render({ bytes: new Uint8Array([1]), mime: "image/png" });
  assert.equal(result.width, 320);
  assert.equal(result.height, 480);
  assert.deepEqual(harness.imageState.draws, [{ x: 0, y: 0, width: 320, height: 480 }]);
  assert.deepEqual(harness.imageState.revoked, ["blob:cover"]);
  assert.equal(harness.workers.length, 0);
  assert.ok(harness.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  harness.unload();
});

test("excessive image dimensions are rejected before allocating a rendering canvas", async () => {
  const harness = fixture({ imageWidth: 10000, imageHeight: 10000 });
  assert.equal(await harness.window.LibraryThumbnailRenderer.render({ bytes: new Uint8Array([1]), mime: "image/png" }), null);
  assert.equal(harness.canvases.length, 0);
  assert.deepEqual(harness.imageState.revoked, ["blob:cover"]);
  harness.unload();
});

const simplePDF = { getPage: async () => ({
  getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
  render: () => ({ promise: Promise.resolve() })
}) };

test("large local PDFs read only initial and requested ranges without eager whole-file fetching", async () => {
  const size = 20 * 1024 * 1024, reads = [];
  const harness = fixture({ readPDF: async (path, { offset = 0, maxBytes }) => {
    reads.push({ path, offset, maxBytes });
    return new Uint8Array(maxBytes);
  } });
  let options, destroyed = 0;
  harness.pdfjsLib.getDocument = value => {
    options = value;
    return { promise: new Promise(resolve => {
      value.range.onRange = (begin, bytes) => {
        assert.equal(begin, size - 65536); assert.equal(bytes.length, 65536);
        resolve(simplePDF);
      };
      queueMicrotask(() => value.range.requestDataRange(size - 65536, size));
    }), async destroy() { destroyed++; } };
  };
  assert.equal(harness.window.LibraryThumbnailRenderer.supportsLocalPDFRange, true);
  const result = await harness.window.LibraryThumbnailRenderer.render({ path: "/synthetic/book.pdf", size, mime: "application/pdf" });
  assert.ok(result.src);
  assert.equal(options.disableAutoFetch, true);
  assert.equal(options.disableStream, true);
  assert.equal(options.range.length, size);
  assert.equal(options.data, undefined);
  assert.equal(reads.reduce((total, read) => total + read.maxBytes, 0), 128 * 1024);
  assert.equal(reads.length, 2);
  assert.equal(destroyed, 1);
  assert.equal(options.range.aborted, true);
  harness.unload();
});

test("small local PDFs use one bounded read and byte-based PDF.js loading", async () => {
  const reads = [];
  const size = 400 * 1024;
  const harness = fixture({ readPDF: async (path, options) => {
    reads.push(options.maxBytes); return new Uint8Array(options.maxBytes);
  } });
  harness.pdfjsLib.getDocument = options => {
    assert.equal(options.data.length, size);
    assert.equal(options.range, undefined);
    return { promise: Promise.resolve(simplePDF), async destroy() {} };
  };
  await harness.window.LibraryThumbnailRenderer.render({ path: "/synthetic/small.pdf", size, mime: "application/pdf" });
  assert.deepEqual(reads, [size]);
  harness.unload();
});

test("range I/O errors and truncated reads reject promptly and release the PDF document", async () => {
  for (const truncated of [false, true]) {
    let destroyed = 0, range;
    const harness = fixture({ readPDF: async (path, { offset = 0, maxBytes }) => {
      if (!offset) return new Uint8Array(maxBytes);
      if (!truncated) throw new Error("file unavailable");
      return new Uint8Array(maxBytes - 1);
    } });
    harness.pdfjsLib.getDocument = options => {
      range = options.range;
      queueMicrotask(() => range.requestDataRange(65536, 131072));
      return { promise: new Promise(() => {}), async destroy() { destroyed++; } };
    };
    await assert.rejects(harness.window.LibraryThumbnailRenderer.render({
      path: "/synthetic/broken.pdf", size: 2 * 1024 * 1024, mime: "application/pdf"
    }), truncated ? /file changed/ : /file unavailable/);
    assert.equal(destroyed, 1);
    assert.equal(range.aborted, true);
    harness.unload();
  }
});

test("cancelling during the initial PDF read cannot start a stale worker", async () => {
  let release;
  const harness = fixture({ readPDF: () => new Promise(resolve => { release = resolve; }) });
  const pending = harness.window.LibraryThumbnailRenderer.render({ path: "/synthetic/book.pdf", size: 100, mime: "application/pdf" });
  harness.window.LibraryThumbnailRenderer.cancel();
  release(new Uint8Array(100));
  await assert.rejects(pending, /cancelled/);
  assert.equal(harness.workers.length, 0);
  harness.unload();
});

test("invalid byte ranges are rejected without reading outside the attachment", async () => {
  let reads = 0;
  const harness = fixture({ readPDF: async (path, { maxBytes }) => { reads++; return new Uint8Array(maxBytes); } });
  harness.pdfjsLib.getDocument = options => {
    queueMicrotask(() => options.range.requestDataRange(-1, 131073));
    return { promise: new Promise(() => {}), async destroy() {} };
  };
  await assert.rejects(harness.window.LibraryThumbnailRenderer.render({
    path: "/synthetic/book.pdf", size: 2 * 1024 * 1024, mime: "application/pdf"
  }), /Invalid PDF byte range/);
  assert.equal(reads, 1);
  harness.unload();
});

test("cancelling a range read drops late bytes instead of feeding a destroyed PDF task", async () => {
  let releaseRange, rejectLoading, delivered = 0;
  const harness = fixture({ readPDF: async (path, { offset = 0, maxBytes }) => {
    if (!offset) return new Uint8Array(maxBytes);
    return new Promise(resolve => { releaseRange = () => resolve(new Uint8Array(maxBytes)); });
  } });
  harness.pdfjsLib.getDocument = options => {
    options.range.onRange = () => { delivered++; };
    queueMicrotask(() => options.range.requestDataRange(65536, 131072));
    return { promise: new Promise((_, reject) => { rejectLoading = reject; }),
      async destroy() { rejectLoading(new Error("cancelled")); } };
  };
  const pending = harness.window.LibraryThumbnailRenderer.render({ path: "/synthetic/book.pdf", size: 2 * 1024 * 1024, mime: "application/pdf" });
  while (!releaseRange) await new Promise(resolve => setImmediate(resolve));
  harness.window.LibraryThumbnailRenderer.cancel();
  await assert.rejects(pending, /cancelled/);
  releaseRange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered, 0);
  assert.equal(harness.workers[0].destroyed, true);
  harness.unload();
});

test("invalid or oversized local PDF source sizes are rejected before I/O", async () => {
  let reads = 0;
  const harness = fixture({ readPDF: async () => { reads++; return new Uint8Array(0); } });
  for (const size of [0, -1, 1.5, NaN, Infinity, 256 * 1024 * 1024 + 1]) {
    await assert.rejects(harness.window.LibraryThumbnailRenderer.render({
      path: "/synthetic/book.pdf", size, mime: "application/pdf"
    }), /Invalid local PDF source/);
  }
  assert.equal(reads, 0);
  assert.equal(harness.workers.length, 0);
  harness.unload();
});
