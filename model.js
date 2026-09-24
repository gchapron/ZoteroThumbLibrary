/* Pure layout/selection helpers, shared with the dependency-free tests. */
var LibraryGridModel = {
  topLevel(items) {
    let ids = new Set(items.map(item => item.id));
    return items.filter(item => item.id && !item.isAnnotation?.()
      && (!item.parentItemID || !ids.has(item.parentItemID)));
  },
  layout(count, width, size, scrollTop, height) {
    let gap = 16, padding = 20;
    let columns = Math.max(1, Math.floor((width - padding * 2 + gap) / (size + gap)));
    // Grow cards continuously with the slider instead of stretching each row to
    // fill its width, which kept card widths fixed then jumped at column changes.
    let cellWidth = Math.max(100, Math.min(size, width - padding * 2));
    let left = Math.max(padding, (width - columns * cellWidth - (columns - 1) * gap) / 2);
    let rowHeight = size + 100;
    let rows = Math.ceil(count / columns);
    let first = Math.max(0, Math.floor(scrollTop / rowHeight) - 2);
    let last = Math.min(rows, Math.ceil((scrollTop + height) / rowHeight) + 2);
    return { columns, cellWidth, rowHeight, gap, padding, left,
      start: Math.min(count, first * columns), end: Math.min(count, last * columns),
      height: rows * rowHeight + padding * 2 };
  },
  captureAnchor(layout, scrollTop, count) {
    if (!layout || !count) return null;
    let row = Math.max(0, Math.floor((scrollTop - layout.padding) / layout.rowHeight));
    // If the viewport starts in a row's bottom gap, that row's cards are already
    // entirely offscreen. Anchor the next row, whose first card is actually visible.
    let withinRow = scrollTop - layout.padding - row * layout.rowHeight;
    if (withinRow >= layout.rowHeight - layout.gap) row++;
    let index = Math.min(count - 1, row * layout.columns);
    let top = layout.padding + Math.floor(index / layout.columns) * layout.rowHeight;
    return { index, offset: top - scrollTop };
  },
  restoreAnchor(anchor, layout, viewportHeight) {
    if (!anchor) return 0;
    let top = layout.padding + Math.floor(anchor.index / layout.columns) * layout.rowHeight;
    return Math.max(0, Math.min(top - anchor.offset, Math.max(0, layout.height - viewportHeight)));
  },
  selection(ids, selected, target, anchor, toggle, range) {
    let result = new Set(toggle ? selected : []);
    if (range && ids.includes(anchor)) {
      let a = ids.indexOf(anchor), b = ids.indexOf(target);
      for (let id of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) result.add(id);
    }
    else if (toggle && result.has(target)) result.delete(target);
    else result.add(target);
    return [...result];
  }
};
if (typeof module !== "undefined") module.exports = LibraryGridModel;
