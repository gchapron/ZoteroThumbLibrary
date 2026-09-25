const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element(parent = null, itemID = null) {
  const attributes = new Map(itemID === null ? [] : [["data-item-id", String(itemID)]]);
  return {
    parentElement: parent,
    dataset: itemID === null ? {} : { itemId: String(itemID) },
    classList: { contains: name => name === "ziv-card" && itemID !== null },
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: name => attributes.delete(name),
    contains(node) {
      for (; node; node = node.parentElement) if (node === this) return true;
      return false;
    },
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector === ".ziv-card" && node.classList.contains("ziv-card")) return node;
      }
      return null;
    },
    getBoundingClientRect: () => ({ left: 20, top: 40, width: 160, height: 240 }),
    remove() {},
  };
}

function fixture({ operation } = {}) {
  const calls = { over: [], check: [], drop: [], leave: 0, errors: [], refresh: [] };
  const Zotero = {
    isMac: true, locked: false, DragDrop: {}, Prefs: { set() {} },
    logError: error => calls.errors.push(error),
  };
  const scope = vm.createContext({ Zotero });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../grid.js"), "utf8"), scope);
  const grid = Object.create(scope.LibraryIconView.prototype);
  const nativeIDs = [11, 22];
  const binding = { addListener() {}, removeListener() {} };
  const view = {
    onRefresh: binding, onSelect: binding,
    collectionTreeRow: { id: "C1", ref: { libraryID: 1 }, editable: true },
    getSortedItems: () => nativeIDs,
    getRowIndexByID: id => nativeIDs.includes(id) ? nativeIDs.indexOf(id) : false,
    canDropCheck(row, orientation, transfer) {
      calls.check.push({ row, orientation, transfer, view: this });
      return true;
    },
    onDragOver(event, row) {
      calls.over.push({ event, row, view: this });
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      this._dropRow = row;
      // Zotero's handler returns false for accepted drops too.
      return false;
    },
    onDragLeave() { calls.leave++; this._dropRow = null; },
    onDrop(event, row) {
      calls.drop.push({ event, row, view: this, orientation: Zotero.DragDrop.currentOrientation,
        effect: Zotero.DragDrop.currentDropEffect });
      return operation?.();
    },
  };
  grid.root = element();
  grid.viewport = element(grid.root);
  grid.cards = new Map(nativeIDs.map(id => [id, element(grid.viewport, id)]));
  grid.items = nativeIDs.map(id => ({ id }));
  grid.window = {
    ZoteroPane: { itemsView: view },
    clearTimeout() {}, clearInterval() {}, cancelAnimationFrame() {},
  };
  grid.view = view;
  grid.enabled = true;
  grid.renderFrame = null;
  grid.disposers = [];
  grid.detachedCards = new Map();
  grid.previewImages = new Map();
  grid.previewLoads = new Map();
  grid.engine = { clearQueue() {}, destroy() {} };
  grid.applyMode = () => {};
  grid.scheduleRefresh = force => calls.refresh.push(force);
  return { grid, view, calls, Zotero, nativeIDs };
}

function drag(target, options = {}) {
  return {
    target, currentTarget: target, relatedTarget: null,
    clientX: 25, clientY: 41, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    dataTransfer: { types: ["application/x-moz-file"], dropEffect: "copy" },
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    ...options,
  };
}

test("blank space imports through the native view with the original Finder event", async () => {
  const { grid, view, calls } = fixture();
  const event = drag(grid.viewport, { metaKey: true, altKey: true, shiftKey: true });
  await grid.onFileDrop(event);
  assert.equal(calls.drop.length, 1);
  assert.equal(calls.drop[0].event, event);
  assert.equal(calls.drop[0].view, view);
  assert.equal(calls.drop[0].row, -1);
  assert.equal(calls.drop[0].orientation, -1);
  assert.equal(calls.check.at(-1).transfer, event.dataTransfer);
  assert.equal(calls.check.at(-1).row, -1);
  assert.equal(calls.check.at(-1).orientation, -1);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
  assert.deepEqual(calls.refresh, [true]);
});

