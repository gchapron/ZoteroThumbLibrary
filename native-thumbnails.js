/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Loaded into the bootstrap scope before thumbnails.js. */

var LibraryNativeThumbnails = class LibraryNativeThumbnails {
  constructor({ Zotero, window, timeoutMS = 5000 }) {
    this.Zotero = Zotero;
    this.window = window;
    this.timeoutMS = timeoutMS;
    this._jobs = new Set();
    this._destroyed = false;
    this._available = !!Zotero.isMac;
    this._subprocess = null;
    this._maxPNGBytes = 4 * 1024 * 1024;
  }

  /** Native macOS first-page preview, or null for the caller's PDF.js fallback. */
  async render({ path, mime, maxWidth = 360, maxHeight = 480 }) {
    if (!this._available || this._destroyed || mime !== "application/pdf"
      || typeof path !== "string" || path.includes("\0") || !PathUtils.isAbsolute(path)) return null;
    maxWidth = Math.max(1, Math.min(1024, Math.round(Number(maxWidth) || 360)));
    maxHeight = Math.max(1, Math.min(1024, Math.round(Number(maxHeight) || 480)));
    let cancelSignal;
    const job = { cancelled: false, process: null, directory: null, owned: false,
      cancelledPromise: new Promise(resolve => { cancelSignal = resolve; }) };
    job.signalCancel = cancelSignal;
    this._jobs.add(job);
    job.timer = this.window.setTimeout(() => this._cancelJob(job), this.timeoutMS);
    job.done = this._run(job, { path, maxWidth, maxHeight }).catch(error => {
      if (error?.errorCode === this._subprocess?.ERROR_BAD_EXECUTABLE) this._available = false;
      return null;
    }).finally(() => {
      this.window.clearTimeout(job.timer);
      this._jobs.delete(job);
    });
    // Cancellation is prompt even if process creation or a native file operation
    // has not returned yet. _run still owns late process killing and cleanup.
    return Promise.race([job.done, job.cancelledPromise]);
  }

  async _run(job, { path, maxWidth, maxHeight }) {
    try {
      if (!this._subprocess) {
        this._subprocess = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess;
      }
      const nonce = this.Zotero.Utilities.randomString(24);
      // This base directory belongs to Zotero. We remove only our uniquely
      // created child, never the base directory or an attachment directory.
      job.directory = PathUtils.join(this.Zotero.getTempDirectory().path, "thumb-native-" + nonce);
      await IOUtils.makeDirectory(job.directory, { permissions: 0o700, ignoreExisting: false });
      job.owned = true;
      if (job.cancelled || this._destroyed) return null;
      job.process = await this._subprocess.call({
        command: "/usr/bin/qlmanage",
        arguments: ["-t", "-s", String(Math.max(maxWidth, maxHeight)), "-o", job.directory, path],
        stderr: "stdout"
      });
      if (job.cancelled || this._destroyed) { await job.process.kill(0); return null; }
      // Drain stdout without retaining/logging paths or allocating an unbounded
      // string. Not draining pipes can stall a verbose native process.
      const drain = this._drain(job.process.stdout);
      // A very fast exit or cancellation can race pipe closure. The process
      // never reads stdin, so an already-closed pipe is harmless.
      if (job.process.stdin) job.process.stdin.close().catch(() => {});
      const { exitCode } = await job.process.wait();
      await drain;
      if (exitCode !== 0 || job.cancelled || this._destroyed) return null;
      const children = await IOUtils.getChildren(job.directory);
      if (job.cancelled || this._destroyed) return null;
      const output = children.find(child => PathUtils.parent(child) === job.directory && /\.png$/i.test(child));
      if (!output) return null;
      const stat = await IOUtils.stat(output);
      if (!stat.size || stat.size > this._maxPNGBytes || job.cancelled || this._destroyed) return null;
      const bytes = await IOUtils.read(output, { maxBytes: this._maxPNGBytes + 1 });
      if (job.cancelled || this._destroyed) return null;
      if (!this._pngHeader(bytes)) return null;
      return await this._fit(bytes, maxWidth, maxHeight, job);
    }
    finally {
      if (job.process && job.process.exitCode === null) {
        try { await job.process.kill(0); } catch (_) {}
      }
      if (job.owned) {
        try { await IOUtils.remove(job.directory, { recursive: true, ignoreAbsent: true }); } catch (_) {}
      }
    }
  }

  async _drain(pipe) {
    if (!pipe) return;
    try { while ((await pipe.read()).byteLength) {} } catch (_) {}
  }

  _pngHeader(bytes) {
    const signature = [137,80,78,71,13,10,26,10];
    if (bytes.length < 33 || bytes.length > this._maxPNGBytes
      || signature.some((value,index) => bytes[index] !== value)) return null;
    const read32 = offset => (bytes[offset]*0x1000000 + (bytes[offset+1]<<16)
      + (bytes[offset+2]<<8) + bytes[offset+3]) >>> 0;
    if (read32(8) !== 13 || String.fromCharCode(...bytes.subarray(12,16)) !== "IHDR") return null;
    const width = read32(16), height = read32(20);
    if (!width || !height || width > 2048 || height > 2048 || width*height > 4*1024*1024) return null;
    return {width,height};
  }

  _dataURL(bytes) {
    let binary = "";
    for (let offset=0;offset<bytes.length;offset+=32768) {
      binary += String.fromCharCode(...bytes.subarray(offset,offset+32768));
    }
    return "data:image/png;base64," + this.window.btoa(binary);
  }

  async _fit(bytes, maxWidth, maxHeight, job) {
    const image = new this.window.Image();
    image.src = this._dataURL(bytes);
    let canvas;
    try {
      // Full decoding rejects malformed PNG payloads beyond the header check.
      await image.decode();
      if (job.cancelled || this._destroyed || !image.naturalWidth || !image.naturalHeight) return null;
      const scale = Math.min(1, maxWidth/image.naturalWidth, maxHeight/image.naturalHeight);
      const width = Math.max(1,Math.floor(image.naturalWidth*scale));
      const height = Math.max(1,Math.floor(image.naturalHeight*scale));
      canvas = this.window.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0,0,width,height);
      context.drawImage(image,0,0,width,height);
      if (job.cancelled || this._destroyed) return null;
      return {src:canvas.toDataURL("image/png"),width,height};
    }
    finally {
      image.removeAttribute("src");
      if (canvas) { canvas.width=0;canvas.height=0; }
    }
  }

  _cancelJob(job) {
    if (job.cancelled) return;
    job.cancelled = true;
    job.signalCancel(null);
    if (job.process) job.process.kill(0).catch(() => {});
  }

  cancel() {
    for (const job of this._jobs) this._cancelJob(job);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.cancel();
  }
};
