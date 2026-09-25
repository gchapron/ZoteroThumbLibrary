const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ isMac = true, remove = false, operation } = {}) {
  const calls = { deletion: [], focus: [], errors: [], refresh: 0 };
  const Zotero = { isMac, locked: false, logError: error => calls.errors.push(error) };
  const scope = vm.createContext({ Zotero });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../grid.js"), "utf8"), scope);
  const grid = Object.create(scope.LibraryIconView.prototype);
  let selected = [11, 22], visible = [11, 22, 33];
  const view = {
    onRefresh: {}, onSelect: {}, collectionTreeRow: { editable: true },
    getSortedItems: () => visible, getSelectedItems: () => selected,
  };
  const pane = { itemsView: view, async deleteSelectedItems(force) {
    calls.deletion.push({ force, ids: [...selected], context: this });
    if (operation) await operation();
    if (remove) { selected = [33]; visible = [33]; }
  } };
  grid.window = { ZoteroPane: pane };
  grid.doc = { getElementById: () => null };
  grid.view = view;
  grid.viewport = {};
  grid.doc.activeElement = grid.viewport;
  grid.enabled = true;
  grid.items = visible.map(id => ({ id }));
  grid.cards = new Map(visible.map(id => [id, { focus: options => calls.focus.push({ id, options }) }]));
  grid.focusID = 22;
  grid.anchor = 11;
  grid.refresh = () => { calls.refresh++; grid.items = visible.map(id => ({ id })); };
  return { grid, view, pane, calls, Zotero, clearSelection: () => { selected = []; } };
}

function key(options = {}) {
  return { key: "Backspace", code: "Backspace", target: {},
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; }, ...options };
}

test("Mac laptop Delete delegates the whole native selection without forcing or bypassing confirmation", async () => {
  const { grid, pane, calls } = fixture();
  const event = key();
  grid.keydown(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
  assert.deepEqual(calls.deletion, [{ force: false, ids: [11, 22], context: pane }]);
  await flush();
  // A cancelled native command keeps the existing selection and range anchor.
  assert.equal(grid.focusID, 22);
  assert.equal(grid.anchor, 11);
  assert.equal(grid.deleting, false);
});

test("Delete and its modifiers follow Zotero's platform-specific force rule", async () => {
  for (const [isMac, options, expected] of [
    [true, { metaKey: true }, true], [true, { shiftKey: true }, false],
    [true, { ctrlKey: true, altKey: true }, false], [true, { key: "Delete" }, false],
    [false, { key: "Delete", shiftKey: true }, true], [false, { key: "Delete" }, false],
  ]) {
    const { grid, calls } = fixture({ isMac });
    assert.equal(grid.forwardDeleteShortcut(key(options)), true);
    assert.equal(calls.deletion[0].force, expected);
    await flush();
  }
  const { grid, calls } = fixture({ isMac: false });
  assert.equal(grid.forwardDeleteShortcut(key()), false);
  assert.equal(calls.deletion.length, 0);
});

test("holding Delete or pressing again during deletion cannot delete the next selected item", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { grid, calls } = fixture({ remove: true, operation: () => pending });
  grid.forwardDeleteShortcut(key());
  grid.forwardDeleteShortcut(key());
  grid.forwardDeleteShortcut(key({ repeat: true }));
  assert.equal(calls.deletion.length, 1);
  finish(); await flush();
  grid.forwardDeleteShortcut(key({ repeat: true }));
  assert.equal(calls.deletion.length, 1);
  grid.forwardDeleteShortcut(key());
  assert.equal(calls.deletion.length, 2); // a new physical press is allowed
  await flush();
});

test("text editing, composition, handled events and inactive grids never invoke deletion", () => {
  for (const options of [{ target: { isContentEditable: true } },
    { target: { closest: () => ({}) } }, { isComposing: true },
    { defaultPrevented: true }, { key: "Escape" }]) {
    const { grid, calls } = fixture();
    assert.equal(grid.forwardDeleteShortcut(key(options)), false);
    assert.equal(calls.deletion.length, 0);
  }
  for (const state of ["dead", "disabled"]) {
    const { grid, calls } = fixture();
    if (state === "dead") grid.dead = true; else grid.enabled = false;
    assert.equal(grid.forwardDeleteShortcut(key()), false);
    assert.equal(calls.deletion.length, 0);
  }
});

test("locked Zotero and empty selection consume the key without invoking deletion", () => {
  for (const state of ["locked", "empty"]) {
    const { grid, calls, Zotero, clearSelection } = fixture();
    if (state === "locked") Zotero.locked = true; else clearSelection();
    const event = key();
    assert.equal(grid.forwardDeleteShortcut(event), true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(calls.deletion.length, 0);
  }
});

test("successful deletion resumes navigation and Shift-selection at Zotero's surviving selection", async () => {
  const { grid, calls } = fixture({ remove: true });
  grid.keydown(key()); await flush();
  assert.equal(grid.focusID, 33);
  assert.equal(grid.anchor, 33);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.focus[0].id, 33);
  assert.equal(calls.focus[0].options.preventScroll, true);
});

test("finishing deletion cannot steal focus from an editable field", async () => {
  const { grid, calls } = fixture({ remove: true });
  grid.doc.activeElement = { tagName: "INPUT" };
  grid.forwardDeleteShortcut(key()); await flush();
  assert.equal(calls.focus.length, 0);
});

test("view changes and plugin shutdown while awaiting deletion skip stale UI updates", async () => {
  for (const state of ["row", "view", "disabled", "dead"]) {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const { grid, view, pane, calls } = fixture({ operation: () => pending });
    grid.forwardDeleteShortcut(key());
    if (state === "row") view.collectionTreeRow = {};
    if (state === "view") pane.itemsView = {};
    if (state === "disabled") grid.enabled = false;
    if (state === "dead") grid.dead = true;
    finish(); await flush();
    assert.equal(calls.refresh, 0, state);
    assert.equal(calls.focus.length, 0, state);
    assert.equal(grid.deleting, false, state);
  }
});

test("native deletion errors are reported and release the pending-operation guard", async () => {
  const failure = new Error("native failure");
  const { grid, calls } = fixture({ operation: () => Promise.reject(failure) });
  grid.forwardDeleteShortcut(key()); await flush();
  assert.equal(calls.errors[0], failure);
  assert.equal(grid.deleting, false);
  grid.forwardDeleteShortcut(key()); await flush();
  assert.equal(calls.deletion.length, 2);
});
