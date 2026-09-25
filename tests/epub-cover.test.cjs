const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../epub-cover.js"), "utf8");
const encode = value => new TextEncoder().encode(value);

// These dependency-free tests model Gecko XML nodes and ZIP streams. Actual
// DOMParser/ZIP decoding and cover pixels are also checked in isolated Zotero.
function element(name, attributes = {}, ...children) {
  const node = { localName: name.split(":").at(-1), children,
    attributes: Object.entries(attributes).map(([name, value]) => ({ localName: name.split(":").at(-1), value })),
    getAttribute: name => attributes[name] || "",
    getAttributeNS: (ns, name) => attributes["xlink:" + name] || attributes[name] || ""
  };
  return node;
}
function document(root) {
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  return { documentElement: root,
    getElementsByTagNameNS: (ns, name) => descendants(root).filter(node => name === "*" || node.localName === name)
  };
}
function fixture() {
  const files = new Map(), documents = new Map();
  const state = { opened: 0, closed: 0, streams: 0, streamsClosed: 0, bytesRead: 0, parsed: [] };
  const zip = {
    open() { state.opened++; }, close() { state.closed++; },
    hasEntry: path => files.has(path),
    getEntry: path => ({ realSize: files.get(path).size ?? files.get(path).bytes.length }),
    getInputStream(path) {
      state.streams++;
      const entry = files.get(path);
      return { entry, offset: 0, close() { state.streamsClosed++; } };
    }
  };
  const window = { TextDecoder, TextEncoder, setTimeout,
    DOMParser: class { parseFromString(text) {
      state.parsed.push(text);
      return documents.get(text) || document(element("parsererror"));
    } },
    XMLSerializer: class { serializeToString(node) { return node.serialized || "<svg/>"; } }
  };
  const context = { Components: {
    interfaces: { nsIZipReader: "zip", nsIBinaryInputStream: "binary" },
    classes: {
      "@mozilla.org/libjar/zip-reader;1": { createInstance: () => zip },
      "@mozilla.org/binaryinputstream;1": { createInstance: () => ({
        setInputStream(stream) { this.stream = stream; },
        readByteArray(length) {
          if (this.stream.entry.corrupt) throw new Error("Corrupt compressed stream");
          const bytes = this.stream.entry.bytes.slice(this.stream.offset, this.stream.offset + length);
          this.stream.offset += length;
          state.bytesRead += bytes.length;
          if (bytes.length !== length) throw new Error("Truncated stream");
          return Array.from(bytes);
        },
        close() { this.stream.close(); }
      }) }
    }
  } };
  vm.runInNewContext(source, context);
  const reader = new context.LibraryEPUBCover({ window, Zotero: { File: { pathToFile: value => value } } });
  const add = (path, bytes, options = {}) => files.set(path, { bytes: typeof bytes === "string" ? encode(bytes) : bytes, ...options });
  const xml = (path, root) => { const token = "xml:" + path; add(path, token); documents.set(token, document(root)); };
  xml("META-INF/container.xml", element("container", {}, element("rootfiles", {},
    element("rootfile", { "full-path": "OPS/content.opf", "media-type": "application/oebps-package+xml" }))));
  const opf = (items, metadata = [], guide = []) => xml("OPS/content.opf", element("package", {},
    element("metadata", {}, ...metadata), element("manifest", {}, ...items), element("guide", {}, ...guide)));
  return { reader, state, window, files, documents, add, xml, opf };
}

test("EPUB 3 cover-image token selects the declared image and decodes its ZIP URI", async () => {
  const f = fixture();
  f.opf([
    element("item", { id: "other", href: "other.png", "media-type": "image/png" }),
    element("item", { id: "cover", href: "Images/cover%20image.png", "media-type": "image/png", properties: "remote-resources cover-image" })
  ]);
  f.add("OPS/Images/cover image.png", new Uint8Array([1, 2, 3]));
  const result = await f.reader.extract("book.epub");
  assert.equal(result.mime, "image/png");
  assert.deepEqual(Array.from(result.bytes), [1, 2, 3]);
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.streams, f.state.streamsClosed);
});

test("EPUB 2 cover metadata resolves the manifest ID rather than taking the first image", async () => {
  const f = fixture();
  f.opf([
    element("item", { id: "first", href: "first.jpg", "media-type": "image/jpeg" }),
    element("item", { id: "correct", href: "../cover.jpg", "media-type": "image/jpeg" })
  ], [element("meta", { name: "cover", content: "correct" })]);
  f.add("cover.jpg", new Uint8Array([4, 5, 6]));
  assert.equal((await f.reader.extract("book.epub")).mime, "image/jpeg");
});

