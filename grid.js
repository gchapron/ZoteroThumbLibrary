var LibraryIconView = class {
  constructor(window, rootURI, version = "0") {
    this.window = window;
    this.doc = window.document;
    this.rootURI = rootURI;
    this.version = version;
    this.items = [];
    this.cards = new Map();
    this.detachedCards = new Map();
    this.previewEpoch = 0;
    this.renderFrame = null;
    this.pendingAnchor = null;
    this.disposers = [];
    this.enabled = Zotero.Prefs.get("libraryIconView.enabled") !== false;
    this.size = Math.max(120, Math.min(260, Zotero.Prefs.get("libraryIconView.size") || 172));
    this.engine = new LibraryThumbnails({ Zotero, window, rootURI });
  }

  el(tag, attrs = {}, text) {
    let el = this.doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (let [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  listen(el, event, listener, options) {
    el.addEventListener(event, listener, options);
    this.disposers.push(() => el.removeEventListener(event, listener, options));
  }

  async init() {
    this.pane = this.doc.getElementById("zotero-items-pane");
    this.tree = this.doc.getElementById("zotero-items-tree");
    let toolbar = this.doc.getElementById("zotero-items-toolbar");
    if (!this.pane || !this.tree || !toolbar) throw new Error("Library Icon View: library pane unavailable");
    this.originalPosition = this.pane.style.position;
    this.originalVisibility = this.tree.style.visibility;
    this.originalAria = this.tree.getAttribute("aria-hidden");
    this.pane.style.position = "relative";
    // Gecko retains stylesheet contents across add-on hot upgrades at the same
    // XPI URL. A release-specific URL makes the new toolbar geometry immediate.
    this.style = this.el("link", { rel: "stylesheet", href: this.rootURI + "grid.css?v=" + encodeURIComponent(this.version) });
    this.doc.documentElement.append(this.style);
    this.button = this.el("button", { id: "ziv-toggle", type: "button", "aria-controls": "ziv-root" });
    toolbar.insertBefore(this.button, toolbar.querySelector("spacer"));
    this.listen(this.button, "click", () => this.toggle());
    this.root = this.el("section", { id: "ziv-root", "aria-label": "Library icon view" });
    let header = this.el("div", { class: "ziv-header" });
    this.count = this.el("span", { id: "ziv-count", "aria-live": "polite" });
    let label = this.el("label", {}, "Size");
    let slider = this.el("input", { type: "range", min: 120, max: 260, value: this.size, "aria-label": "Thumbnail size" });
    label.append(slider);
    header.append(this.count, label);
    this.listen(slider, "input", () => this.setSize(Number(slider.value)));
    this.listen(slider, "change", () => this.persistSize());
    this.viewport = this.el("div", { id: "ziv-viewport", tabindex: "0", role: "listbox", "aria-label": "Library items", "aria-multiselectable": "true" });
    this.canvas = this.el("div", { id: "ziv-cards" });
    this.viewport.append(this.canvas);
    this.root.append(header, this.viewport, this.el("div", { class: "ziv-help" }, "Double-click to open · Space for Quick Look · ⌘-click to select several"));
    this.pane.append(this.root);
    this.listen(this.viewport, "scroll", () => this.scheduleRender(), { passive: true });
    this.listen(this.viewport, "keydown", event => this.keydown(event));
    this.resize = new this.window.ResizeObserver(() => this.scheduleRender({ preserveAnchor: true, animate: true }));
    this.resize.observe(this.viewport);
    this.onRefresh = () => this.scheduleRefresh();
    this.onSelect = () => this.syncSelection();
    this.bindView();
    this.observerID = Zotero.Notifier.registerObserver({ notify: (event, type, ids) => {
      if (type === "item") {
        // Metadata and last-read changes do not change a PDF's first page.
        // File changes are detected by the renderer's source fingerprint.
        if (event === "delete") for (let id of ids || []) this.engine.invalidate(id);
        if (ids?.length && ids.every(id => Zotero.Items.get(id)?.isAnnotation?.())) return;
      }
      this.scheduleRefresh(true);
    } }, ["item", "collection-item", "collection", "search", "itemtree"], "libraryIconView", 100);
    // Refresh listeners cover filters; a lightweight fallback covers sort/expand and view replacement.
    this.interval = this.window.setInterval(() => {
      if (this.enabled && this.root.getClientRects().length) this.pollView();
    }, 1200);
    this.applyMode();
    this.refresh();
  }

  bindView() {
    let candidate = this.window.ZoteroPane?.itemsView;
    let view = candidate?.onRefresh && candidate?.onSelect && typeof candidate.getSortedItems === "function"
      ? candidate : null;
    if (view === this.view) return;
    this.view?.onRefresh?.removeListener(this.onRefresh);
    this.view?.onSelect?.removeListener(this.onSelect);
    this.view = view;
    view?.onRefresh?.addListener(this.onRefresh);
    view?.onSelect?.addListener(this.onSelect);
  }

  pollView() {
    this.bindView();
    if (!this.view) return;
    let state = [this.view, this.view._rows, this.view._rowMap,
      this.view.rowCount, this.view.collectionTreeRow?.id];
    if (this.pollState && state.every((value, index) => value === this.pollState[index])) return;
    this.pollState = state;
    this.refresh();
  }

  scheduleRefresh(force = false) {
    if (this.dead) return;
    this.forceRefresh ||= force;
    this.window.clearTimeout(this.refreshTimer);
    this.refreshTimer = this.window.setTimeout(() => {
      this.refresh(this.forceRefresh);
      this.forceRefresh = false;
    }, 100);
  }

  captureAnchor() {
    let anchor = LibraryGridModel.captureAnchor(this.layout, this.viewport.scrollTop, this.items.length);
    if (anchor) anchor.id = this.items[anchor.index]?.id;
    return anchor;
  }

  scheduleRender({ preserveAnchor = false, animate = false } = {}) {
    if (this.dead || !this.enabled) return;
    if (preserveAnchor && !this.pendingAnchor) this.pendingAnchor = this.captureAnchor();
    this.animateNextRender ||= animate;
    if (this.renderFrame !== null) return;
    this.renderFrame = this.window.requestAnimationFrame(() => {
      this.renderFrame = null;
      this.render();
    });
  }

  setSize(value) {
    let size = Math.max(120, Math.min(260, Number(value) || 172));
    if (size === this.size) return;
    if (!this.pendingAnchor) this.pendingAnchor = this.captureAnchor();
    this.size = size;
    this.sizeDirty = true;
    this.window.clearTimeout(this.sizeTimer);
    this.sizeTimer = this.window.setTimeout(() => this.persistSize(), 150);
    this.scheduleRender({ animate: true });
  }

  persistSize() {
    this.window.clearTimeout(this.sizeTimer);
    if (!this.sizeDirty) return;
    this.sizeDirty = false;
    Zotero.Prefs.set("libraryIconView.size", this.size);
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      this.engine.clearQueue();
      if (this.renderFrame !== null) this.window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
      this.pendingAnchor = null;
    }
    Zotero.Prefs.set("libraryIconView.enabled", this.enabled);
    this.applyMode();
    if (this.enabled) this.refresh(true);
  }

  applyMode() {
    this.root.hidden = !this.enabled;
    this.tree.style.visibility = this.enabled ? "hidden" : this.originalVisibility;
    if (this.enabled) this.tree.setAttribute("aria-hidden", "true");
    else if (this.originalAria === null) this.tree.removeAttribute("aria-hidden");
    else this.tree.setAttribute("aria-hidden", this.originalAria);
    this.button.setAttribute("aria-pressed", String(this.enabled));
    let label = this.enabled ? "Switch to list view" : "Switch to icon view";
    this.button.setAttribute("aria-label", label);
    this.button.title = label;
    let svg = this.doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (let [name, value] of Object.entries({ viewBox: "0 0 20 20", width: 18, height: 18,
      "aria-hidden": "true", focusable: "false", fill: "none", stroke: "currentColor",
      "stroke-width": 1.4, "stroke-linecap": "round", "stroke-linejoin": "round" })) svg.setAttribute(name, value);
    if (this.enabled) {
      let path = this.doc.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M3 5h1M7 5h10M3 10h1M7 10h10M3 15h1M7 15h10");
      svg.append(path);
    }
    else {
      for (let [x, y] of [[3, 3], [11, 3], [3, 11], [11, 11]]) {
        let rect = this.doc.createElementNS("http://www.w3.org/2000/svg", "rect");
        for (let [name, value] of Object.entries({ x, y, width: 6, height: 6, rx: 1 })) rect.setAttribute(name, value);
        svg.append(rect);
      }
    }
    this.button.replaceChildren(svg);
  }

  refresh(force = false) {
    if (this.dead || !this.enabled) return;
    this.bindView();
    if (!this.view) return;
    let collection = this.view.collectionTreeRow?.id;
    this.pollState = [this.view, this.view._rows, this.view._rowMap, this.view.rowCount, collection];
    let items = LibraryGridModel.topLevel(this.view.getSortedItems().filter(item => item instanceof Zotero.Item));
    let key = collection + ":" + items.map(item => item.id).join(",");
    if (force || key !== this.key) {
      if (key !== this.key) this.engine.clearQueue();
      this.previewEpoch++;
      if (collection !== this.collection) {
        this.viewport.scrollTop = 0;
        this.pendingAnchor = null;
      }
      else if (!this.pendingAnchor) this.pendingAnchor = this.captureAnchor();
      this.collection = collection;
      this.key = key;
      this.items = items;
      // Retain keyed cards and their decoded images across item notifications.
      // Metadata and previews refresh in place rather than flashing placeholders.
      this.renderSignature = null;
      this.count.textContent = `${items.length} ${items.length === 1 ? "item" : "items"}`;
      this.render();
    }
    this.syncSelection();
  }

  render() {
    if (this.dead || !this.enabled || !this.viewport) return;
    if (this.renderFrame !== null) this.window.cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    let width = this.viewport.clientWidth, height = this.viewport.clientHeight;
    // A background Zotero tab can temporarily report zero dimensions. Keep its
    // anchor and cards until the visible viewport has real geometry again.
    if (!width || !height) return;
    let scrollTop = this.viewport.scrollTop;
    let layout = LibraryGridModel.layout(this.items.length, width, this.size, scrollTop, height);
    let animate = this.animateNextRender && !this.window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.animateNextRender = false;
    let before = animate ? new Map([...this.cards].map(([id, card]) => [id, card.getBoundingClientRect()])) : null;
    if (this.pendingAnchor) {
      let index = this.items.findIndex(item => item.id === this.pendingAnchor.id);
      if (index >= 0) this.pendingAnchor.index = index;
      this.pendingAnchor.index = Math.min(this.pendingAnchor.index, Math.max(0, this.items.length - 1));
      scrollTop = LibraryGridModel.restoreAnchor(this.pendingAnchor, layout, height);
      this.pendingAnchor = null;
    }
    if (this.canvas.style.height !== `${layout.height}px`) this.canvas.style.height = `${layout.height}px`;
    if (Math.abs(this.viewport.scrollTop - scrollTop) > 0.5) this.viewport.scrollTop = scrollTop;
    layout = this.layout = LibraryGridModel.layout(this.items.length, width, this.size, scrollTop, height);
    let signature = [layout.start, layout.end, layout.columns, layout.cellWidth,
      layout.rowHeight, layout.left, this.items.length, this.previewEpoch].join(":");
    if (signature === this.renderSignature) return;
    this.renderSignature = signature;
    if (!this.items.length) {
      this.engine.setVisibleItems([]);
      for (let card of this.cards.values()) this.retireCard(card);
      this.cards.clear();
      if (!this.empty) {
        this.empty = this.el("div", { class: "ziv-empty" }, "No items in this view.");
        this.canvas.append(this.empty);
      }
      return;
    }
    this.empty?.remove(); this.empty = null;
    let wanted = new Set(this.items.slice(layout.start, layout.end).map(item => item.id));
    this.engine.setVisibleItems(wanted);
    for (let [id, card] of this.cards) {
      if (!wanted.has(id)) { this.retireCard(card); this.cards.delete(id); }
    }
    let previewRequests = [];
    for (let i = layout.start; i < layout.end; i++) {
      let item = this.items[i];
      let card = this.cards.get(item.id);
      if (!card) {
        card = this.detachedCards.get(item.id) || this.createCard(item);
        this.detachedCards.delete(item.id);
        this.cards.set(item.id, card);
        this.canvas.append(card);
      }
      if (card._previewEpoch !== this.previewEpoch) this.updateCard(card, item);
      if (!card._previewReady && !card._previewPending) previewRequests.push({ card, item, index: i });
      let x = layout.left + (i % layout.columns) * (layout.cellWidth + layout.gap);
      let y = layout.padding + Math.floor(i / layout.columns) * layout.rowHeight;
      let geometry = `${x}:${y}:${layout.cellWidth}:${layout.rowHeight}`;
      if (card._geometry !== geometry) {
        card._motion?.cancel(); card._motion = null;
        card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        card.style.width = `${layout.cellWidth}px`;
        card.style.height = `${layout.rowHeight - layout.gap}px`;
        card._geometry = geometry;
      }
      card.setAttribute("aria-posinset", i + 1);
      card.setAttribute("aria-setsize", this.items.length);
    }
    // Queue the pages the user can see before the two overscan rows above/below.
    let previewPriority = request => {
      let top = layout.padding + Math.floor(request.index / layout.columns) * layout.rowHeight;
      if (top + layout.rowHeight > scrollTop && top < scrollTop + height) return 0;
      return Math.min(Math.abs(top + layout.rowHeight - scrollTop), Math.abs(top - scrollTop - height)) + 1;
    };
    previewRequests.sort((a, b) => previewPriority(a) - previewPriority(b));
    for (let { card, item } of previewRequests) this.loadThumbnail(card, item);
    if (before) {
      // FLIP: measure in two batches and animate only transforms. No repeated
      // layout/paint of every thumbnail during the transition's animation frames.
      let transitions = [];
      for (let [id, card] of this.cards) {
        let old = before.get(id);
        if (!old) continue;
        let next = card.getBoundingClientRect();
        if (!old.width || !next.width || !old.height || !next.height) continue;
        if (Math.abs(old.x - next.x) + Math.abs(old.y - next.y)
          + Math.abs(old.width - next.width) + Math.abs(old.height - next.height) < 0.5) continue;
        transitions.push({ card, old, next });
      }
      for (let { card, old, next } of transitions) {
        let position = card.style.transform;
        card._motion = card.animate([
          { transform: `${position} translate(${old.x - next.x}px, ${old.y - next.y}px) scale(${old.width / next.width}, ${old.height / next.height})` },
          { transform: position }
        ], { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" });
      }
    }
    this.syncSelection();
  }

  retireCard(card) {
    if (card.contains(this.doc.activeElement)) this.viewport.focus({ preventScroll: true });
    card._motion?.cancel(); card._motion = null;
    card._previewToken = (card._previewToken || 0) + 1;
    card._previewPending = false;
    card.remove();
    this.detachedCards.delete(card._itemID);
    this.detachedCards.set(card._itemID, card);
    // Reuse recently decoded thumbnails when reversing scroll direction.
    while (this.detachedCards.size > 48) this.detachedCards.delete(this.detachedCards.keys().next().value);
  }

  createCard(item) {
    let title = item.getDisplayTitle?.() || item.getField?.("title") || "Untitled";
    let card = this.el("div", { class: "ziv-card", role: "option", tabindex: "-1", draggable: "true", "data-item-id": item.id, "aria-label": title, title });
    // FLIP coordinates require this origin even if Gecko retains an older stylesheet after a hot update.
    card.style.transformOrigin = "top left";
    let preview = this.el("div", { class: "ziv-preview", "aria-hidden": "true" });
    let placeholder = this.el("span", { class: "ziv-placeholder" });
    placeholder.append(this.el("span", {}, "▤"), this.el("small", {}, "Loading preview…"));
    preview.append(placeholder);
    let creator = item.getField?.("firstCreator") || "";
    let year = (item.getField?.("date") || "").match(/\d{4}/)?.[0] || "";
    card.append(preview, this.el("span", { class: "ziv-title" }, title), this.el("span", { class: "ziv-meta" }, [creator, year].filter(Boolean).join(" · ")));
    card.addEventListener("click", event => this.select(item.id, event));
    card.addEventListener("dblclick", event => this.open(item, event));
    card.addEventListener("dragstart", event => this.startDrag(event, item.id));
    card.addEventListener("dragend", () => this.endDrag());
    card.addEventListener("contextmenu", async event => {
      event.preventDefault();
      if (!this.view.getSelectedItems(true).includes(item.id)) await this.select(item.id, {});
      this.window.ZoteroPane.onItemsContextMenuOpen(event);
    });
    card._itemID = item.id;
    card._preview = preview;
    card._placeholder = placeholder;
    return card;
  }

  updateCard(card, item) {
    let title = item.getDisplayTitle?.() || item.getField?.("title") || "Untitled";
    card.setAttribute("aria-label", title);
    card.title = title;
    card.querySelector(".ziv-title").textContent = title;
    let creator = item.getField?.("firstCreator") || "";
    let year = (item.getField?.("date") || "").match(/\d{4}/)?.[0] || "";
    card.querySelector(".ziv-meta").textContent = [creator, year].filter(Boolean).join(" · ");
    card._previewEpoch = this.previewEpoch;
    card._previewReady = false;
    card._previewPending = false;
    card._previewToken = (card._previewToken || 0) + 1;
  }

  loadThumbnail(card, item) {
    let token = card._previewToken = (card._previewToken || 0) + 1;
    card._previewPending = true;
    this.engine.get(item, { visibleOnly: true }).then(async result => {
      if (this.dead || token !== card._previewToken || !card.isConnected) return;
      if (result?.src) {
        let oldImage = card._preview.querySelector("img");
        if (oldImage?.getAttribute("src") !== result.src) {
          let img = this.el("img", { src: result.src, alt: "", draggable: "false", decoding: "async", width: result.width, height: result.height });
          try { await img.decode(); } catch (_) {}
          if (this.dead || token !== card._previewToken || !card.isConnected) return;
          card._preview.replaceChildren(img);
        }
      }
      else {
        card._placeholder.lastChild.textContent = "No local preview";
        card._preview.replaceChildren(card._placeholder);
      }
      card._previewReady = true;
    }).catch(error => {
      if (this.dead || token !== card._previewToken) return;
      card._placeholder.lastChild.textContent = "Preview unavailable";
      card._preview.replaceChildren(card._placeholder);
      card._previewReady = true;
      Zotero.debug(`Library Icon View preview: ${error.message}`);
    }).finally(() => {
      if (token === card._previewToken) card._previewPending = false;
    });
  }

  async select(id, event) {
    let ids = this.items.map(item => item.id);
    let selected = LibraryGridModel.selection(ids, this.view.getSelectedItems(true), id, this.anchor,
      event.metaKey || event.ctrlKey, event.shiftKey);
    if (!event.shiftKey) this.anchor = id;
    this.focusID = id;
    if (selected.length) await this.view.selectItems(selected, true, true);
    else this.view.selection.clearSelection();
    if (this.dead) return;
    this.syncSelection();
    this.cards.get(id)?.focus({ preventScroll: true });
  }

  syncSelection() {
    if (this.dead || !this.view) return;
    let selected = new Set(this.view.getSelectedItems(true));
    for (let [id, card] of this.cards) {
      let value = String(selected.has(id));
      if (card.getAttribute("aria-selected") !== value) card.setAttribute("aria-selected", value);
    }
  }

  startDrag(event, id) {
    this.bindView();
    let view = this.view;
    let index = view?.getRowIndexByID?.(id);
    // A missing native row is reported as false, which must not become row 0.
    if (this.dead || !this.enabled || Zotero.locked || !event.dataTransfer
      || !Number.isInteger(index) || index < 0 || typeof view.onDragStart !== "function") {
      event.preventDefault();
      return;
    }
    this.endDrag();
    this.dragSource = { view, row: view.collectionTreeRow };
    try {
      let wasSelected = view.getSelectedItems(true).includes(id);
      // DataTransfer is writable only during this synchronous event. Zotero
      // selects an unselected source row and preserves an existing multiselection.
      // It also supplies the item IDs, file flavors and collection drag context
      // required by the tag selector and other native drop targets.
      view.onDragStart(event, index);
      if (!wasSelected) this.anchor = id;
      this.focusID = id;
      this.syncSelection();
      let card = this.cards.get(id);
      if (card) {
        let rect = card.getBoundingClientRect();
        event.dataTransfer.setDragImage(card,
          Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
          Math.max(0, Math.min(rect.height, event.clientY - rect.top)));
      }
      event.stopPropagation();
    }
    catch (error) {
      event.preventDefault();
      this.endDrag();
      Zotero.logError(error);
    }
  }

  endDrag() {
    let source = this.dragSource;
    if (!source) return;
    this.dragSource = null;
    try { source.view.onDragEnd(); }
    catch (error) { Zotero.logError(error); }
    finally {
      if (Zotero.DragDrop.currentDragSource === source.row) Zotero.DragDrop.currentDragSource = null;
    }
  }

  async open(item, event) {
    try { await this.window.ZoteroPane.viewItems([item], event); }
    catch (error) { Zotero.logError(error); }
  }

  forwardPreviewShortcut(event) {
    // Zotero7QuickLook owns its native-tree listener and open/close state.
    // Send it the same shortcut without moving focus or changing selection.
    let space = (event.code === "Space" || event.key === " ") && !event.ctrlKey && !event.metaKey;
    let commandY = event.key.toLowerCase() === "y" && event.metaKey && !event.ctrlKey && !event.altKey;
    if ((!space && !commandY && event.key !== "Escape") || !this.tree
      || !this.doc.getElementById("quicklook-menu-item")) return false;
    if (event.repeat && event.key !== "Escape") {
      event.preventDefault(); event.stopPropagation();
      return true;
    }
    let forwarded = new this.window.KeyboardEvent("keydown", {
      key: event.key, code: space ? "Space" : event.code, bubbles: true, cancelable: true,
      altKey: event.altKey, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey, repeat: false
    });
    this.tree.dispatchEvent(forwarded);
    if (!forwarded.defaultPrevented) return false;
    event.preventDefault(); event.stopPropagation();
    return true;
  }

  forwardTagShortcut(event) {
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing
      || !/^(?:Digit|Numpad)[0-9]$/.test(event.code)) return false;
    this.bindView();
    if (!this.view || typeof this.view.handleKeyDown !== "function") return false;
    // Use physical key codes, as Zotero does, including on non-US keyboards.
    // The native handler owns colored-tag positions, mixed selections, toggling,
    // and 0 (remove colored tags). Keep read-only libraries unchanged.
    if (this.view.collectionTreeRow?.editable === false || this.view.handleKeyDown(event) === false) {
      event.preventDefault(); event.stopPropagation();
      return true;
    }
    return false;
  }

  forwardDeleteShortcut(event) {
    if (!["Backspace", "Delete"].includes(event.key) || event.defaultPrevented || event.isComposing
      || this.dead || !this.enabled || event.target?.isContentEditable
      || event.target?.closest?.("input, textarea, select, textbox")) return false;
    // Zotero's pane keypress handler accepts Backspace on macOS and forward
    // Delete on every platform. Grid cards are outside its native tree target.
    if (event.key === "Backspace" && !Zotero.isMac) return false;
    this.bindView();
    if (!this.view || typeof this.window.ZoteroPane?.deleteSelectedItems !== "function") return false;
    event.preventDefault(); event.stopPropagation();
    // A held key or an in-flight deletion must not act on the next selection.
    if (event.repeat || this.deleting || Zotero.locked || !this.view.getSelectedItems(true).length) return true;
    let force = !!(event.metaKey || (!Zotero.isMac && event.shiftKey));
    this.deleteSelection(force);
    return true;
  }

  async deleteSelection(force) {
    this.deleting = true;
    let view = this.view;
    let row = view.collectionTreeRow;
    try {
      // Keep native permissions, confirmation dialogs, cancellation, collection
      // removal, Trash, and permanent deletion in Zotero's own command.
      await this.window.ZoteroPane.deleteSelectedItems(force);
      if (this.dead || !this.enabled || this.view !== view
        || this.window.ZoteroPane.itemsView !== view || view.collectionTreeRow !== row) return;
      this.refresh();
      if (!this.items.some(item => item.id === this.focusID)) {
        let visible = new Set(this.items.map(item => item.id));
        this.focusID = view.getSelectedItems(true).find(id => visible.has(id));
        this.anchor = this.focusID;
      }
      // Retiring a focused card moves focus to the viewport. Resume keyboard
      // navigation at Zotero's surviving selection without stealing field focus.
      if (this.doc.activeElement === this.viewport) this.cards.get(this.focusID)?.focus({ preventScroll: true });
    }
    catch (error) { Zotero.logError(error); }
    finally { this.deleting = false; }
  }

  keydown(event) {
    if (this.forwardDeleteShortcut(event)) return;
    if (this.forwardPreviewShortcut(event)) return;
    if (this.forwardTagShortcut(event)) return;
    let ids = this.items.map(item => item.id);
    if (!ids.length) return;
    let index = ids.indexOf(this.focusID || this.view.getSelectedItems(true)[0]);
    let current = Math.max(0, index);
    let next = current;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault(); event.stopPropagation();
      this.view.selectItems(ids, true, true); return;
    }
    switch (event.key) {
      case "ArrowRight": next = index < 0 ? 0 : next + 1; break;
      case "ArrowLeft": next--; break;
      case "ArrowDown": next = index < 0 ? 0 : next + this.layout.columns; break;
      case "ArrowUp": next -= this.layout.columns; break;
      case "Home": next = 0; break;
      case "End": next = ids.length - 1; break;
      case "Enter":
        this.open(this.items[current], event); break;
      case " ": this.select(ids[current], event); break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation();
    if (["Enter", " "].includes(event.key)) return;
    next = Math.max(0, Math.min(ids.length - 1, next));
    let top = this.layout.padding + Math.floor(next / this.layout.columns) * this.layout.rowHeight;
    if (top < this.viewport.scrollTop) this.viewport.scrollTop = top;
    else if (top + this.layout.rowHeight > this.viewport.scrollTop + this.viewport.clientHeight)
      this.viewport.scrollTop = top + this.layout.rowHeight - this.viewport.clientHeight;
    this.render();
    this.select(ids[next], event);
  }

  destroy() {
    if (this.dead) return;
    this.endDrag();
    this.dead = true;
    this.persistSize();
    if (this.renderFrame !== null) this.window.cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    this.window.clearInterval(this.interval);
    this.window.clearTimeout(this.refreshTimer);
    this.resize?.disconnect();
    this.view?.onRefresh?.removeListener(this.onRefresh);
    this.view?.onSelect?.removeListener(this.onSelect);
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    for (let dispose of this.disposers) dispose();
    this.engine.destroy();
    this.root?.remove(); this.style?.remove(); this.button?.remove();
    if (this.tree) {
      this.tree.style.visibility = this.originalVisibility;
      if (this.originalAria === null) this.tree.removeAttribute("aria-hidden");
      else this.tree.setAttribute("aria-hidden", this.originalAria);
    }
    if (this.pane) this.pane.style.position = this.originalPosition;
    for (let card of [...this.cards.values(), ...this.detachedCards.values()]) card._motion?.cancel();
    this.cards.clear();
    this.detachedCards.clear();
  }
};