test("a whole card is a native on-item target, including native row zero", async () => {
  const { grid, view, calls, Zotero } = fixture();
  const card = grid.cards.get(11);
  const child = element(card);
  const event = drag(child, { metaKey: true, altKey: true, ctrlKey: true, shiftKey: true });
  const target = grid.fileDropTarget(event);
  assert.equal(target.view, view);
  assert.equal(target.card, card);
  assert.equal(target.element, card);
  assert.equal(target.row, 0);
  grid.onFileDragOver(event);
  assert.equal(calls.over.length, 1, "native drag-over runs before returning from the DOM event");
  const forwarded = calls.over[0].event;
  assert.equal(calls.over[0].row, 0);
  assert.equal(calls.over[0].view, view);
  assert.equal(forwarded.dataTransfer, event.dataTransfer);
  for (const modifier of ["metaKey", "altKey", "ctrlKey", "shiftKey"]) assert.equal(forwarded[modifier], true);
  assert.equal(forwarded.currentTarget, card);
  assert.equal(forwarded.target, card);
  const rect = card.getBoundingClientRect();
  assert.equal(forwarded.clientY, rect.top + rect.height / 2, "card edges must not become before/after item drops");
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
  assert.equal(card.getAttribute("data-file-drop"), "true");
  Zotero.DragDrop.currentDropEffect = "link";
  await grid.onFileDrop(event);
  assert.equal(calls.drop[0].event, event);
  assert.equal(calls.drop[0].row, 0);
  assert.equal(calls.drop[0].orientation, 0);
  assert.equal(calls.drop[0].effect, "link", "native effect survives until Zotero consumes the drop");
  assert.equal(Zotero.DragDrop.currentDropEffect, null);
  assert.equal(calls.check.at(-1).orientation, 0);
  assert.equal(card.getAttribute("data-file-drop"), null);
});

test("drops resolve the native row again after sorting instead of importing into the hovered row", async () => {
  const { grid, calls, nativeIDs } = fixture();
  const event = drag(element(grid.cards.get(11)));
  grid.onFileDragOver(event);
  nativeIDs.reverse();
  await grid.onFileDrop(event);
  assert.equal(calls.over[0].row, 0);
  assert.equal(calls.check.at(-1).row, 1);
  assert.equal(calls.drop[0].row, 1);
});

test("a replaced native view receives the final drop and the old view loses its hover", async () => {
  const first = fixture();
  const second = fixture();
  const event = drag(first.grid.viewport);
  first.grid.onFileDragOver(event);
  first.grid.window.ZoteroPane.itemsView = second.view;
  await first.grid.onFileDrop(event);
  assert.equal(first.calls.drop.length, 0);
  assert.equal(second.calls.drop.length, 1);
  assert.equal(second.calls.drop[0].event, event);
  assert.equal(first.view._dropRow, null);
  assert.equal(first.calls.leave, 1);
});

test("removed native rows and replaced cards cannot fall back to an unintended library import", async () => {
  for (const change of ["missing-row", "replaced-card", "unmounted-card"]) {
    const { grid, calls, nativeIDs } = fixture();
    const card = grid.cards.get(11);
    const event = drag(element(card));
    grid.onFileDragOver(event);
    if (change === "missing-row") nativeIDs.splice(0, 1);
    if (change === "replaced-card") grid.cards.set(11, element(grid.viewport, 11));
    if (change === "unmounted-card") grid.cards.delete(11);
    assert.equal(grid.fileDropTarget(event), null, change);
    await grid.onFileDrop(event);
    assert.equal(calls.drop.length, 0, change);
    assert.equal(card.getAttribute("data-file-drop"), null, change);
  }
});

