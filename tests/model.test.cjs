const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../model.js');

test('large libraries keep the rendered range bounded and within the collection', () => {
  for (const width of [180, 440, 1400]) {
    for (const scroll of [0, 1500, 300000]) {
      const l = model.layout(100000, width, 172, scroll, 800);
      assert.ok(l.columns >= 1);
      assert.ok(l.start >= 0 && l.end <= 100000);
      assert.ok(l.end - l.start < 80);
    }
  }
  const empty = model.layout(0, 440, 172, 0, 800);
  assert.equal(empty.start, 0);
  assert.equal(empty.end, 0);
});

test('expanded child rows do not duplicate parent cards; standalone attachments stay visible', () => {
  const parent = { id: 1 };
  const attachment = { id: 2, parentItemID: 1 };
  const standalone = { id: 3 };
  const annotation = { id: 4, isAnnotation: () => true };
  assert.deepEqual(model.topLevel([parent, attachment, standalone, annotation]), [parent, standalone]);
  assert.deepEqual(model.topLevel([attachment]), [attachment]);
});

test('multi-selection supports command toggle and forward/reverse shift ranges', () => {
  const ids = [10, 20, 30, 40];
  assert.deepEqual(model.selection(ids, [10], 20, 10, true, false), [10, 20]);
  assert.deepEqual(model.selection(ids, [10, 20], 20, 10, true, false), [10]);
  assert.deepEqual(model.selection(ids, [], 40, 20, false, true), [20, 30, 40]);
  assert.deepEqual(model.selection(ids, [], 10, 30, false, true), [10, 20, 30]);
  assert.deepEqual(model.selection(ids, [10], 20, 99, false, true), [20]);
});
