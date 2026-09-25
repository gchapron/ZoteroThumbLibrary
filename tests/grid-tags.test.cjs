const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture() {
  const calls = { start: [], end: 0, keys: [], errors: [] };
  const zotero = { locked: false, DragDrop: {}, logError: error => calls.errors.push(error) };
  const scope = vm.createContext({ Zotero: zotero });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../grid.js"), "utf8"), scope);
  const controller = Object.create(scope.LibraryIconView.prototype);
  const ids = [11, 22, 33];
  let selected = [11, 22];
  const view = {
    onRefresh: {}, onSelect: {}, collectionTreeRow: { editable: true },
    getSortedItems: () => ids,
    getSelectedItems: () => selected,
    getRowIndexByID: id => ids.includes(id) ? ids.indexOf(id) : false,
    onDragStart(event, index) {
      calls.start.push({ event, index });
      if (!selected.includes(ids[index])) selected = [ids[index]];
      zotero.DragDrop.currentDragSource = this.collectionTreeRow;
      event.dataTransfer.setData("zotero/item", ids.filter(id => selected.includes(id)).join(","));
      event.dataTransfer.setData("application/x-native-file-flavor", "preserved");
    },
    onDragEnd() { calls.end++; },
    handleKeyDown(event) { calls.keys.push(event); return false; }
  };
  controller.view = view;
  controller.window = { ZoteroPane: { itemsView: view } };
  controller.doc = { getElementById: () => null };
  controller.enabled = true;
  controller.anchor = 11;
  controller.items = ids.map(id => ({ id }));
  controller.cards = new Map(ids.map(id => [id, {
    attributes: {},
    getAttribute(name) { return this.attributes[name]; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getBoundingClientRect: () => ({ left: 20, top: 30, width: 150, height: 200 })
  }]));
  return { controller, view, calls, zotero };
}

function event(options = {}) {
  return { key: "1", code: "Digit1", clientX: 35, clientY: 55,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    dataTransfer: {
      data: {}, images: [],
      setData(type, value) { this.data[type] = value; },
      setDragImage(...args) { this.images.push(args); }
    }, ...options };
}

test("drag delegates synchronously, preserves multiselection and native data, and uses the visible card", () => {
  const { controller, view, calls, zotero } = fixture();
  const drag = event({ metaKey: true });
  controller.startDrag(drag, 11);
  assert.equal(calls.start.length, 1);
  assert.equal(calls.start[0].event, drag); // Command/drop modifiers stay on the original event
  assert.equal(calls.start[0].index, 0); // valid row 0 must not be rejected
  assert.equal(drag.dataTransfer.data["zotero/item"], "11,22");
  assert.equal(drag.dataTransfer.data["application/x-native-file-flavor"], "preserved");
  assert.equal(zotero.DragDrop.currentDragSource, view.collectionTreeRow);
  assert.deepEqual(drag.dataTransfer.images[0], [controller.cards.get(11), 15, 25]);
  assert.equal(controller.cards.get(22).attributes["aria-selected"], "true");
  assert.equal(controller.anchor, 11);
  assert.equal(drag.defaultPrevented, undefined);
  assert.equal(drag.stopped, true);
});

test("dragging an unselected card synchronizes the native and visible selection before drop", () => {
  const { controller, view } = fixture();
  const drag = event();
  controller.startDrag(drag, 33);
  assert.deepEqual(view.getSelectedItems(), [33]);
  assert.equal(drag.dataTransfer.data["zotero/item"], "33");
  assert.equal(controller.cards.get(11).attributes["aria-selected"], "false");
  assert.equal(controller.cards.get(33).attributes["aria-selected"], "true");
  assert.equal(controller.anchor, 33);
});

test("stale rows, unavailable transfers, locked Zotero, and disabled grids cannot start drags", () => {
  for (const mode of ["missing", "no-transfer", "locked", "disabled"]) {
    const { controller, calls, zotero } = fixture();
    const drag = event();
    if (mode === "no-transfer") drag.dataTransfer = null;
    if (mode === "locked") zotero.locked = true;
    if (mode === "disabled") controller.enabled = false;
    controller.startDrag(drag, mode === "missing" ? 999 : 11);
    assert.equal(calls.start.length, 0, mode);
    assert.equal(drag.defaultPrevented, true, mode);
  }
});

test("drag completion cleans up its original view once, without clearing a newer drag's context", () => {
  const { controller, calls, zotero } = fixture();
  controller.startDrag(event(), 11);
  controller.view = {};
  const newerSource = {};
  zotero.DragDrop.currentDragSource = newerSource;
  controller.endDrag();
  controller.endDrag();
  assert.equal(calls.end, 1);
  assert.equal(zotero.DragDrop.currentDragSource, newerSource);
});

test("a failed native drag cancels and cleans up the native image and source context", () => {
  const { controller, view, calls, zotero } = fixture();
  const nativeStart = view.onDragStart;
  view.onDragStart = function (...args) { nativeStart.apply(this, args); throw new Error("unavailable file"); };
  const drag = event();
  controller.startDrag(drag, 11);
  assert.equal(drag.defaultPrevented, true);
  assert.equal(calls.end, 1);
  assert.equal(calls.errors.length, 1);
  assert.equal(zotero.DragDrop.currentDragSource, null);
});

test("top-row, numpad and layout-dependent colored-tag keys reach the native handler without changing selection", () => {
  const { controller, calls, view } = fixture();
  for (const [code, key] of [["Digit1", "&"], ["Numpad2", "2"], ["Digit0", "0"], ["Digit9", "9"]]) {
    const keyEvent = event({ code, key });
    controller.keydown(keyEvent);
    assert.equal(calls.keys.at(-1), keyEvent);
    assert.equal(keyEvent.defaultPrevented, true);
    assert.equal(keyEvent.stopped, true);
  }
  assert.equal(calls.keys.length, 4);
  assert.deepEqual(view.getSelectedItems(), [11, 22]);
});

test("modified digits, composition and unrelated keys do not trigger tagging", () => {
  const { controller, calls } = fixture();
  for (const options of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true },
    { isComposing: true }, { code: "KeyA", key: "a" }]) {
    const keyEvent = event(options);
    assert.equal(controller.forwardTagShortcut(keyEvent), false);
    assert.equal(keyEvent.defaultPrevented, undefined);
  }
  assert.equal(calls.keys.length, 0);
});

test("unassigned native shortcuts may propagate, while read-only library keys cannot edit tags", () => {
  const { controller, view, calls } = fixture();
  view.handleKeyDown = () => true;
  const unassigned = event();
  assert.equal(controller.forwardTagShortcut(unassigned), false);
  assert.equal(unassigned.defaultPrevented, undefined);
  view.collectionTreeRow.editable = false;
  view.handleKeyDown = key => calls.keys.push(key);
  const readonly = event();
  assert.equal(controller.forwardTagShortcut(readonly), true);
  assert.equal(readonly.defaultPrevented, true);
  assert.equal(calls.keys.length, 0);
});
