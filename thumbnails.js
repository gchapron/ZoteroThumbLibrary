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
    diskCache = true, maxDiskEntries = 1000, maxDiskBytes = 128 * 1024 * 1024 }) {
    this.Zotero = Zotero;
    this.window = window;
    this.rendererURL = rendererURL || "chrome://library-icon-view/content/thumbnail-renderer.html";
    this.maxEntries = maxEntries;
    this.maxCacheBytes = maxCacheBytes;
    this._cache = new Map();
    this._cacheBytes = 0;
    this._pending = new Map();
    this._queue = [];
    this._visibleItems = new Set();
    this._running = false;
    this._destroyed = false;
    this._generation = 0;
    this._browser = null;
    this._rendererPromise = null;
    this._abortActive = null;
    this._nativeRenderer = typeof LibraryNativeThumbnails === "undefined" ? null
      : new LibraryNativeThumbnails({ Zotero, window });
    this._diskDirectory = diskCache && Zotero.Profile?.dir && Zotero.Utilities?.Internal?.md5
      ? Zotero.Profile.dir + "/cache/zoteroThumbLibrary/v1" : null;
    this.maxDiskEntries = maxDiskEntries;
    this.maxDiskBytes = maxDiskBytes;
    this._diskReady = null;
    this._diskDisabled = false;
    this._diskWrites = 0;
    this._diskNonce = Date.now().toString(36) + Math.random().toString(36).slice(2);
    this._maxPNGBytes = 2 * 1024 * 1024;
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
      if (!item || !eligible()) return null;
      const mime = item.attachmentContentType || "";
      if (mime !== "application/pdf" && !mime.startsWith("image/")) return null;
      const path = await item.getFilePathAsync();
      if (!path || !eligible()) return null;
      const stat = await IOUtils.stat(path);
      if (!eligible()) return null;
      // Avoid reading arbitrarily large attachments into memory just for a preview.
      if (!stat.size || stat.size > 256 * 1024 * 1024) return null;
      const key = `${item.id}|${path}|${stat.size}|${stat.lastModified}`;
      if (this._cache.has(key)) {
        const value = this._cache.get(key);
        this._cache.delete(key);
        this._cache.set(key, value);
        return value.result;
      }
      // Visible-only jobs can be removed by scrolling; unrestricted requests must
      // not share that cancellation, nor should two parent cards share visibility.
      const pendingKey = key + (visibleOnly ? `|visible:${requestedItemID}` : "|unrestricted");
      if (this._pending.has(pendingKey)) {
        const result = await this._pending.get(pendingKey);
        return eligible() ? result : null;
      }
      // The UI should request only visible cards. This cap also protects other callers.
      if (this._queue.length >= 160) return null;
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      this._pending.set(pendingKey, promise);
      this._queue.push({ key, pendingKey, requestedItemID, visibleOnly,
        attachmentID: item.id, path, mime, generation, resolve, promise });
      this._pump();
      const result = await promise;
      return eligible() ? result : null;
    }
    catch (error) {
      this._log(error);
      return null;
    }
  }

  _eligible(generation, requestedItemID, visibleOnly) {
    return !this._destroyed && generation === this._generation
      && (!visibleOnly || this._visibleItems.has(requestedItemID));
  }

  /** Update the rendered card IDs (including overscan) before requesting previews. */
  setVisibleItems(ids) {
    this._visibleItems = new Set(ids);
    const retained = [];
    for (const job of this._queue) {
      if (!job.visibleOnly || this._visibleItems.has(job.requestedItemID)) {
        retained.push(job);
      }
      else {
        if (this._pending.get(job.pendingKey) === job.promise) this._pending.delete(job.pendingKey);
        job.resolve(null);
      }
    }
    this._queue = retained;
  }

  async _pump() {
    if (this._running || this._destroyed) return;
    this._running = true;
    try {
      while (this._queue.length && !this._destroyed) {
        const job = this._queue.shift();
        let result = null;
        try {
          if (this._eligible(job.generation, job.requestedItemID, job.visibleOnly)) {
            // Another queued request may already have cached this attachment.
            // Recheck here before opening a PDF renderer or reading source bytes.
            if (this._cache.has(job.key)) result = this._cache.get(job.key).result;
            else result = await this._readDisk(job);
            if (!this._eligible(job.generation, job.requestedItemID, job.visibleOnly)) result = null;
            else {
              if (!result) {
                result = await this._render(job);
                if (result && this._eligible(job.generation, job.requestedItemID, job.visibleOnly)) {
                  await this._writeDisk(job, result);
                }
              }
              if (!this._eligible(job.generation, job.requestedItemID, job.visibleOnly)) result = null;
              else if (result) this._remember(job.key, result, job.attachmentID);
            }
          }
        }
        catch (error) {
          this._log(error);
          if (this._eligible(job.generation, job.requestedItemID, job.visibleOnly)) {
            this._remember(job.key, null, job.attachmentID);
          }
        }
        finally {
          if (this._pending.get(job.pendingKey) === job.promise) this._pending.delete(job.pendingKey);
          job.resolve(result);
        }
      }
    }
    finally { this._running = false; }
  }

  async _render(job) {
    let timer;
    let stopped = false;
    const eligible = () => !stopped
      && this._eligible(job.generation, job.requestedItemID, job.visibleOnly);
    const watchdog = new Promise((_, reject) => {
      this._abortActive = () => { stopped = true; reject(new Error("Thumbnail render cancelled")); };
      timer = this.window.setTimeout(() => {
        stopped = true;
        reject(new Error("Thumbnail render timed out"));
      }, 30000);
    });
    try {
      return await Promise.race([
        watchdog,
        (async () => {
          // Quick Look is already installed on macOS and reads the local file
          // directly. Other platforms and native failures use bundled PDF.js.
          let nativeResult = null;
          try {
            nativeResult = await this._nativeRenderer?.render({
              path: job.path, mime: job.mime, maxWidth: 360, maxHeight: 480
            });
          }
          catch (error) { this._log(error); }
          if (!eligible()) return null;
          if (nativeResult) {
            return {
              src: String(nativeResult.src), width: Number(nativeResult.width),
              height: Number(nativeResult.height), attachmentID: job.attachmentID
            };
          }
          const rendererWindow = await this._getRenderer();
          if (!eligible()) return null;
          const bytes = await IOUtils.read(job.path);
          if (!eligible()) return null;
          const options = Components.utils.cloneInto({
            bytes,
            mime: job.mime,
            maxWidth: 360,
            maxHeight: 480
          }, rendererWindow);
          const result = await rendererWindow.wrappedJSObject.LibraryThumbnailRenderer.render(options);
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
      this._nativeRenderer?.cancel();
      this._resetRenderer();
      throw error;
    }
    finally {
      stopped = true;
      this.window.clearTimeout(timer);
      this._abortActive = null;
    }
  }

  _getRenderer() {
    if (this._rendererPromise) return this._rendererPromise;
    this._rendererPromise = new Promise((resolve, reject) => {
      const browser = this.window.document.createXULElement("browser");
      this._browser = browser;
      browser.setAttribute("type", "content");
      browser.setAttribute("disableglobalhistory", "true");
      browser.setAttribute("aria-hidden", "true");
      browser.setAttribute("tabindex", "-1");
      browser.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;visibility:hidden;pointer-events:none;";
      const onLoad = () => {
        try {
          const win = browser.contentWindow;
          if (win?.wrappedJSObject?.LibraryThumbnailRenderer) {
            browser.removeEventListener("load", onLoad, true);
            resolve(win);
          }
          else if (win?.location?.href === this.rendererURL && win.document.readyState === "complete") {
            browser.removeEventListener("load", onLoad, true);
            reject(new Error("Zotero's bundled PDF renderer could not be loaded"));
          }
        }
        catch (error) { reject(error); }
      };
      browser.addEventListener("load", onLoad, true);
      browser.setAttribute("src", this.rendererURL);
      this.window.document.documentElement.appendChild(browser);
    });
    return this._rendererPromise;
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

  async _readDisk(job) {
    if (!(await this._ensureDisk())) return null;
    const path = this._diskPath(job.key);
    try {
      const stat = await IOUtils.stat(path);
      if (!stat.size || stat.size > this._maxPNGBytes) throw new Error("Invalid thumbnail cache size");
      const bytes = await IOUtils.read(path, { maxBytes: this._maxPNGBytes + 1 });
      const dimensions = this._pngDimensions(bytes);
      if (!dimensions) throw new Error("Invalid thumbnail cache PNG");
      // Touch at most hourly; the filesystem timestamp is the on-disk LRU.
      if (Date.now() - stat.lastModified > 3600000) {
        IOUtils.setModificationTime(path).catch(() => {});
      }
      return { src: this._pngDataURL(bytes), ...dimensions, attachmentID: job.attachmentID };
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
      await IOUtils.write(path, bytes, { tmpPath: path + "." + this._diskNonce + ".tmp", permissions: 0o600 });
      this._diskWrites++;
      this._scheduleDiskPrune();
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
    const children = await IOUtils.getChildren(this._diskDirectory);
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
    const cutoff = Date.now() - 30 * 24 * 3600000;
    for (let offset = 0; offset < files.length && !this._destroyed; offset += 16) {
      const remove = [];
      for (const file of files.slice(offset, offset + 16)) {
        if (file.lastModified < cutoff || count >= this.maxDiskEntries || bytes + file.size > this.maxDiskBytes) {
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

  invalidate(itemID) {
    for (const [key, value] of this._cache) {
      if (value.attachmentID === Number(itemID)) {
        this._cacheBytes -= value.bytes;
        this._cache.delete(key);
      }
    }
  }

  clearQueue() {
    this._generation++;
    for (const job of this._queue.splice(0)) {
      job.resolve(null);
    }
    this._pending.clear();
    if (this._abortActive) this._abortActive();
  }

  clear() {
    this.clearQueue();
    this._cache.clear();
    this._cacheBytes = 0;
  }

  _resetRenderer() {
    try { this._browser?.contentWindow?.wrappedJSObject?.LibraryThumbnailRenderer?.cancel(); }
    catch (_) {}
    this._browser?.remove();
    this._browser = null;
    this._rendererPromise = null;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.window.clearTimeout(this._pruneTimer);
    this._pruneTimer = null;
    this.clear();
    this._nativeRenderer?.destroy();
    this._resetRenderer();
  }

  _log(error) {
    if (!this._destroyed && error?.message !== "Thumbnail render cancelled") {
      this.Zotero.debug(`[Library Icon View] ${error?.message || error}`);
    }
  }
};
