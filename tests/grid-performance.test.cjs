const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const model = require("../model.js");

function fixture({ width = 900, height = 600, count = 1000 } = {}) {
  const frames = new Map();
  let frameID = 0;
  const stats = { created: 0, previews: 0, previewIDs: [], styles: 0, visibleUpdates: 0, motions: 0 };
  const style = () => new Proxy({}, { set(target, name, value) { stats.styles++; target[name] = value; return true; } });
  const window = {
    document: { activeElement: null },
    requestAnimationFrame(callback) { frames.set(++frameID, callback); return frameID; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout() { return 1; }, clearTimeout() {},
    matchMedia() { return { matches: false }; }
  };
  const scope = vm.createContext({ LibraryGridModel: model,
    Zotero: { Prefs: { get() {}, set() {} } },
    LibraryThumbnails: class { setVisibleItems() { stats.visibleUpdates++; } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../grid.js"), "utf8"), scope);
  const controller = new scope.LibraryIconView(window, "file:///plugin/");
  controller.viewport = { clientWidth: width, clientHeight: height, scrollTop: 0, focus() {} };
  controller.canvas = { style: style(), append(card) { card.isConnected = true; } };
  controller.items = Array.from({ length: count }, (_, index) => ({ id: index + 1 }));
  controller.view = { getSelectedItems: () => [] };
  controller.createCard = item => {
    stats.created++;
    const attrs = new Map();
    return {
      _itemID: item.id, decodedImage: {}, style: style(), isConnected: false,
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.get(name); },
      contains() { return false; }, remove() { this.isConnected = false; },
      getBoundingClientRect() {
        const position = this.style.transform?.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/);
        return { x: Number(position?.[1] || 0), y: Number(position?.[2] || 0) - controller.viewport.scrollTop,
          width: parseFloat(this.style.width || 0), height: parseFloat(this.style.height || 0) };
      },
      animate() { stats.motions++; return { cancel() {} }; }
    };
  };
  controller.updateCard = card => { card._previewEpoch = controller.previewEpoch; };
  controller.loadThumbnail = card => { stats.previews++; stats.previewIDs.push(card._itemID); card._previewReady = true; };
  return { controller, stats, window, frames, flushFrame() {
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) callback();
  } };
}

test("a burst of scroll events performs one update on the next animation frame", () => {
  const { controller, frames, flushFrame } = fixture();
  let renders = 0;
  controller.render = () => { renders++; };
  for (let i = 0; i < 60; i++) controller.scheduleRender();
  assert.equal(renders, 0);
  assert.equal(frames.size, 1);
  flushFrame();
  assert.equal(renders, 1);
  assert.equal(controller.renderFrame, null);
});

test("scrolling inside a mounted range does not rewrite card styles or request previews", () => {
  const { controller, stats } = fixture();
  controller.render();
  controller.viewport.scrollTop = 30;
  controller.render();
  const baseline = { ...stats };
  for (let position = 31; position < 90; position++) {
    controller.viewport.scrollTop = position;
    controller.render();
  }
  assert.equal(stats.styles, baseline.styles);
  assert.equal(stats.previews, baseline.previews);
  assert.equal(stats.visibleUpdates, baseline.visibleUpdates);
  assert.equal(stats.motions, 0, "ordinary scrolling must not animate card coordinates");
});

test("zoom across column breakpoints preserves the same card, decoded image, and viewport offset", () => {
  const { controller, stats, flushFrame } = fixture();
  controller.viewport.scrollTop = 3059;
  controller.render();
  const anchor = controller.captureAnchor();
  const card = controller.cards.get(anchor.id);
  const image = card.decodedImage;
  const oldColumns = controller.layout.columns;
  const oldY = card.getBoundingClientRect().y;
  controller.setSize(220);
  controller.setSize(242);
  flushFrame();
  assert.notEqual(controller.layout.columns, oldColumns);
  assert.equal(controller.cards.get(anchor.id), card);
  assert.equal(card.decodedImage, image);
  assert.equal(card.getBoundingClientRect().y, oldY);
  assert.ok(stats.motions > 0, "existing cards receive a transform-only reflow transition");
  assert.ok(controller.cards.size < 80);
});

test("window-width changes preserve scroll anchoring and reduced motion skips transitions", () => {
  const { controller, window, stats, flushFrame } = fixture();
  controller.viewport.scrollTop = 5200;
  controller.render();
  const anchor = controller.captureAnchor();
  const oldY = controller.cards.get(anchor.id).getBoundingClientRect().y;
  window.matchMedia = () => ({ matches: true });
  controller.viewport.clientWidth = 480;
  controller.scheduleRender({ preserveAnchor: true, animate: true });
  flushFrame();
  assert.equal(controller.cards.get(anchor.id).getBoundingClientRect().y, oldY);
  assert.equal(stats.motions, 0);
});

test("zoom from an inter-row gap anchors the first visible card, not the preceding offscreen row", () => {
  const { controller, flushFrame } = fixture();
  controller.viewport.scrollTop = 3000;
  controller.render();
  const firstVisible = controller.items[44];
  const card = controller.cards.get(firstVisible.id);
  assert.equal(card.getBoundingClientRect().y, 12);
  assert.equal(controller.captureAnchor().id, firstVisible.id);
  controller.setSize(242);
  flushFrame();
  assert.equal(controller.cards.get(firstVisible.id), card);
  assert.equal(card.getBoundingClientRect().y, 12);
  const old = model.layout(1000, 900, 172, 0, 600);
  assert.equal(model.captureAnchor(old, 2995, 1000).index, 40, "one visible pixel still anchors the preceding row");
  assert.equal(model.captureAnchor(old, 2996, 1000).index, 44, "the exact bottom edge starts the gap");
});

test("reverse scrolling reuses decoded cards while detached and mounted counts stay bounded", () => {
  const { controller } = fixture();
  controller.render();
  const first = controller.cards.get(1);
  controller.viewport.scrollTop = 2000;
  controller.render();
  controller.viewport.scrollTop = 0;
  controller.render();
  assert.equal(controller.cards.get(1), first);
  for (let position = 0; position < 50000; position += 1700) {
    controller.viewport.scrollTop = position;
    controller.render();
    assert.ok(controller.detachedCards.size <= 48);
    assert.ok(controller.cards.size < 80);
  }
});

test("idle fallback polling skips library snapshots but notices an in-place native sort", () => {
  const { controller } = fixture();
  let refreshed = 0;
  const view = { _rows: [], _rowMap: {}, rowCount: 100000, collectionTreeRow: { id: "L1" } };
  controller.view = view;
  controller.bindView = () => {};
  controller.refresh = () => { refreshed++; };
  for (let i = 0; i < 100; i++) controller.pollView();
  assert.equal(refreshed, 1);
  // Zotero's _refreshRowMap constructs a new map after mutating sort order.
  view._rowMap = {};
  controller.pollView();
  assert.equal(refreshed, 2);
});

test("first-load requests prioritize visible thumbnails over overscan rows", () => {
  const { controller, stats } = fixture();
  controller.viewport.scrollTop = 3059;
  controller.render();
  const firstVisible = controller.captureAnchor().index;
  assert.equal(stats.previewIDs[0], controller.items[firstVisible].id);
  const overscanFirst = controller.items[controller.layout.start].id;
  assert.ok(stats.previewIDs.indexOf(overscanFirst) > 0);
});

test("anchor restoration clamps only at document boundaries and slider card widths change continuously", () => {
  const old = model.layout(500, 900, 172, 3059, 600);
  const anchor = model.captureAnchor(old, 3059, 500);
  for (const size of [120, 180, 242, 260]) {
    const next = model.layout(500, 900, size, 3059, 600);
    const scroll = model.restoreAnchor(anchor, next, 600);
    const actualOffset = next.padding + Math.floor(anchor.index / next.columns) * next.rowHeight - scroll;
    assert.equal(actualOffset, anchor.offset);
    assert.equal(next.cellWidth, size);
  }
  const short = model.layout(3, 900, 260, 0, 600);
  assert.equal(model.restoreAnchor({ index: 2, offset: -100 }, short, 600), 0);
});

test("preview refresh retains a decoded image until its replacement decodes, but removes genuinely missing previews", async () => {
  const { controller } = fixture();
  const oldImage = { getAttribute: () => "data:old" };
  let child = oldImage;
  const card = { isConnected: true, _previewToken: 0,
    _placeholder: { lastChild: { textContent: "" } },
    _preview: { querySelector: () => child === oldImage ? oldImage : null,
      replaceChildren(value) { child = value; } }
  };
  let decoded;
  const replacement = { decode: () => new Promise(resolve => { decoded = resolve; }) };
  controller.el = () => replacement;
  controller.engine.get = async () => ({ src: "data:new", width: 360, height: 480 });
  const load = Object.getPrototypeOf(controller).loadThumbnail;
  load.call(controller, card, { id: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child, oldImage);
  decoded();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child, replacement);
  controller.engine.get = async () => null;
  load.call(controller, card, { id: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child, card._placeholder);
  assert.equal(card._placeholder.lastChild.textContent, "No local preview");
});