test("missing metadata falls back only to an explicitly named cover", async () => {
  for (const file of ["front-cover.png", "cover-image.png", "logo.png"]) {
    const f = fixture();
    f.opf([element("item", { href: file, "media-type": "image/png" })]);
    f.add("OPS/" + file, new Uint8Array([3]));
    assert.equal(!!(await f.reader.extract("book.epub")), file !== "logo.png");
  }
});

for (const kind of ["img", "svg:image"]) {
  test(`guide cover XHTML extracts the original ${kind} image without page padding`, async () => {
    const f = fixture();
    f.opf([], [], [element("reference", { type: "cover", href: "Text/titlepage.xhtml#cover" })]);
    f.xml("OPS/Text/titlepage.xhtml", element("html", {}, element("body", {},
      element(kind, { [kind === "img" ? "src" : "xlink:href"]: "../Images/cover%20image.png" }))));
    f.add("OPS/Images/cover image.png", new Uint8Array([7, 8, 9]));
    assert.deepEqual(Array.from((await f.reader.extract("book.epub")).bytes), [7, 8, 9]);
  });
}

test("archive URI resolution rejects external resources, root escapes, controls and invalid escapes", () => {
  const { reader } = fixture();
  assert.equal(reader._resolve("OPS/Text/page.xhtml", "../Images/cover%20image.png#front"), "OPS/Images/cover image.png");
  for (const value of ["https://example.test/cover.jpg", "//host/cover.jpg", "file:///tmp/a", "data:image/png;base64,a",
    "/cover.jpg", "../../escape.jpg", "%2e%2e/%2e%2e/escape.jpg", "%2fabsolute.jpg", "a%00b", "a\\b", "bad%zz"]) {
    assert.equal(reader._resolve("OPS/content.opf", value), null, value);
  }
});

test("vector-only covers must be self-contained and inactive", async () => {
  for (const [node, accepted] of [
    [element("svg", {}, element("path", { fill: "blue" })), true],
    [element("svg", {}, element("image", { href: "https://example.test/a.png" })), false],
    [element("svg", {}, element("script")), false],
    [element("svg", {}, element("path", { onclick: "run()" })), false]
  ]) {
    const f = fixture();
    f.opf([element("item", { href: "cover.svg", "media-type": "image/svg+xml", properties: "cover-image" })]);
    f.xml("OPS/cover.svg", node);
    const result = await f.reader.extract("book.epub");
    assert.equal(!!result, accepted);
    if (result) assert.equal(result.mime, "image/svg+xml");
  }
});

test("XML entities are rejected and ordinary external doctypes are removed before parsing", () => {
  const f = fixture();
  assert.equal(f.reader._parse(encode('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>')), null);
  assert.equal(f.state.parsed.length, 0);
  f.reader._parse(encode('<!DOCTYPE html PUBLIC "external"><html/>'));
  assert.equal(f.state.parsed[0], "<html/>");
});

test("entry and aggregate limits reject excessive decompression before opening streams", async () => {
  const f = fixture();
  f.add("large.png", new Uint8Array([1]), { size: f.reader.maxImageBytes + 1 });
  assert.equal(await f.reader._read({ hasEntry: () => true, getEntry: () => ({ realSize: 2 ** 32 }),
    getInputStream: () => { throw new Error("Must not read oversized entries"); } }, "large.png", f.reader.maxImageBytes,
  () => true, { bytes: 0 }), null);
  f.opf([element("item", { href: "../large.png", "media-type": "image/png", properties: "cover-image" })]);
  assert.equal(await f.reader.extract("book.epub"), null);
  assert.equal(f.state.streams, 2);
  const streamsBefore = f.state.streams;
  const zip = { hasEntry: () => true, getEntry: () => ({ realSize: 200 }), getInputStream: () => assert.fail("Aggregate limit must apply") };
  assert.equal(await f.reader._read(zip, "x", 1000, () => true, { bytes: f.reader.maxTotalBytes - 100 }), null);
  assert.equal(f.state.streams, streamsBefore);
});

test("cancellation during cover decompression closes the stream and ZIP promptly", async () => {
  const f = fixture();
  let eligible = true;
  f.window.setTimeout = callback => { eligible = false; callback(); };
  f.opf([element("item", { href: "cover.png", "media-type": "image/png", properties: "cover-image" })]);
  f.add("OPS/cover.png", new Uint8Array(600000));
  assert.equal(await f.reader.extract("book.epub", { eligible: () => eligible }), null);
  assert.ok(f.state.bytesRead < 300000);
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.streams, f.state.streamsClosed);
});

test("missing covers and damaged streams fail gracefully with archive handles closed", async () => {
  for (const corrupt of [false, true]) {
    const f = fixture();
    f.opf([element("item", { href: "cover.png", "media-type": "image/png", properties: "cover-image" })]);
    if (corrupt) f.add("OPS/cover.png", new Uint8Array([1, 2]), { corrupt: true });
    assert.equal(await f.reader.extract("book.epub"), null);
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.streams, f.state.streamsClosed);
  }
});
