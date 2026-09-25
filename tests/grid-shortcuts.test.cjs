const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({ installed = true, handled = true } = {}) {
  const scope = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../grid.js"), "utf8"), scope);
  const controller = Object.create(scope.LibraryIconView.prototype);
  const forwarded = [];
  controller.doc = { getElementById: id => installed && id === "quicklook-menu-item" ? {} : null };
  controller.window = { KeyboardEvent: class {
    constructor(type, options) { this.type = type; Object.assign(this, options); this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  } };
  controller.tree = { dispatchEvent(event) { forwarded.push(event); if (handled) event.preventDefault(); } };
  controller.items = [{ id: 2 }, { id: 3 }];
  controller.view = { getSelectedItems: () => [2, 3], selectItems: () => assert.fail("Preview must preserve selection") };
  controller.select = () => assert.fail("Preview must not select again");
  controller.open = () => assert.fail("Preview must not open the normal reader");
  return { controller, forwarded };
}

function key(key = " ", options = {}) {
  return { key, code: key === " " ? "Space" : key, ctrlKey: false, altKey: false,
    metaKey: false, shiftKey: false, repeat: false, defaultPrevented: false,
    stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; }, ...options };
}

test("Space reaches the installed QuickLook tree listener without changing multiple selection", () => {
  const { controller, forwarded } = fixture();
  const event = key();
  controller.keydown(event);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].key, " ");
  assert.equal(forwarded[0].code, "Space");
  assert.equal(forwarded[0].bubbles, true);
  assert.equal(forwarded[0].cancelable, true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
});

test("releasing and pressing Space forwards again, while holding Space does not repeatedly toggle", () => {
  const { controller, forwarded } = fixture();
  controller.keydown(key());
  const repeat = key(" ", { repeat: true });
  controller.keydown(repeat);
  controller.keydown(key());
  assert.equal(forwarded.length, 2);
  assert.equal(repeat.defaultPrevented, true);
});

test("QuickLook's Escape, Command-Y, note and contact-sheet shortcuts retain their modifiers", () => {
  const { controller, forwarded } = fixture();
  for (const event of [key("Escape"), key("y", { metaKey: true }), key(" ", { shiftKey: true }), key(" ", { altKey: true })]) {
    assert.equal(controller.forwardPreviewShortcut(event), true);
  }
  assert.equal(forwarded[1].metaKey, true);
  assert.equal(forwarded[2].shiftKey, true);
  assert.equal(forwarded[3].altKey, true);
});

test("unrelated keys, reserved modifiers and an absent QuickLook extension are not forwarded", () => {
  const { controller, forwarded } = fixture();
  for (const event of [key("ArrowDown"), key(" ", { metaKey: true }), key(" ", { ctrlKey: true })]) {
    assert.equal(controller.forwardPreviewShortcut(event), false);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(forwarded.length, 0);
  const absent = fixture({ installed: false });
  assert.equal(absent.controller.forwardPreviewShortcut(key()), false);
  assert.equal(absent.forwarded.length, 0);
});

test("an unhandled forwarded Escape does not suppress other keyboard handlers", () => {
  const { controller } = fixture({ handled: false });
  const event = key("Escape");
  assert.equal(controller.forwardPreviewShortcut(event), false);
  assert.equal(event.defaultPrevented, false);
});