test("inactive grids, unavailable native APIs and unrelated drags never reach the import handler", async () => {
  for (const mode of ["dead", "disabled", "locked", "no-transfer", "no-view", "no-context",
    "no-over", "no-drop", "no-check", "text", "internal-item", "internal-collection"]) {
    const { grid, view, calls, Zotero } = fixture();
    const event = drag(grid.viewport);
    if (mode === "dead") grid.dead = true;
    if (mode === "disabled") grid.enabled = false;
    if (mode === "locked") Zotero.locked = true;
    if (mode === "no-transfer") event.dataTransfer = null;
    if (mode === "no-view") grid.window.ZoteroPane.itemsView = false;
    if (mode === "no-context") view.collectionTreeRow = null;
    if (mode === "no-over") delete view.onDragOver;
    if (mode === "no-drop") delete view.onDrop;
    if (mode === "no-check") delete view.canDropCheck;
    if (mode === "text") event.dataTransfer.types = ["text/plain"];
    if (mode === "internal-item") event.dataTransfer.types.push("zotero/item");
    if (mode === "internal-collection") event.dataTransfer.types.push("zotero/collection");
    assert.equal(grid.fileDropTarget(event), null, mode);
    grid.onFileDragOver(event);
    await grid.onFileDrop(event);
    assert.equal(calls.over.length, 0, mode);
    assert.equal(calls.drop.length, 0, mode);
    assert.deepEqual(calls.refresh, [], mode);
  }
});

test("native refusal clears highlighting and cannot be bypassed by dropping anyway", async () => {
  const { grid, view, calls } = fixture();
  const event = drag(grid.cards.get(11));
  grid.onFileDragOver(event);
  view.onDragOver = event => { event.dataTransfer.dropEffect = "none"; return false; };
  view.canDropCheck = () => false;
  grid.onFileDragOver(event);
  assert.equal(event.dataTransfer.dropEffect, "none");
  assert.equal(grid.cards.get(11).getAttribute("data-file-drop"), null);
  // Permissions or library context may also change after an accepted hover.
  event.dataTransfer.dropEffect = "copy";
  await grid.onFileDrop(event);
  assert.equal(calls.drop.length, 0);
  assert.equal(event.dataTransfer.dropEffect, "none");
  assert.deepEqual(calls.refresh, []);
});

test("drop eligibility is checked again even when the hover had been accepted", async () => {
  const { grid, view, calls } = fixture();
  const event = drag(grid.viewport);
  grid.onFileDragOver(event);
  view.canDropCheck = () => false;
  await grid.onFileDrop(event);
  assert.equal(calls.drop.length, 0);
  assert.equal(event.dataTransfer.dropEffect, "none");
  assert.equal(grid.viewport.getAttribute("data-file-drop"), null);
});

test("native hover and drop errors are logged and clear feedback without escaping the event handler", async () => {
  for (const stage of ["over", "check", "drop-sync", "drop-async"]) {
    const failure = new Error(stage);
    const { grid, view, calls } = fixture();
    const event = drag(grid.viewport);
    grid.onFileDragOver(event);
    if (stage === "over") view.onDragOver = () => { throw failure; };
    if (stage === "check") view.canDropCheck = () => { throw failure; };
    if (stage === "drop-sync") view.onDrop = () => { throw failure; };
    if (stage === "drop-async") view.onDrop = () => Promise.reject(failure);
    if (stage === "over") assert.doesNotThrow(() => grid.onFileDragOver(event));
    else await assert.doesNotReject(() => grid.onFileDrop(event));
    assert.equal(calls.errors[0], failure, stage);
    assert.equal(grid.viewport.getAttribute("data-file-drop"), null, stage);
    assert.equal(view._dropRow, null, stage);
    assert.deepEqual(calls.refresh, [], stage);
  }
});

