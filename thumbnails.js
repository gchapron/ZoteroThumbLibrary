/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Loaded into the bootstrap scope with Services.scriptloader.loadSubScript(). */

var LibraryThumbnails = class LibraryThumbnails {
  /**
   * The bootstrap registers chrome://library-icon-view/content/ at the add-on root.
   * get(item) accepts an attachment or regular item and resolves to
   * {src, width, height, attachmentID}, or null for an unavailable preview.
   * No attachment, annotation, database, or file is modified by this renderer.
   */
  constructor({ Zotero, window, rendererURL, maxEntries = 160, maxCacheBytes = 12 * 1024 * 1024,
    diskCache = true, maxDiskEntries = 2000, maxDiskBytes = Infinity, maxConcurrentRenders = 3 }) {
    this.Zotero = Zotero;
    this.window = window;
    this.rendererURL = rendererURL || "chrome://library-icon-view/content/thumbnail-renderer.html";
    this.maxEntries = maxEntries;
    this.maxCacheBytes = maxCacheBytes;
    this._cache = new Map();
    this._cacheBytes = 0;
    this._pending = new Map();
    // Only compact file references survive memory-cache eviction. Never retain
    // the full image strings or decoded cards for every item in a large library.
    this._ready = new Map();
    this._diskQueue = [];
    this._diskRunning = 0;
    this._queue = [];
    this._visibleItems = new Set();
    this._priorityItems = new Set();
    this._destroyed = false;
    this._generation = 0;
    this.maxConcurrentRenders = Number.isFinite(maxConcurrentRenders)
      ? Math.max(1, Math.min(8, Math.floor(maxConcurrentRenders))) : 3;
    // Each lane owns a document and PDF worker. A renderer document has mutable
    // PDF.js state and must never be used by two jobs at once.
    this._renderers = Array.from({ length: this.maxConcurrentRenders }, () => ({
      browser: null, promise: null, abortActive: null, cancelLoad: null, job: null
    }));
    this._epubCover = typeof LibraryEPUBCover === "undefined" ? null
      : new LibraryEPUBCover({ Zotero, window });
    this._diskDirectory = diskCache && Zotero.Profile?.dir && Zotero.Utilities?.Internal?.md5
      ? Zotero.Profile.dir + "/cache/zoteroThumbLibrary/v1" : null;
    this.maxDiskEntries = maxDiskEntries;
    this.maxDiskBytes = maxDiskBytes;
    this._diskReady = null;
    this._diskDisabled = false;
    this._diskWrites = 0;
    this._diskWriteSequence = 0;
    this._diskNonce = Date.now().toString(36) + Math.random().toString(36).slice(2);
    this._maxPNGBytes = 2 * 1024 * 1024;
  }

  /** A display hint for scroll-back; get() still validates the source file. */
  peek(item) {
    if (this._destroyed || !item) return undefined;
    const ready = this._ready.get(item.id);
    return ready?.diskResult || this._cache.get(ready?.key)?.result;
  }

  async get(item, { visibleOnly = false } = {}) {
    if (this._destroyed || !item) return null;
    const generation = this._generation;
    // A parent library card and the attachment it previews have different IDs.
    const requestedItemID = item.id;
    const eligible = () => this._eligible(generation, requestedItemID, visibleOnly);
    if (!eligible()) return null;
    try {
      if (!item.isAttachment?.()) {
        if (!item.isRegularItem?.()) return null;
        item = await item.getBestAttachment();
      }
      if (!item || !eligible()) {
        if (eligible()) this._ready.delete(requestedItemID);
        return null;
      }
      const mime = item.attachmentContentType || "";
      if (mime !== "application/pdf" && mime !== "application/epub+zip" && !mime.startsWith("image/")) {
        this._ready.delete(requestedItemID);
        return null;
      }
      const path = await item.getFilePathAsync();
      if (!path || !eligible()) {
        if (eligible()) this._ready.delete(requestedItemID);
        return null;
      }
      const stat = await IOUtils.stat(path);
      if (!eligible()) return null;
      // Avoid reading arbitrarily large attachments into memory just for a preview.
      if (!stat.size || stat.size > 256 * 1024 * 1024) {
        this._ready.delete(requestedItemID);
        return null;
      }
      const key = `${item.id}|${path}|${stat.size}|${stat.lastModified}`;
      const ready = this._ready.get(requestedItemID);
      if (ready && ready.key !== key) this._ready.delete(requestedItemID);
      const diskResult = ready?.key === key ? ready.diskResult : this._cache.get(key)?.result;
      if (diskResult?.src.startsWith("file:")) {
        // A user or disk-cleanup utility may have removed the PNG. Recover it
        // without making every scroll-back read/checksum/base64-encode the file.
        let diskStat;
        try { diskStat = await IOUtils.stat(this._diskPath(key)); } catch (_) {}
        if (!eligible()) return null;
        if (diskStat?.size === diskResult.cacheSize && diskStat?.lastModified === diskResult.cacheModified) {
          if ((Number.isFinite(this.maxDiskEntries) || Number.isFinite(this.maxDiskBytes))
            && Date.now() - diskStat.lastModified > 3600000) {
            try {
              await IOUtils.setModificationTime(this._diskPath(key));
              diskResult.cacheModified = (await IOUtils.stat(this._diskPath(key))).lastModified;
            } catch (_) {}
            if (!eligible()) return null;
          }
          this._rememberReady({ key, requestedItemID, attachmentID: item.id }, diskResult);
          return diskResult;
        }
        this._forget(key);
      }
      if (this._cache.has(key)) {
        const value = this._cache.get(key);
        this._cache.delete(key);
        this._cache.set(key, value);
        this._rememberReady({ key, requestedItemID, attachmentID: item.id }, value.result);
        return value.result;
      }
      // Share the attachment work across parents and unrestricted/visible calls,
      // but track each consumer separately so one disappearing card cannot cancel
      // a different card's request or start a duplicate render in another lane.
      let job = this._pending.get(key);
      // The UI should request only visible cards. This cap also protects other callers.
      if (!job && this._queue.length + this._diskQueue.length >= 160) return null;
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const consumer = { requestedItemID, visibleOnly, resolve };
      if (job) {
        job.consumers.push(consumer);
        this._prioritizeQueues();
      }
      else {
        job = { key, attachmentID: item.id, path, mime, sourceSize: stat.size,
          generation, consumers: [consumer] };
        this._pending.set(key, job);
        this._diskQueue.push(job);
        this._prioritizeQueues();
        this._pumpDisk();
      }
      const result = await promise;
      return eligible() ? result : null;
    }
    catch (error) {
      if (eligible()) this._ready.delete(requestedItemID);
      this._log(error);
      return null;
    }
  }

  _eligible(generation, requestedItemID, visibleOnly) {
    return !this._destroyed && generation === this._generation
      && (!visibleOnly || this._visibleItems.has(requestedItemID));
  }

  _jobEligible(job) {
    return job.consumers.some(consumer => this._eligible(job.generation,
      consumer.requestedItemID, consumer.visibleOnly));
  }

  /** Update the rendered card IDs (including overscan) before requesting previews. */
  setVisibleItems(ids, { priorityItems = [] } = {}) {
    this._visibleItems = new Set(ids);
    this._priorityItems = new Set(priorityItems);
    for (const name of ["_queue", "_diskQueue"]) {
      this[name] = this[name].filter(job => {
        job.consumers = job.consumers.filter(consumer => {
          if (!consumer.visibleOnly || this._visibleItems.has(consumer.requestedItemID)) return true;
          consumer.resolve(null);
          return false;
        });
        if (job.consumers.length) return true;
        this._finish(job, null);
        return false;
      });
    }
    this._prioritizeQueues();
  }

  _prioritizeQueues() {
    const priority = job => Number(job.consumers.some(consumer =>
      this._priorityItems.has(consumer.requestedItemID)));
    for (const queue of [this._diskQueue, this._queue]) {
      // Stable sorting preserves FIFO order within the viewport and overscan.
      queue.sort((a, b) => priority(b) - priority(a));
    }
  }

  _finish(job, result) {
    if (job.finished) return;
    job.finished = true;
    if (this._pending.get(job.key) === job) this._pending.delete(job.key);
    for (const consumer of job.consumers) {
      if (result && this._eligible(job.generation, consumer.requestedItemID, false)) {
        this._rememberReady({ ...job, requestedItemID: consumer.requestedItemID }, result);
      }
      consumer.resolve(result);
    }
  }

  // Disk hits never wait behind PDF rendering. Bound concurrent reads so fast
  // scrolling also remains inexpensive on a slow or network-backed profile.
  _pumpDisk() {
    while (this._diskRunning < 4 && this._diskQueue.length && !this._destroyed) {
      const job = this._diskQueue.shift();
      this._diskRunning++;
      (async () => {
        let result = null;
        let transferred = false;
        try {
          if (!this._jobEligible(job)) return;
          result = this._cache.has(job.key) ? this._cache.get(job.key).result : await this._readDisk(job);
          if (!this._jobEligible(job)) { result = null; return; }
          if (result) {
            this._remember(job.key, result, job.attachmentID);
          }
          else {
            transferred = true;
            this._queue.push(job);
            this._prioritizeQueues();
            this._pump();
            return;
          }
        }
        catch (error) { this._log(error); }
        finally {
          // A cache miss transfers ownership to the renderer pool.
          if (!transferred) this._finish(job, result);
          this._diskRunning--;
          this._pumpDisk();
        }
      })();
    }
  }

  _pump() {
    if (this._destroyed) return;
    for (const lane of this._renderers) {
      if (lane.job || !this._queue.length) continue;
      const job = this._queue.shift();
      lane.job = job;
      (async () => {
        let result = null;
        try {
          if (this._jobEligible(job)) {
            if (this._cache.has(job.key)) result = this._cache.get(job.key).result;
            if (!this._jobEligible(job)) result = null;
            else {
              if (!result) {
                result = await this._render(job, lane);
                if (result && this._eligible(job.generation, null, false)) {
                  result = await this._writeDisk(job, result) || result;
                }
              }
              if (!this._eligible(job.generation, null, false)) result = null;
              else if (result) {
                this._remember(job.key, result, job.attachmentID);
              }
            }
          }
        }
        catch (error) {
          this._log(error);
          if (this._jobEligible(job)) {
            this._remember(job.key, null, job.attachmentID);
          }
        }
        finally {
          this._finish(job, result);
          lane.job = null;
          this._pump();
        }
      })();
    }
  }

  async _render(job, lane) {
    let timer;
    let stopped = false;
    const eligible = () => !stopped
      && this._eligible(job.generation, null, false);
    const watchdog = new Promise((_, reject) => {
      lane.abortActive = () => { stopped = true; reject(new Error("Thumbnail render cancelled")); };
      timer = this.window.setTimeout(() => {
        stopped = true;
        reject(new Error("Thumbnail render timed out"));
      }, 30000);
    });
    try {
      return await Promise.race([
        watchdog,
        (async () => {
          // EPUB previews use the actual cover image, not a rendered book page.
          // PDF and image rendering stays inside Zotero on every platform.
          let bytes, mime = job.mime;
          if (mime === "application/epub+zip") {
            const cover = await this._epubCover?.extract(job.path, { eligible });
            if (!cover || !eligible()) return null;
            ({ bytes, mime } = cover);
          }
          const rendererWindow = await this._getRenderer(lane);
          if (!eligible()) return null;
          const renderer = rendererWindow.wrappedJSObject.LibraryThumbnailRenderer;
          const localPDF = mime === "application/pdf" && renderer.supportsLocalPDFRange === true;
          if (!bytes && !localPDF) bytes = await IOUtils.read(job.path);
          if (!eligible()) return null;
          const options = Components.utils.cloneInto({
            ...(localPDF ? { path: job.path, size: job.sourceSize } : { bytes }),
            mime,
            maxWidth: 360,
            maxHeight: 480
          }, rendererWindow);
          const result = await renderer.render(options);
          if (!result || !eligible()) return null;
          // Copy primitives out of the renderer realm before destroying/replacing it.
          return {
            src: String(result.src),
            width: Number(result.width),
            height: Number(result.height),
            attachmentID: job.attachmentID
          };
        })()
      ]);
    }
    catch (error) {
      this._resetRenderer(lane);
      throw error;
    }
    finally {
      stopped = true;
      this.window.clearTimeout(timer);
      lane.abortActive = null;
    }
  }

  _getRenderer(lane) {
    if (lane.promise) return lane.promise;
    lane.promise = new Promise((resolve, reject) => {
      const browser = this.window.document.createXULElement("browser");
      lane.browser = browser;
      browser.setAttribute("type", "content");
      browser.setAttribute("disableglobalhistory", "true");
      browser.setAttribute("aria-hidden", "true");
      browser.setAttribute("tabindex", "-1");
      browser.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;visibility:hidden;pointer-events:none;";
      const onLoad = () => {
        try {
          const win = browser.contentWindow;
          if (win?.wrappedJSObject?.LibraryThumbnailRenderer) {
            cleanup();
            resolve(win);
          }
          else if (win?.location?.href === this.rendererURL && win.document.readyState === "complete") {
            cleanup();
            reject(new Error("Zotero's bundled PDF renderer could not be loaded"));
          }
        }
        catch (error) { cleanup(); reject(error); }
      };
      const cleanup = () => {
        browser.removeEventListener("load", onLoad, true);
        lane.cancelLoad = null;
      };
      lane.cancelLoad = () => { cleanup(); reject(new Error("Thumbnail render cancelled")); };
      browser.addEventListener("load", onLoad, true);
      browser.setAttribute("src", this.rendererURL);
      this.window.document.documentElement.appendChild(browser);
    });
    return lane.promise;
  }

  _diskPath(key) {
    if (!this._diskDirectory) return null;
    const digest = this.Zotero.Utilities.Internal.md5("v1|360x480|" + key);
    return this._diskDirectory + "/" + digest + ".png";
  }

  async _ensureDisk() {
    if (!this._diskDirectory || this._diskDisabled) return false;
    if (!this._diskReady) {
      this._diskReady = IOUtils.makeDirectory(this._diskDirectory, {
        ignoreExisting: true, createAncestors: true, permissions: 0o700
      }).then(() => { this._scheduleDiskPrune(); return true; }).catch(error => {
        this._diskDisabled = true;
        this._log(error);
        return false;
      });
    }
    return this._diskReady;
  }

  // Verify all chunk checksums as well as PNG dimensions. A damaged cache file
  // must trigger regeneration, never a permanently broken image in the grid.
  _pngDimensions(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 45 || bytes.length > this._maxPNGBytes
      || signature.some((value, index) => bytes[index] !== value)) return null;
    const read32 = offset => ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
    if (!this._crcTable) {
      this._crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        this._crcTable[n] = c >>> 0;
      }
    }
    let dimensions = null, hasData = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = read32(offset);
      const end = offset + 8 + length;
      if (end + 4 > bytes.length) return null;
      let crc = 0xffffffff;
      for (let i = offset + 4; i < end; i++) crc = this._crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
      if (((crc ^ 0xffffffff) >>> 0) !== read32(end)) return null;
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (offset === 8) {
        if (type !== "IHDR" || length !== 13) return null;
        const width = read32(offset + 8), height = read32(offset + 12);
        if (!width || width > 360 || !height || height > 480) return null;
        dimensions = { width, height };
      }
      if (type === "IDAT") hasData = true;
      if (type === "IEND") return length === 0 && end + 4 === bytes.length && hasData ? dimensions : null;
      offset = end + 4;
    }
    return null;
  }

  _pngDataURL(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return "data:image/png;base64," + this.window.btoa(binary);
  }

  _diskResult(job, dimensions, stat) {
    const src = this.Zotero.File?.pathToFileURI?.(this._diskPath(job.key));
    return src ? { src: src + "?v=" + stat.lastModified, width: dimensions.width, height: dimensions.height,
      attachmentID: job.attachmentID, cacheSize: stat.size, cacheModified: stat.lastModified } : null;
  }

  _rememberReady(job, result) {
    this._ready.set(job.requestedItemID, { key: job.key, attachmentID: job.attachmentID,
      diskResult: result?.src.startsWith("file:") ? result : null });
  }

  async _readDisk(job) {
    if (!(await this._ensureDisk())) return null;
    const path = this._diskPath(job.key);
    try {
      let stat = await IOUtils.stat(path);
      if (!stat.size || stat.size > this._maxPNGBytes) throw new Error("Invalid thumbnail cache size");
      const bytes = await IOUtils.read(path, { maxBytes: this._maxPNGBytes + 1 });
      const dimensions = this._pngDimensions(bytes);
      if (!dimensions) throw new Error("Invalid thumbnail cache PNG");
      // Explicitly limited caches use filesystem timestamps as their disk LRU.
      if ((Number.isFinite(this.maxDiskEntries) || Number.isFinite(this.maxDiskBytes))
        && Date.now() - stat.lastModified > 3600000) {
        try {
          await IOUtils.setModificationTime(path);
          stat = await IOUtils.stat(path);
        } catch (_) {}
      }
      return this._diskResult(job, dimensions, stat)
        || { src: this._pngDataURL(bytes), ...dimensions, attachmentID: job.attachmentID };
    }
    catch (error) {
      // Missing entries are normal. Removing a corrupt/oversized entry is safe,
      // and any filesystem failure falls back to ordinary in-memory rendering.
      if (error.name !== "NotFoundError") {
        try { await IOUtils.remove(path, { ignoreAbsent: true }); } catch (_) {}
      }
      return null;
    }
  }

  async _writeDisk(job, result) {
    if (!(await this._ensureDisk()) || !result.src.startsWith("data:image/png;base64,")) return;
    try {
      const binary = this.window.atob(result.src.slice(22));
      if (binary.length > this._maxPNGBytes) return;
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      if (!this._pngDimensions(bytes)) return;
      const path = this._diskPath(job.key);
      // A collection change can cancel a consumer while its disk write is still
      // settling. A new request for that key must get a distinct atomic temp file.
      const nonce = this._diskNonce + (++this._diskWriteSequence).toString(36);
      await IOUtils.write(path, bytes, { tmpPath: path + "." + nonce + ".tmp", permissions: 0o600 });
      this._diskWrites++;
      // Prune in a deferred batch, keeping up to 2,000 previews by default.
      // Coalesce writes so cleanup does not scan the library for every PNG.
      if (Number.isFinite(this.maxDiskEntries) || Number.isFinite(this.maxDiskBytes)) this._scheduleDiskPrune();
      return this._diskResult(job, result, await IOUtils.stat(path));
    }
    catch (error) {
      this._diskDisabled = true;
      this._log(error);
    }
  }

  _scheduleDiskPrune() {
    if (this._destroyed) return;
    if (this._prunePromise) { this._pruneDirty = true; return; }
    if (this._pruneTimer) return;
    this._pruneTimer = this.window.setTimeout(() => {
      this._pruneTimer = null;
      this._prunePromise = this._pruneDisk().catch(error => this._log(error))
        .finally(() => {
          this._prunePromise = null;
          if (this._pruneDirty) { this._pruneDirty = false; this._scheduleDiskPrune(); }
        });
    }, 1000);
  }

  async _pruneDisk() {
    if (!this._diskDirectory || this._diskDisabled || this._destroyed) return;
    const limited = Number.isFinite(this.maxDiskEntries) || Number.isFinite(this.maxDiskBytes);
    const children = (await IOUtils.getChildren(this._diskDirectory))
      .filter(path => limited || path.endsWith(".tmp"));
    const files = [];
    // Limit concurrent disk operations and yield between batches so a large
    // pre-existing cache cannot monopolize the Zotero window's event loop.
    for (let offset = 0; offset < children.length && !this._destroyed; offset += 32) {
      const batch = children.slice(offset, offset + 32)
        .filter(path => /\/[0-9a-f]{32}\.png(?:\.[a-z0-9]+\.tmp)?$/.test(path));
      const stats = await Promise.all(batch.map(async path => {
        try { return { path, ...(await IOUtils.stat(path)) }; } catch (_) { return null; }
      }));
      for (const file of stats.filter(Boolean)) {
        if (file.path.endsWith(".tmp")) {
          // Clean only this cache's abandoned atomic-write files. A recent
          // temporary file may still belong to another live Zotero window.
          if (Date.now() - file.lastModified > 24 * 3600000) {
            try { await IOUtils.remove(file.path, { ignoreAbsent: true }); } catch (_) {}
          }
        }
        else files.push(file);
      }
      await new Promise(resolve => this.window.setTimeout(resolve, 0));
    }
    files.sort((a, b) => b.lastModified - a.lastModified);
    let bytes = 0, count = 0;
    for (let offset = 0; offset < files.length && !this._destroyed; offset += 16) {
      const remove = [];
      for (const file of files.slice(offset, offset + 16)) {
        if (count >= this.maxDiskEntries || bytes + file.size > this.maxDiskBytes) {
          remove.push(IOUtils.remove(file.path, { ignoreAbsent: true }).catch(() => {}));
        }
        else { count++; bytes += file.size; }
      }
      await Promise.all(remove);
      await new Promise(resolve => this.window.setTimeout(resolve, 0));
    }
  }

  _remember(key, result, attachmentID) {
    const bytes = result ? result.src.length * 2 : 0;
    if (bytes > this.maxCacheBytes) return;
    const prior = this._cache.get(key);
    if (prior) this._cacheBytes -= prior.bytes;
    this._cache.set(key, { result, bytes, attachmentID });
    this._cacheBytes += bytes;
    while (this._cache.size > this.maxEntries || this._cacheBytes > this.maxCacheBytes) {
      const first = this._cache.keys().next().value;
      this._cacheBytes -= this._cache.get(first).bytes;
      this._cache.delete(first);
    }
  }

  _forget(key) {
    const value = this._cache.get(key);
    if (value) this._cacheBytes -= value.bytes;
    this._cache.delete(key);
    for (const [id, ready] of this._ready) {
      if (ready.key === key) this._ready.delete(id);
    }
  }

  invalidate(itemID) {
    for (const [key, value] of this._cache) {
      if (value.attachmentID === Number(itemID)) {
        this._forget(key);
      }
    }
    for (const [id, ready] of this._ready) {
      if (id === Number(itemID) || ready.attachmentID === Number(itemID)) this._ready.delete(id);
    }
  }

  clearQueue() {
    this._generation++;
    this._queue.length = this._diskQueue.length = 0;
    for (const job of this._pending.values()) this._finish(job, null);
    for (const lane of this._renderers) lane.abortActive?.();
  }

  clear() {
    this.clearQueue();
    this._cache.clear();
    this._cacheBytes = 0;
    this._ready.clear();
  }

  _resetRenderer(lane) {
    lane.cancelLoad?.();
    try { lane.browser?.contentWindow?.wrappedJSObject?.LibraryThumbnailRenderer?.cancel(); }
    catch (_) {}
    lane.browser?.remove();
    lane.browser = null;
    lane.promise = null;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.window.clearTimeout(this._pruneTimer);
    this._pruneTimer = null;
    this.clear();
    for (const lane of this._renderers) this._resetRenderer(lane);
  }

  _log(error) {
    if (!this._destroyed && error?.message !== "Thumbnail render cancelled") {
      this.Zotero.debug(`[Library Icon View] ${error?.message || error}`);
    }
  }
};
