const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const model = require("../model.js");

function fixture({ width = 900, height = 600, count = 1000 } = {}) {
  const frames = new Map();
  let frameID = 0;
  const stats = { created: 0, previews: 0, previewIDs: [], styles: 0, visibleUpdates: 0, motions: 0,
    images: 0, decodes: 0, locks: 0, unlocks: 0 };
  const style = () => new Proxy({}, { set(target, name, value) { stats.styles++; target[name] = value; return true; } });
  const window = {
    document: { activeElement: null },
    requestAnimationFrame(callback) { frames.set(++frameID, callback); return frameID; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout() { return 1; }, clearTimeout() {}, clearInterval() {},
    matchMedia() { return { matches: false }; }
  };
  const scope = vm.createContext({ LibraryGridModel: model,
    Zotero: { Prefs: { get() {}, set() {} }, debug() {} },
    Components: { interfaces: { nsIImageLoadingContent: { CURRENT_REQUEST: 0 } } },
    LibraryThumbnails: class { peek() {} destroy() {} setVisibleItems() { stats.visibleUpdates++; } }
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
    const placeholder = { lastChild: { textContent: "Loading preview…" } };
    let previewChild = placeholder;
    return {
      _itemID: item.id, decodedImage: {}, style: style(), isConnected: false,
      _placeholder: placeholder,
      _preview: {
        get firstChild() { return previewChild; },
        querySelector() { return previewChild.tagName === "img" ? previewChild : null; },
        replaceChildren(child) { previewChild = child; }
      },
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
  controller.el = (tagName, attrs) => {
    if (tagName === "img") stats.images++;
    const request = { lockImage() { stats.locks++; }, unlockImage() { stats.unlocks++; } };
    return { tagName, getAttribute(name) { return attrs[name]; },
      async decode() { stats.decodes++; },
      QueryInterface() { return { getRequest() { return request; } }; }
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

test("returning far beyond the detached-card pool restores cached previews before validation completes", async () => {
  const { controller } = fixture();
  const cache = new Map();
  const validations = [];
  let deferValidation = false;
  controller.loadThumbnail = Object.getPrototypeOf(controller).loadThumbnail;
  controller.engine.peek = item => cache.get(item.id);
  controller.engine.get = item => {
    if (deferValidation) return new Promise(resolve => validations.push(() => resolve(cache.get(item.id))));
    const result = { src: `file:///thumbnail-cache/${item.id}.png`, width: 360, height: 480 };
    cache.set(item.id, result);
    return Promise.resolve(result);
  };
  controller.render();
  await new Promise(resolve => setImmediate(resolve));
  const firstCard = controller.cards.get(1);
  const firstImage = firstCard._preview.firstChild;
  assert.equal(firstCard._preview.firstChild.getAttribute("src"), cache.get(1).src);
  for (let position = 0; position < 50000; position += 1700) {
    controller.viewport.scrollTop = position;
    controller.render();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(controller.detachedCards.size <= 48);
    assert.ok(controller.cards.size < 80);
  }
  assert.equal(controller.detachedCards.has(1), false, "first card has been evicted from the DOM pool");
  deferValidation = true;
  controller.viewport.scrollTop = 0;
  controller.render();
  const restored = controller.cards.get(1);
  assert.notEqual(restored, firstCard);
  assert.equal(restored._preview.firstChild.getAttribute("src"), cache.get(1).src,
    "the returning card displays its saved preview synchronously");
  assert.equal(restored._preview.firstChild, firstImage,
    "the returning card reuses the loaded image request, not merely its file URL");
  assert.ok(validations.length > 0, "source validation still runs in the background");
  for (const validate of validations) validate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored._previewReady, true);
});

test("a restored cached preview remains visible until a changed attachment finishes decoding", async () => {
  const { controller } = fixture();
  const card = controller.createCard({ id: 1 });
  card.isConnected = true;
  const cached = { src: "file:///cache/old.png", width: 360, height: 480 };
  const replacement = { ...cached, src: "file:///cache/new.png" };
  controller.engine.peek = () => cached;
  controller.engine.get = async () => replacement;
  let decoded;
  const createImage = controller.el;
  controller.el = (tag, attrs) => {
    const image = createImage(tag, attrs);
    image.decode = () => new Promise(resolve => { decoded = resolve; });
    return image;
  };
  const retained = createImage("img", cached);
  controller.rememberPreview(1, retained, cached);
  Object.getPrototypeOf(controller).loadThumbnail.call(controller, card, { id: 1 });
  assert.equal(card._preview.firstChild.getAttribute("src"), cached.src);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(card._preview.firstChild.getAttribute("src"), cached.src);
  decoded();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(card._preview.firstChild.getAttribute("src"), replacement.src);
  assert.equal(card._previewReady, true);
});

test("scrolling through 2000 previews reuses every image node without additional loads or decode calls", async () => {
  const { controller, stats } = fixture({ count: 2000 });
  controller.loadThumbnail = Object.getPrototypeOf(controller).loadThumbnail;
  controller.engine.get = async item => ({ src: `file:///cache/${item.id}.png`, width: 360, height: 480 });
  controller.render();
  await new Promise(resolve => setImmediate(resolve));
  const first = controller.cards.get(1)._preview.firstChild;
  for (let top = 600; top < controller.layout.height; top += 600) {
    controller.viewport.scrollTop = top;
    controller.render();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(controller.cards.size < 80);
    assert.ok(controller.detachedCards.size <= 48);
  }
  assert.equal(controller.previewImages.size, 2000);
  assert.equal(stats.images, 2000);
  assert.equal(stats.decodes, 2000);
  assert.ok(controller.lockedPreviewBytes <= 512 * 1024 * 1024);
  assert.ok(controller.lockedPreviewImages.size < 2000, "decoded surfaces obey a separate byte budget");
  for (let top = controller.layout.height - 600; top > 0; top -= 600) {
    controller.viewport.scrollTop = top;
    controller.render();
    await new Promise(resolve => setImmediate(resolve));
  }
  controller.viewport.scrollTop = 0;
  controller.render();
  assert.equal(controller.cards.get(1)._preview.firstChild, first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stats.images, 2000, "scroll-back never assigns a cached URL to a new img");
  assert.equal(stats.decodes, 2000, "scroll-back never explicitly decodes a loaded image again");
  controller.destroy();
  assert.equal(stats.locks, stats.unlocks, "all native image locks are released on shutdown");
  assert.equal(controller.lockedPreviewBytes, 0);
});

test("image retention uses LRU eviction and balances locks on replacement and attachment deletion", async () => {
  const { controller, stats } = fixture();
  controller.maxPreviewImages = 3;
  const result = id => ({ src: `file:///cache/${id}.png`, width: 360, height: 480, attachmentID: id + 100 });
  for (let id = 1; id <= 3; id++) await controller.prepareThumbnail(id, result(id));
  await controller.prepareThumbnail(1, result(1));
  await controller.prepareThumbnail(4, result(4));
  assert.deepEqual([...controller.previewImages.keys()], [3, 1, 4]);
  assert.equal(stats.unlocks, 1, "least recently used image released its native lock");
  const old = controller.previewImages.get(1).image;
  const changed = { ...result(1), src: "file:///cache/changed.png" };
  await controller.prepareThumbnail(1, changed);
  assert.notEqual(controller.previewImages.get(1).image, old);
  assert.equal(stats.unlocks, 2, "replacement releases the original image lock");
  controller.invalidatePreview(101);
  assert.equal(controller.previewImages.has(1), false);
  assert.equal(stats.unlocks, 3, "deleting an attachment also releases its parent card preview");
  controller.destroy();
  assert.equal(stats.locks, stats.unlocks);
  assert.equal(controller.previewSourceBytes, 0);
});

test("decoded pixels have a separate bounded LRU without evicting reusable image requests", async () => {
  const { controller, stats } = fixture();
  const bytes = 360 * 480 * 4;
  controller.maxLockedPreviewBytes = bytes * 2;
  const result = id => ({ src: `file:///cache/${id}.png`, width: 360, height: 480 });
  for (let id = 1; id <= 3; id++) await controller.prepareThumbnail(id, result(id));
  assert.equal(controller.previewImages.size, 3);
  assert.deepEqual([...controller.lockedPreviewImages.keys()], [2, 3]);
  assert.equal(controller.lockedPreviewBytes, bytes * 2);
  const first = controller.previewImages.get(1).image;
  assert.equal(await controller.prepareThumbnail(1, result(1)), first);
  assert.deepEqual([...controller.lockedPreviewImages.keys()], [3, 1]);
  assert.equal(stats.images, 3);
  assert.equal(stats.decodes, 3);
  controller.destroy();
  assert.equal(stats.locks, stats.unlocks);
});

test("an in-flight decode remains reusable after its original card scrolls away", async () => {
  const { controller } = fixture();
  const item = { id: 1 };
  const card = controller.createCard(item);
  card.isConnected = true;
  const result = { src: "file:///cache/1.png", width: 360, height: 480 };
  controller.engine.get = async () => result;
  let decoded;
  const original = controller.el;
  controller.el = (tag, attrs) => {
    const image = original(tag, attrs);
    image.decode = () => new Promise(resolve => { decoded = resolve; });
    return image;
  };
  Object.getPrototypeOf(controller).loadThumbnail.call(controller, card, item);
  await new Promise(resolve => setImmediate(resolve));
  controller.retireCard(card);
  decoded();
  await new Promise(resolve => setImmediate(resolve));
  const image = controller.previewImages.get(item.id).image;
  const replacement = controller.createCard(item);
  replacement.isConnected = true;
  Object.getPrototypeOf(controller).loadThumbnail.call(controller, replacement, item);
  assert.equal(replacement._preview.firstChild, image);
  controller.destroy();
});

test("failed replacement decoding leaves an existing preview visible", async () => {
  const { controller } = fixture();
  const card = controller.createCard({ id: 1 });
  card.isConnected = true;
  const initial = { src: "file:///cache/1.png", width: 360, height: 480 };
  const image = await controller.prepareThumbnail(1, initial);
  controller.engine.get = async () => ({ ...initial, src: "file:///cache/broken.png" });
  controller.el = () => ({ decode: async () => { throw new Error("Invalid image"); } });
  Object.getPrototypeOf(controller).loadThumbnail.call(controller, card, { id: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(card._preview.firstChild, image);
  assert.equal(controller.previewImages.get(1).image, image);
});

test("a late cached decode cannot restore an attachment that source validation found missing", async () => {
  const { controller } = fixture();
  const card = controller.createCard({ id: 1 });
  card.isConnected = true;
  controller.engine.peek = () => ({ src: "file:///cache/removed.png", width: 360, height: 480 });
  controller.engine.get = async () => null;
  let decoded;
  const original = controller.el;
  controller.el = (tag, attrs) => {
    const image = original(tag, attrs);
    image.decode = () => new Promise(resolve => { decoded = resolve; });
    return image;
  };
  Object.getPrototypeOf(controller).loadThumbnail.call(controller, card, { id: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(card._placeholder.lastChild.textContent, "No local preview");
  decoded();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(card._preview.firstChild, card._placeholder);
  assert.equal(controller.previewImages.size, 0);
});

test("encoded fallback previews stay bounded when persistent disk caching is unavailable", async () => {
  const { controller } = fixture();
  controller.maxPreviewSourceBytes = 100;
  const result = id => ({ src: "data:image/png;base64," + String(id).repeat(20), width: 360, height: 480 });
  await controller.prepareThumbnail(1, result(1));
  await controller.prepareThumbnail(2, result(2));
  assert.equal(controller.previewImages.size, 1);
  assert.equal(controller.previewImages.has(2), true);
  assert.ok(controller.previewSourceBytes <= 100);
  controller.destroy();
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
  let priorities;
  controller.engine.setVisibleItems = (_, options) => { priorities = options.priorityItems; };
  controller.viewport.scrollTop = 3059;
  controller.render();
  const firstVisible = controller.captureAnchor().index;
  assert.equal(stats.previewIDs[0], controller.items[firstVisible].id);
  const overscanFirst = controller.items[controller.layout.start].id;
  assert.ok(stats.previewIDs.indexOf(overscanFirst) > 0);
  assert.ok(priorities.has(controller.items[firstVisible].id));
  assert.equal(priorities.has(overscanFirst), false);
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
