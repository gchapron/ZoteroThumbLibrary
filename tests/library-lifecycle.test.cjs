const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('closing and reopening a Zotero window tolerates its initial false itemsView', () => {
  const scope = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../grid.js'), 'utf8'), scope);
  const controller = Object.create(scope.LibraryIconView.prototype);
  controller.window = { ZoteroPane: { itemsView: false } };
  assert.doesNotThrow(() => controller.bindView());
  assert.equal(controller.view, null);
  let attached = 0, detached = 0;
  const binding = { addListener: () => attached++, removeListener: () => detached++ };
  const readyView = { onRefresh: binding, onSelect: binding, getSortedItems: () => [] };
  controller.window.ZoteroPane.itemsView = readyView;
  controller.bindView();
  assert.equal(controller.view, readyView);
  assert.equal(attached, 2);
  controller.bindView();
  assert.equal(attached, 2, 'does not attach duplicate listeners');
  controller.window.ZoteroPane.itemsView = false;
  controller.bindView();
  assert.equal(detached, 2);
});
