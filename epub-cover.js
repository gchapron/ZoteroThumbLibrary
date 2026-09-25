/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Loaded into the privileged bootstrap scope before thumbnails.js. */

var LibraryEPUBCover = class LibraryEPUBCover {
  constructor({ Zotero, window }) {
    this.Zotero = Zotero;
    this.window = window;
    this.maxXMLBytes = 1024 * 1024;
    this.maxImageBytes = 16 * 1024 * 1024;
    this.maxTotalBytes = 24 * 1024 * 1024;
  }

  /** Read a cover only; never extract files, open book HTML, or fetch a URL. */
  async extract(path, { eligible = () => true } = {}) {
    if (!eligible()) return null;
    const zip = Components.classes["@mozilla.org/libjar/zip-reader;1"]
      .createInstance(Components.interfaces.nsIZipReader);
    let opened = false;
    try {
      zip.open(this.Zotero.File.pathToFile(path));
      opened = true;
      const budget = { bytes: 0 };
      const container = await this._xml(zip, "META-INF/container.xml", eligible, budget);
      if (!container || !eligible()) return null;
      const rootfiles = this._children(container.documentElement, "rootfiles")[0];
      const roots = this._children(rootfiles, "rootfile");
      const root = roots.find(node => node.getAttribute("media-type") === "application/oebps-package+xml") || roots[0];
      const packagePath = this._resolve("", root?.getAttribute("full-path"));
      if (!packagePath) return null;
      const opf = await this._xml(zip, packagePath, eligible, budget);
      if (!opf || !eligible()) return null;
      const manifest = this._children(opf.documentElement, "manifest")[0];
      const entries = this._children(manifest, "item").map(node => ({
        id: node.getAttribute("id"),
        path: this._resolve(packagePath, node.getAttribute("href")),
        mime: node.getAttribute("media-type") || "",
        properties: this._tokens(node.getAttribute("properties"))
      })).filter(entry => entry.path);
      const byPath = new Map(entries.map(entry => [entry.path, entry]));
      const candidates = entries.filter(entry => entry.properties.includes("cover-image"));
      const metadata = this._children(opf.documentElement, "metadata")[0];
      for (const meta of this._children(metadata, "meta")) {
        if (meta.getAttribute("name") !== "cover") continue;
        const entry = entries.find(entry => entry.id === meta.getAttribute("content"));
        if (entry) candidates.push(entry);
      }
      const guide = this._children(opf.documentElement, "guide")[0];
      for (const reference of this._children(guide, "reference")) {
        if (!this._tokens(reference.getAttribute("type")).includes("cover")) continue;
        const path = this._resolve(packagePath, reference.getAttribute("href"));
        if (path) candidates.push(byPath.get(path) || { path, mime: "" });
      }
      // Some older books omit cover metadata. Use an explicitly named cover,
      // not the first illustration or a publisher's decorative title-page logo.
      for (const entry of entries) {
        const name = entry.path.split("/").pop().replace(/\.[^.]*$/, "");
        if (/^(?:front[-_ ]?)?cover(?:[-_ ]?image)?$/i.test(entry.id || "")
          || /^(?:front[-_ ]?)?cover(?:[-_ ]?image)?$/i.test(name)) candidates.push(entry);
      }
      const seen = new Set();
      for (const candidate of candidates.slice(0, 16)) {
        if (!eligible()) return null;
        const result = await this._cover(zip, candidate, byPath, eligible, budget, seen, 0);
        if (result && eligible()) return result;
      }
      return null;
    }
    catch (_) { return null; }
    finally { if (opened) zip.close(); }
  }

  _tokens(value) { return (value || "").trim().split(/\s+/).filter(Boolean); }

  _children(node, name) {
    return Array.from(node?.children || []).filter(child => child.localName === name);
  }

  // Resolve URI paths inside the archive, decoding once. A root escape, URL,
  // absolute path, backslash, control character, or malformed escape is invalid.
  _resolve(base, href) {
    if (typeof href !== "string" || href.length > 2048) return null;
    let path;
    try { path = decodeURIComponent(href.trim().split(/[?#]/, 1)[0]); }
    catch (_) { return null; }
    if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/")
      || /[\\\x00-\x1f\x7f]/.test(path)) return null;
    const parts = base ? base.split("/").slice(0, -1) : [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") { if (!parts.length) return null; parts.pop(); }
      else parts.push(part);
    }
    return parts.length ? parts.join("/") : null;
  }

  async _read(zip, path, limit, eligible, budget) {
    if (!eligible() || !zip.hasEntry(path)) return null;
    const entry = zip.getEntry(path);
    const size = Number(entry.realSize);
    if (entry.isDirectory || !Number.isSafeInteger(size) || size <= 0 || size > limit
      || budget.bytes + size > this.maxTotalBytes) return null;
    budget.bytes += size;
    const stream = zip.getInputStream(path);
    let binary;
    try {
      binary = Components.classes["@mozilla.org/binaryinputstream;1"]
        .createInstance(Components.interfaces.nsIBinaryInputStream);
      binary.setInputStream(stream);
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += 65536) {
        if (!eligible()) return null;
        const length = Math.min(65536, size - offset);
        bytes.set(binary.readByteArray(length), offset);
        // Yield during decompression of larger images so view changes cancel it.
        if (offset + length < size && (offset + length) % 262144 === 0) {
          await new Promise(resolve => this.window.setTimeout(resolve, 0));
        }
      }
      return eligible() ? bytes : null;
    }
    finally {
      try { if (binary) binary.close(); else stream.close(); } catch (_) {}
    }
  }

  _parse(bytes) {
    if (!bytes) return null;
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
    let text = new this.window.TextDecoder(encoding, { fatal: true }).decode(bytes);
    // Ordinary XHTML doctypes are common. Drop them; never accept an internal
    // DTD/entity declaration or let an external DTD participate in parsing.
    if (/<!ENTITY\b/i.test(text) || /<!DOCTYPE[^>]*\[/i.test(text)) return null;
    text = text.replace(/<!DOCTYPE[^>]*>/gi, "");
    const doc = new this.window.DOMParser().parseFromString(text, "application/xml");
    if (!doc.documentElement || doc.getElementsByTagNameNS("*", "parsererror").length) return null;
    return doc;
  }

  async _xml(zip, path, eligible, budget) {
    return this._parse(await this._read(zip, path, this.maxXMLBytes, eligible, budget));
  }

  _mime(path, declared) {
    const mime = (declared || "").toLowerCase();
    if (mime === "image/jpg") return "image/jpeg";
    if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
      "image/svg+xml", "application/xhtml+xml", "text/html"].includes(mime)) return mime;
    const extension = path.split(".").pop().toLowerCase();
    return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
      xhtml: "application/xhtml+xml", html: "text/html", htm: "text/html" })[extension] || "";
  }

  async _cover(zip, entry, byPath, eligible, budget, seen, depth) {
    if (depth > 3 || seen.has(entry.path) || !eligible()) return null;
    seen.add(entry.path);
    const mime = this._mime(entry.path, entry.mime);
    if (mime.startsWith("image/") && mime !== "image/svg+xml") {
      const bytes = await this._read(zip, entry.path, this.maxImageBytes, eligible, budget);
      return bytes ? { bytes, mime } : null;
    }
    if (!["image/svg+xml", "application/xhtml+xml", "text/html"].includes(mime)) return null;
    const doc = await this._xml(zip, entry.path, eligible, budget);
    if (!doc || !eligible()) return null;
    // Calibre title pages commonly wrap a raster cover in an SVG image element.
    // Extract that raster itself, avoiding the HTML/SVG page's white margins.
    const images = Array.from(doc.getElementsByTagNameNS("*", "img"))
      .concat(Array.from(doc.getElementsByTagNameNS("*", "image"))).slice(0, 16);
    for (const image of images) {
      const href = image.getAttribute("src") || image.getAttribute("href")
        || image.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      const path = this._resolve(entry.path, href);
      if (!path) continue;
      const result = await this._cover(zip, byPath.get(path) || { path, mime: "" },
        byPath, eligible, budget, seen, depth + 1);
      if (result) return result;
    }
    // A vector-only SVG is also a valid EPUB cover, provided it is self-contained.
    // Reject active content and every non-fragment resource reference explicitly.
    if (mime !== "image/svg+xml" || doc.documentElement.localName !== "svg") return null;
    for (const node of [doc.documentElement, ...doc.getElementsByTagNameNS("*", "*")]) {
      if (["script", "foreignObject", "animate", "animateMotion", "animateTransform", "set", "discard"].includes(node.localName)) return null;
      for (const attr of Array.from(node.attributes || [])) {
        if (/^on/i.test(attr.localName)) return null;
        if (["href", "src"].includes(attr.localName) && attr.value && !attr.value.startsWith("#")) return null;
      }
    }
    const serialized = new this.window.XMLSerializer().serializeToString(doc.documentElement);
    // CSS escapes could disguise a resource-loading token, so do not accept them.
    if (/@import|@font-face|\\/i.test(serialized)) return null;
    for (const match of serialized.matchAll(/url\s*\(([^)]*)\)/gi)) {
      if (!/^['"]?#[^\s'"()]+['"]?$/.test(match[1].trim())) return null;
    }
    return { bytes: new this.window.TextEncoder().encode(serialized), mime };
  }
};
