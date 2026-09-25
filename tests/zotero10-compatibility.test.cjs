const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const flush = () => new Promise(resolve => setImmediate(resolve));
const row = (id, libraryID = 1, editable = true) => ({ id, ref: { libraryID }, editable });

function fixture() {
  const calls = { nativeKeys: [], images: [], dragEnd: 0, refresh: 0 };
  class Item { constructor(id) { this.id = id; } isEditable() { return true; } }
  const Zotero = { Item, DragDrop: {}, logError: error => { throw error; } };
  const scope = vm.createContext({ Zotero });
  for (const file of ["model.js", "grid.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../" + file), "utf8"), scope);
  const grid = Object.create(scope.LibraryIconView.prototype);
  const items = [new Item(11), new Item(22)];
  const view = {
    onRefresh: {}, onSelect: {}, _rows: [], _rowMap: {}, rowCount: 4,
    collectionTreeRows: [row("C1"), row("C2")], viewMode: "default",
    getSortedItems: () => items,
    getSelectedItems: asIDs => asIDs ? [11] : [items[0]],
    getRowIndexByID: id => id === 11 ? 1 : false, // row 0 is a native library header
    handleKeyDown(event) { calls.nativeKeys.push(event); return true; },
    onDragStart() { Zotero.DragDrop.currentDragSource = this.collectionTreeRows[0]; },
    onDragEnd() { calls.dragEnd++; }
  };
  Object.defineProperty(view, "collectionTreeRow", { get() { throw new Error("Removed Zotero 10 API read"); } });
  grid.window = { ZoteroPane: { itemsView: view, deleteSelectedItems: async () => {} } };
  grid.view = view; grid.items = items; grid.enabled = true;
  grid.cards = new Map([[11, { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 150 }), focus() {} }]]);
  grid.viewport = { scrollTop: 500 };
  grid.doc = { activeElement: null };
  grid.focusID = 11; grid.anchor = 11; grid.previewEpoch = 0;
  grid.count = {}; grid.engine = { clearQueue() {} };
  grid.render = () => calls.refresh++;
  grid.syncSelection = () => {};
  return { grid, view, items, calls, Zotero };
}
function key(options = {}) {
  return { code: "Digit1", key: "1", preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; }, ...options };
}
function dragEvent(calls) {
  return key({ clientX: 10, clientY: 10, dataTransfer: { setDragImage: (...args) => calls.images.push(args) } });
}

test("plural collection context never reads the removed singular property and retains Zotero 9 fallback", () => {
  const { grid, view } = fixture();
  assert.equal(grid.collectionRows(), view.collectionTreeRows);
  const oldRow = row("L1");
  assert.equal(grid.collectionRows({ collectionTreeRow: oldRow })[0], oldRow);
  assert.equal(grid.collectionRows(null).length, 0);
  view.collectionTreeRows = [];
  assert.equal(grid.collectionRows().length, 0);
});

test("polling notices changes to the second collection and view mode without taking idle item snapshots", () => {
  const { grid, view, calls } = fixture();
  grid.refresh = () => calls.refresh++;
  view.getSortedItems = () => assert.fail("Idle polling must not snapshot all items");
  for (let i = 0; i < 100; i++) grid.pollView();
  assert.equal(calls.refresh, 1);
  view.collectionTreeRows = [view.collectionTreeRows[0], row("C3")];
  grid.pollView(); assert.equal(calls.refresh, 2);
  view.viewMode = "trash";
  grid.pollView(); assert.equal(calls.refresh, 3);
});

test("switching multi-collection context resets the grid even when it contains the same item IDs", () => {
  const { grid, view, calls } = fixture();
  grid.refresh();
  const before = grid.key;
  grid.viewport.scrollTop = 500;
  view.collectionTreeRows[1] = row("C3");
  grid.refresh();
  assert.notEqual(grid.key, before);
  assert.equal(grid.viewport.scrollTop, 0);
  assert.equal(calls.refresh, 2);
});

test("colored tag delegation preserves native multi-library handling and original events", () => {
  const { grid, view, calls } = fixture();
  view.collectionTreeRows[1] = row("L2", 2);
  const event = key();
  assert.equal(grid.forwardTagShortcut(event), false); // native returns unhandled for mixed libraries
  assert.equal(calls.nativeKeys[0], event);
  assert.equal(event.defaultPrevented, undefined);
});

test("read-only secondary contexts and read-only selected items cannot trigger native tag writes", () => {
  for (const type of ["row", "item"]) {
    const { grid, view, items, calls } = fixture();
    if (type === "row") view.collectionTreeRows[1].editable = false;
    else items[0].isEditable = () => false;
    const event = key();
    assert.equal(grid.forwardTagShortcut(event), true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(calls.nativeKeys.length, 0);
  }
});

test("dragging uses a native item row below headers and captures the actual singular drag source", () => {
  const { grid, view, calls, Zotero } = fixture();
  const source = row("native-source");
  view.onDragStart = (event, index) => { assert.equal(index, 1); Zotero.DragDrop.currentDragSource = source; };
  grid.startDrag(dragEvent(calls), 11);
  assert.equal(grid.dragSource.row, source);
  assert.equal(calls.images.length, 1);
  view.collectionTreeRows = [row("different")];
  grid.endDrag();
  assert.equal(calls.dragEnd, 1);
  assert.equal(Zotero.DragDrop.currentDragSource, null);
});

test("native rejection of a non-item drag cancels grid preview and cleans up", () => {
  const { grid, view, calls } = fixture();
  view.onDragStart = event => { event.preventDefault(); return false; };
  const event = dragEvent(calls);
  grid.startDrag(event, 11);
  assert.equal(event.defaultPrevented, true);
  assert.equal(calls.images.length, 0);
  assert.equal(calls.dragEnd, 1);
  assert.equal(grid.dragSource, null);
});

test("changing only the secondary collection during deletion skips stale UI restoration", async () => {
  const { grid, view, calls } = fixture();
  let finish;
  grid.window.ZoteroPane.deleteSelectedItems = () => new Promise(resolve => { finish = resolve; });
  const pending = grid.deleteSelection(false);
  view.collectionTreeRows[1] = row("new-context");
  finish(); await pending;
  assert.equal(calls.refresh, 0);
  assert.equal(grid.deleting, false);
});

test("a fresh plural array with identical row objects does not suppress legitimate delete refresh", async () => {
  const { grid, view, calls } = fixture();
  const rows = view.collectionTreeRows;
  Object.defineProperty(view, "collectionTreeRows", { get: () => [...rows] });
  await grid.deleteSelection(false); await flush();
  assert.equal(calls.refresh, 1);
  assert.equal(grid.deleting, false);
});