test("leaving for a descendant preserves feedback; leaving the icon view clears native hover once", () => {
  const { grid, view, calls } = fixture();
  grid.onFileDragOver(drag(grid.viewport));
  grid.onFileDragLeave(drag(grid.viewport, { relatedTarget: element(grid.cards.get(11)) }));
  assert.equal(grid.viewport.getAttribute("data-file-drop"), "true");
  assert.equal(calls.leave, 0);
  grid.onFileDragLeave(drag(grid.viewport, { relatedTarget: element() }));
  grid.clearFileDrop();
  assert.equal(grid.viewport.getAttribute("data-file-drop"), null);
  assert.equal(view._dropRow, null);
  assert.equal(calls.leave, 1);
});

test("finishing an import refreshes only the unchanged live library context", async () => {
  for (const change of ["none", "dead", "disabled", "bound-view", "pane-view", "collection", "secondary-collection", "view-mode"]) {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const { grid, view, calls } = fixture({ operation: () => pending });
    const rows = [view.collectionTreeRow, { id: "C2", ref: { libraryID: 1 } }];
    view.collectionTreeRows = rows;
    Object.defineProperty(view, "collectionTreeRow", { get() { throw new Error("Removed Zotero 10 property"); } });
    const event = drag(grid.viewport);
    grid.onFileDragOver(event);
    const result = grid.onFileDrop(event);
    assert.equal(calls.drop.length, 1, change);
    assert.equal(grid.viewport.getAttribute("data-file-drop"), null, "clear feedback before asynchronous import finishes");
    if (change === "dead") grid.dead = true;
    if (change === "disabled") grid.enabled = false;
    if (change === "bound-view") grid.view = {};
    if (change === "pane-view") grid.window.ZoteroPane.itemsView = {};
    if (change === "collection") rows[0] = { id: "C3", ref: { libraryID: 1 } };
    if (change === "secondary-collection") rows[1] = { id: "C4", ref: { libraryID: 1 } };
    if (change === "view-mode") view.viewMode = "trash";
    finish(); await result;
    assert.deepEqual(calls.refresh, change === "none" ? [true] : [], change);
  }
});

test("switching to list view and destroying the grid remove pending drop feedback", () => {
  for (const method of ["toggle", "destroy"]) {
    const { grid, view, calls } = fixture();
    grid.onFileDragOver(drag(grid.viewport));
    grid[method]();
    assert.equal(grid.viewport.getAttribute("data-file-drop"), null, method);
    assert.equal(view._dropRow, null, method);
    assert.equal(calls.leave, 1, method);
  }
});

test("initialized icon view accepts drops anywhere in its root and removes listeners on shutdown", async () => {
  const { grid, Zotero } = fixture();
  function node() {
    const el = element();
    el.style = {};
    el.listeners = new Map();
    el.append = (...children) => children.forEach(child => { child.parentElement = el; });
    el.insertBefore = child => el.append(child);
    el.querySelector = () => null;
    el.addEventListener = (type, listener) => el.listeners.set(type, listener);
    el.removeEventListener = type => el.listeners.delete(type);
    return el;
  }
  const nodes = new Map(["zotero-items-pane", "zotero-items-tree", "zotero-items-toolbar"].map(id => [id, node()]));
  grid.doc = { getElementById: id => nodes.get(id), documentElement: node(), createElementNS: node };
  grid.window.ResizeObserver = class { observe() {} disconnect() {} };
  grid.window.setInterval = () => 1;
  grid.refresh = () => {};
  Zotero.Notifier = { registerObserver: () => 1, unregisterObserver() {} };
  const received = [];
  for (const [type, method] of [["dragover", "onFileDragOver"], ["drop", "onFileDrop"], ["dragleave", "onFileDragLeave"]]) {
    grid[method] = event => received.push({ type, event });
  }
  await grid.init();
  const root = grid.root;
  for (const type of ["dragover", "drop", "dragleave"]) {
    const event = drag(root);
    assert.equal(typeof root.listeners.get(type), "function", type);
    root.listeners.get(type)(event);
    assert.deepEqual(received.at(-1), { type, event });
  }
  grid.destroy();
  for (const type of ["dragover", "drop", "dragleave"]) assert.equal(root.listeners.has(type), false, type);
});
