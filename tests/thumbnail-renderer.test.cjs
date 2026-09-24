const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../thumbnail-renderer.js"), "utf8")
  .replace(/^import \* as pdfjsLib from [^\n]+;\n/m, "");

function fixture() {
  const messages = [], channels = [], listeners = new Map(), canvases = [];
  const originalRequest = () => { throw new Error("Hidden document animation frames must not be used"); };
  const originalCancel = () => {};
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
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); }
  };
  const pdfjsLib = { GlobalWorkerOptions: {}, AnnotationMode: { DISABLE: 0 } };
  const document = { createElement(type) {
    assert.equal(type, "canvas");
    const canvas = { width: 0, height: 0, getContext: () => ({}), toDataURL: () => "data:image/png;base64,fixture" };
    canvases.push(canvas);
    return canvas;
  } };
  vm.runInNewContext(source, { window, document, pdfjsLib, Event: class { constructor(type) { this.type = type; } } });
  return { window, pdfjsLib, channels, messages, canvases, originalRequest, originalCancel,
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
  assert.ok(harness.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  harness.unload();
});
