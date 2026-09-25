const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../thumbnails.js"), "utf8");

// This harness exercises queue/cache/lifecycle logic. PDF pixel rendering is
// separately verified inside Zotero, which supplies Gecko and its PDF.js build.
function fixture(t, options = {}) {
  const state = { renders: 0, reads: 0, modified: 1, size: 200, hold: false, release: null,
    renderOptions: null, browsers: [], active: 0, maxActive: 0, releases: new Map(), watchdogs: [], readPaths: [] };
  const context = {
    IOUtils: {
      stat: async () => ({ size: state.size, lastModified: state.modified }),
      read: async path => { state.reads++; state.readPaths.push(path); return new Uint8Array([1, 2]); }
    },
    Components: { utils: { cloneInto: value => value } }
  };
  if (options.epubExtract) {
    context.LibraryEPUBCover = class {
      extract(file, settings) { return options.epubExtract(file, settings); }
    };
  }
  // A leftover native class must never be instantiated or called.
  context.LibraryNativeThumbnails = class { constructor() { throw new Error("No native processes"); } };
  vm.createContext(context);
  vm.runInContext(source, context);
  const window = {
    setTimeout(callback, delay) {
      const timer = setTimeout(callback, delay);
      if (delay === 30000) state.watchdogs.push({ callback, timer });
      return timer;
    }, clearTimeout,
    document: {
      createXULElement() {
        const listeners = new Map();
        let release;
        const element = {
          style: {}, setAttribute() {}, removed: false, renders: 0, cancels: 0,
          remove() { this.removed = true; },
          addEventListener(type, callback) { listeners.set(type, callback); },
          removeEventListener(type) { listeners.delete(type); },
          loaded() { listeners.get("load")?.(); },
          contentWindow: { wrappedJSObject: { LibraryThumbnailRenderer: {
            supportsLocalPDFRange: options.localPDFRange === true,
            async render(renderOptions) {
              state.renderOptions = renderOptions;
              const index = ++state.renders;
              element.renders++;
              state.active++;
              state.maxActive = Math.max(state.active, state.maxActive);
              try {
                if (state.hold) await new Promise(resolve => {
                  release = () => { state.releases.delete(index); resolve(); };
                  state.releases.set(index, release);
                  state.release = release;
                });
                return { src: "data:image/png;base64,abc", width: 12, height: 20 };
              }
              finally { state.active--; }
            },
            cancel() {
              element.cancels++;
              state.hold = false;
              release?.();
              release = null;
            }
          } } }
        };
        state.browsers.push(element);
        return element;
      },
      documentElement: { appendChild(element) {
        if (!options.holdRendererLoad) queueMicrotask(() => element.loaded());
      } }
    }
  };
  const engine = new context.LibraryThumbnails({ Zotero: { debug() {} }, window, ...options });
  t.after(() => engine.destroy());
  const attachment = (id = 1) => ({
    id, attachmentContentType: "application/pdf", isAttachment: () => true,
    getFilePathAsync: async () => `/tmp/thumbnail-test-${id}.pdf`
  });
  return { engine, state, attachment };
}

test("PDF previews use the in-process renderer on every platform", async t => {
  const { engine, state, attachment } = fixture(t);
  const result = await engine.get(attachment());
  assert.equal(result.attachmentID, 1);
  assert.equal(state.reads, 1);
  assert.equal(state.renders, 1);
  assert.equal(state.renderOptions.mime, "application/pdf");
});

test("range-capable PDF renderers receive source metadata without a full-file read or clone", async t => {
  const { engine, state, attachment } = fixture(t, { localPDFRange: true });
  assert.ok((await engine.get(attachment(42)))?.src);
  assert.equal(state.reads, 0);
  assert.equal(state.renderOptions.path, "/tmp/thumbnail-test-42.pdf");
  assert.equal(state.renderOptions.size, 200);
  assert.equal(state.renderOptions.bytes, undefined);
  await engine.get({ ...attachment(43), attachmentContentType: "image/png" });
  assert.equal(state.reads, 1, "image attachments still supply their bytes");
  assert.ok(state.renderOptions.bytes instanceof Uint8Array);
  assert.equal(state.renderOptions.path, undefined);
});

test("three independent renderer lanes run concurrently, remain bounded, and reuse their documents", async t => {
  const { engine, state, attachment } = fixture(t);
  state.hold = true;
  const requests = Array.from({ length: 9 }, (_, index) => engine.get(attachment(index + 1)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.maxConcurrentRenders, 3);
  assert.equal(state.renders, 3);
  assert.equal(state.active, 3);
  assert.equal(state.browsers.length, 3);
  assert.equal(engine._queue.length, 6);
  for (const release of [...state.releases.values()]) release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.renders, 6);
  assert.equal(state.active, 3);
  assert.equal(state.browsers.length, 3, "each lane keeps its document and worker warm");
  state.hold = false;
  for (const release of [...state.releases.values()]) release();
  assert.ok((await Promise.all(requests)).every(result => result?.src));
  assert.equal(state.maxActive, 3, "a fourth document cannot render concurrently");
  assert.equal(state.browsers.length, 3);
  assert.ok(state.browsers.every(browser => browser.renders === 3));
  assert.equal(engine._pending.size, 0);
});

test("renderer concurrency can be restricted to one lane", async t => {
  const { engine, state, attachment } = fixture(t, { maxConcurrentRenders: 1 });
  state.hold = true;
  const requests = [engine.get(attachment(1)), engine.get(attachment(2))];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.active, 1);
  assert.equal(engine._queue.length, 1);
  state.hold = false;
  state.release();
  assert.ok((await Promise.all(requests)).every(result => result?.src));
  assert.equal(state.maxActive, 1);
  assert.equal(state.browsers.length, 1);
});

test("parallel lanes deduplicate parents and unrestricted consumers throughout an active render", async t => {
  const { engine, state, attachment } = fixture(t);
  const parent = id => ({ id, isAttachment: () => false, isRegularItem: () => true,
    getBestAttachment: async () => attachment(1) });
  state.hold = true;
  engine.setVisibleItems([101, 102]);
  const first = engine.get(parent(101), { visibleOnly: true });
  await new Promise(resolve => setImmediate(resolve));
  const second = engine.get(parent(102), { visibleOnly: true });
  const unrestricted = engine.get(attachment(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.renders, 1);
  assert.equal(state.reads, 1);
  assert.equal(engine._pending.size, 1);
  engine.setVisibleItems([]);
  state.hold = false;
  state.release();
  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.ok((await unrestricted)?.src);
  assert.equal(engine.peek(parent(101)).attachmentID, 1);
  assert.equal(engine.peek(parent(102)).attachmentID, 1);
  assert.equal(state.renders, 1);
});

test("queued shared previews survive one parent's cancellation and then an unrestricted join", async t => {
  const { engine, state, attachment } = fixture(t, { maxConcurrentRenders: 1 });
  const parent = id => ({ id, isAttachment: () => false, isRegularItem: () => true,
    getBestAttachment: async () => attachment(1) });
  state.hold = true;
  const active = engine.get(attachment(999));
  await new Promise(resolve => setImmediate(resolve));
  engine.setVisibleItems([101, 102]);
  const first = engine.get(parent(101), { visibleOnly: true });
  const second = engine.get(parent(102), { visibleOnly: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine._queue.length, 1);
  engine.setVisibleItems([102]);
  assert.equal(await first, null);
  assert.equal(engine._queue.length, 1);
  const unrestricted = engine.get(attachment(1));
  await new Promise(resolve => setImmediate(resolve));
  engine.setVisibleItems([]);
  assert.equal(await second, null);
  assert.equal(engine._queue.length, 1);
  state.hold = false;
  state.release();
  assert.ok((await active)?.src);
  assert.ok((await unrestricted)?.src);
  assert.equal(state.renders, 2);
});

test("scrolling promotes current viewport previews ahead of queued overscan", async t => {
  const { engine, state, attachment } = fixture(t, { maxConcurrentRenders: 1 });
  state.hold = true;
  const active = engine.get(attachment(999));
  await new Promise(resolve => setImmediate(resolve));
  engine.setVisibleItems([1, 2, 3], { priorityItems: [3] });
  const requests = [1, 2, 3].map(id => engine.get(attachment(id), { visibleOnly: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(engine._queue, job => job.attachmentID), [3, 1, 2]);
  engine.setVisibleItems([1, 2, 3], { priorityItems: [2] });
  state.hold = false;
  state.release();
  assert.ok((await Promise.all([active, ...requests])).every(result => result?.src));
  assert.deepEqual(state.readPaths.map(path => Number(path.match(/(\d+)\.pdf$/)[1])), [999, 2, 3, 1]);
});

test("clearing a collection cancels all active lanes and queued consumers before replacement work", async t => {
  const { engine, state, attachment } = fixture(t);
  state.hold = true;
  const requests = Array.from({ length: 6 }, (_, index) => engine.get(attachment(index + 1)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.active, 3);
  const oldBrowsers = [...state.browsers];
  engine.clearQueue();
  const replacement = engine.get(attachment(1));
  assert.ok((await Promise.all(requests)).every(result => result === null));
  assert.ok((await replacement)?.src);
  assert.ok(oldBrowsers.every(browser => browser.removed && browser.cancels === 1));
  assert.equal(state.renders, 4);
  assert.equal(engine._pending.size, 0);
  assert.equal(engine._queue.length, 0);
});

test("a timed-out lane resets its own document while other lanes complete normally", async t => {
  const { engine, state, attachment } = fixture(t);
  state.hold = true;
  const requests = Array.from({ length: 4 }, (_, index) => engine.get(attachment(index + 1)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.active, 3);
  const originalBrowsers = [...state.browsers];
  state.watchdogs[0].callback();
  assert.equal(await requests[0], null);
  assert.ok((await requests[3])?.src, "the reset lane services the next queued request");
  assert.equal(state.browsers.length, 4);
  assert.equal(originalBrowsers[0].cancels, 1);
  assert.ok(originalBrowsers[0].removed);
  assert.ok(originalBrowsers.slice(1).every(browser => !browser.removed && browser.cancels === 0));
  assert.equal(state.active, 2, "other active documents remain untouched");
  for (const release of [...state.releases.values()]) release();
  assert.ok((await Promise.all(requests.slice(1, 3))).every(result => result?.src));
  assert.equal(engine._pending.size, 0);
  assert.equal(state.maxActive, 3);
});

test("destroy cancels every lane and detaches renderer documents still waiting to load", async t => {
  const { engine, state, attachment } = fixture(t, { holdRendererLoad: true });
  const requests = [1, 2, 3].map(id => engine.get(attachment(id)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.browsers.length, 3);
  engine.destroy();
  assert.ok((await Promise.all(requests)).every(result => result === null));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(state.browsers.every(browser => browser.removed && browser.cancels === 1));
  assert.ok(engine._renderers.every(lane => !lane.browser && !lane.promise && !lane.cancelLoad && !lane.job));
  for (const browser of state.browsers) browser.loaded();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.renders, 0, "late load events cannot resurrect destroyed renderers");
  assert.equal(engine._pending.size, 0);
});

test("EPUB cover bytes use the image renderer and normal attachment caching", async t => {
  let extracted = 0;
  const coverBytes = new Uint8Array([5, 6, 7]);
  const { engine, state, attachment } = fixture(t, { epubExtract: async (file, { eligible }) => {
    extracted++;
    assert.equal(file, "/tmp/thumbnail-test-1.pdf");
    assert.ok(eligible());
    return { bytes: coverBytes, mime: "image/png" };
  } });
  const epub = { ...attachment(), attachmentContentType: "application/epub+zip" };
  const result = await engine.get(epub);
  assert.equal(result.attachmentID, 1);
  assert.equal(state.reads, 0, "the whole EPUB must not be read into memory");
  assert.equal(state.renderOptions.mime, "image/png");
  assert.equal(state.renderOptions.bytes, coverBytes);
  assert.equal((await engine.get(epub)).src, result.src);
  assert.equal(extracted, 1);
  state.modified++;
  await engine.get(epub);
  assert.equal(extracted, 2, "changed EPUB files invalidate the preview");
});

test("EPUBs with no cover stay placeholders without opening a renderer", async t => {
  const { engine, state, attachment } = fixture(t, { epubExtract: async () => null });
  assert.equal(await engine.get({ ...attachment(), attachmentContentType: "application/epub+zip" }), null);
  assert.equal(state.reads, 0);
  assert.equal(state.renders, 0);
  assert.ok(engine._renderers.every(lane => lane.browser === null));
});

test("cancelled EPUB extraction cannot start a stale image render", async t => {
  let release, stillEligible;
  const { engine, state, attachment } = fixture(t, { epubExtract: (file, { eligible }) => {
    stillEligible = eligible;
    return new Promise(resolve => { release = resolve; });
  } });
  const pending = engine.get({ ...attachment(), attachmentContentType: "application/epub+zip" });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  engine.clearQueue();
  assert.equal(await pending, null);
  assert.equal(stillEligible(), false);
  release({ bytes: new Uint8Array([5]), mime: "image/png" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.renders, 0);
  assert.ok(engine._renderers.every(lane => lane.browser === null));
});

test("deduplicates concurrent requests and refreshes when the file changes", async t => {
  const { engine, state, attachment } = fixture(t);
  const [first, duplicate] = await Promise.all([engine.get(attachment()), engine.get(attachment())]);
  assert.equal(state.renders, 1);
  assert.equal(first.src, duplicate.src);
  assert.equal(first.attachmentID, 1);
  await engine.get(attachment());
  assert.equal(state.reads, 1);
  state.modified++;
  await engine.get(attachment());
  assert.equal(state.renders, 2);
});

test("changing collections cancels active work and allows an immediate replacement request", async t => {
  const { engine, state, attachment } = fixture(t);
  state.hold = true;
  const cancelled = engine.get(attachment());
  while (!state.release) await new Promise(resolve => setImmediate(resolve));
  engine.clearQueue();
  const replacement = engine.get(attachment());
  assert.equal(await cancelled, null);
  assert.ok((await replacement)?.src);
  assert.equal(state.renders, 2);
  assert.equal(engine._pending.size, 0);
});

test("evicts least recently used previews and supports attachment invalidation", async t => {
  const { engine, state, attachment } = fixture(t, { maxEntries: 2 });
  await engine.get(attachment(1));
  await engine.get(attachment(2));
  await engine.get(attachment(1));
  await engine.get(attachment(3));
  await engine.get(attachment(1));
  assert.equal(state.renders, 3);
  await engine.get(attachment(2));
  assert.equal(state.renders, 4);
  engine.invalidate(2);
  await engine.get(attachment(2));
  assert.equal(state.renders, 5);
});

test("returns placeholders for unsupported, missing, oversized, or destroyed requests", async t => {
  const { engine, state, attachment } = fixture(t);
  assert.equal(await engine.get({ isAttachment: () => false, isRegularItem: () => false }), null);
  assert.equal(await engine.get({ ...attachment(), attachmentContentType: "application/epub+zip" }), null);
  assert.equal(await engine.get({ ...attachment(), getFilePathAsync: async () => false }), null);
  state.size = 256 * 1024 * 1024 + 1;
  assert.equal(await engine.get(attachment()), null);
  assert.equal(state.reads, 0);
  state.size = 200;
  const parent = { isAttachment: () => false, isRegularItem: () => true, getBestAttachment: async () => attachment() };
  assert.equal((await engine.get(parent)).attachmentID, 1);
  engine.destroy();
  assert.equal(await engine.get(attachment()), null);
});

test("rapid scrolling prunes old cards while preserving unrestricted requests", async t => {
  const { engine, state, attachment } = fixture(t, { maxConcurrentRenders: 1 });
  state.hold = true;
  const active = engine.get(attachment(999));
  while (!state.release) await new Promise(resolve => setImmediate(resolve));
  const unrestricted = engine.get(attachment(1000));
  const oldRequests = [];
  // Exceed the queue's 160-job capacity across successive viewports. Only the
  // current card should remain queued, even though its attachment has another ID.
  for (let id = 1; id <= 200; id++) {
    engine.setVisibleItems([id]);
    const parent = {
      id, isAttachment: () => false, isRegularItem: () => true,
      getBestAttachment: async () => attachment(id + 2000)
    };
    oldRequests.push(engine.get(parent, { visibleOnly: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(engine._queue.length <= 2, "offscreen jobs must not accumulate");
  }
  assert.ok((await Promise.all(oldRequests.slice(0, -1))).every(result => result === null));
  state.hold = false;
  state.release();
  assert.ok((await active)?.src);
  assert.equal((await unrestricted).attachmentID, 1000);
  assert.equal((await oldRequests.at(-1)).attachmentID, 2200);
  assert.equal(state.renders, 3);
  assert.equal(engine._pending.size, 0);
});

test("a card scrolled away during attachment lookup never enters the render queue", async t => {
  const { engine, state, attachment } = fixture(t);
  let release;
  engine.setVisibleItems([1]);
  const request = engine.get({
    id: 1, isAttachment: () => false, isRegularItem: () => true,
    getBestAttachment: () => new Promise(resolve => { release = resolve; })
  }, { visibleOnly: true });
  engine.setVisibleItems([2]);
  release(attachment(101));
  assert.equal(await request, null);
  assert.equal(state.reads, 0);
  assert.equal(engine._queue.length, 0);
});

test("finishing an offscreen active render preserves the preview for scroll-back", async t => {
  const { engine, state, attachment } = fixture(t);
  state.hold = true;
  engine.setVisibleItems([1]);
  const request = engine.get(attachment(1), { visibleOnly: true });
  while (!state.release) await new Promise(resolve => setImmediate(resolve));
  engine.setVisibleItems([]);
  state.hold = false;
  state.release();
  assert.equal(await request, null);
  engine.setVisibleItems([1]);
  assert.ok((await engine.get(attachment(1), { visibleOnly: true }))?.src);
  assert.equal(state.renders, 1, "completed work must survive scrolling away");
});

// A real checksummed PNG keeps the persistent-cache tests independent of Gecko
// while exercising the same binary validation used for cache files on macOS.
function testPNG(width = 12, height = 20) {
  const zlib = require('node:zlib');
  function chunk(type, payload) {
    const data = Buffer.concat([Buffer.from(type), payload]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(payload.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, data, tail]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),
    chunk('IDAT',zlib.deflateSync(Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}

function diskFixture(t, options = {}) {
  const state = { files: new Map(), renders: 0, diskReads: 0, writes: 0, modified: 1, failDisk: false,
    holdWrites: false, pendingWrites: [], writeOptions: [] };
  const png = testPNG();
  const missing = () => Object.assign(new Error('missing'), { name: 'NotFoundError' });
  const context = { Components: { utils: { cloneInto: value => value } }, IOUtils: {
    async makeDirectory() { if (state.failDisk) throw new Error('disk unavailable'); },
    async stat(path) {
      if (path.startsWith('/source/')) return { size: 200, lastModified: state.modified };
      const file = state.files.get(path); if (!file) throw missing();
      return { size: file.bytes.length, lastModified: file.modified };
    },
    async read(path) { const file=state.files.get(path);if(!file)throw missing();state.diskReads++;return new Uint8Array(file.bytes); },
    async write(path,bytes,settings) {
      if(state.failDisk)throw new Error('disk unavailable');
      state.writes++;state.writeOptions.push(settings);
      if(state.holdWrites)await new Promise(resolve=>state.pendingWrites.push(resolve));
      state.files.set(path,{bytes:new Uint8Array(bytes),modified:Date.now()});
    },
    async remove(path) { state.files.delete(path); },
    async getChildren() { return [...state.files.keys()]; },
    async setModificationTime(path) { const f=state.files.get(path);if(f)f.modified=Date.now(); }
  } };
  vm.createContext(context);vm.runInContext(source,context);
  const Zotero={ debug() {}, File: {pathToFileURI: path => 'file://' + path}, Profile:{dir:'/profile'}, Utilities:{Internal:{md5:value=>require('node:crypto').createHash('md5').update(value).digest('hex')}} };
  const window={setTimeout,clearTimeout,atob:value=>Buffer.from(value,'base64').toString('binary'),btoa:value=>Buffer.from(value,'binary').toString('base64')};
  const create=()=>{
    const engine=new context.LibraryThumbnails({Zotero,window,...options});
    engine._render=async job=>{state.renders++;return{src:'data:image/png;base64,'+png.toString('base64'),width:12,height:20,attachmentID:job.attachmentID};};
    t.after(()=>engine.destroy());return engine;
  };
  const attachment=(id=1)=>({id,attachmentContentType:'application/pdf',isAttachment:()=>true,getFilePathAsync:async()=>`/source/test${id}.pdf`});
  return {state,png,create,attachment};
}

test('persistent PNG cache survives engine recreation without invoking PDF rendering', async t => {
  const {state,create,attachment}=diskFixture(t);
  const first=create();const rendered=await first.get(attachment());
  assert.equal(state.renders,1);assert.equal(state.files.size,1);first.destroy();
  const second=create();const cached=await second.get(attachment());
  assert.equal(state.renders,1);assert.equal(state.diskReads,1);assert.equal(cached.src,rendered.src);
  assert.equal(cached.width,12);assert.equal(cached.height,20);assert.ok(second._renderers.every(lane=>lane.browser===null));
  await second.get(attachment());assert.equal(state.diskReads,1,'memory cache avoids another disk read');
});

test('changed source fingerprint misses disk cache and corrupted PNG regenerates', async t => {
  const {state,create,attachment}=diskFixture(t);
  let engine=create();await engine.get(attachment());engine.destroy();state.modified++;
  engine=create();await engine.get(attachment());assert.equal(state.renders,2);assert.equal(state.files.size,2);engine.destroy();
  const latest=[...state.files.values()].at(-1);latest.bytes[40]^=1;
  engine=create();const image=await engine.get(attachment());
  assert.ok(image?.src);assert.equal(state.renders,3,'CRC failure falls back to rendering');
  assert.ok(engine._pngDimensions([...state.files.values()].at(-1).bytes));
});

test('optional disk-cache failure leaves normal rendering and memory caching available', async t => {
  const {state,create,attachment}=diskFixture(t);state.failDisk=true;
  const engine=create();assert.ok((await engine.get(attachment()))?.src);
  assert.ok((await engine.get(attachment()))?.src);assert.equal(state.renders,1);assert.equal(state.files.size,0);
});

test('explicit disk limits bound count and bytes without age-based eviction', async t => {
  const {state,create,attachment,png}=diskFixture(t,{maxDiskEntries:2,maxDiskBytes:2*testPNG().length});
  const engine=create();await engine.get(attachment(1));await engine.get(attachment(2));await engine.get(attachment(3));
  const paths=[...state.files.keys()];const now=Date.now();
  state.files.get(paths[0]).modified=now-3*3600000;state.files.get(paths[1]).modified=now-2*3600000;state.files.get(paths[2]).modified=now-3600000;
  engine.clear();await engine.get(attachment(1));await engine._pruneDisk();
  assert.equal(state.files.size,2);assert.ok(state.files.has(paths[0]));assert.ok(state.files.has(paths[2]));
  assert.ok([...state.files.values()].reduce((sum,f)=>sum+f.bytes.length,0)<=2*png.length);
  state.files.get(paths[2]).modified=now-31*24*3600000;await engine._pruneDisk();assert.equal(state.files.size,2);
});

test('visible and unrestricted queued requests reuse the completed cached render', async t => {
  const {state,create,attachment}=diskFixture(t);const engine=create();engine.setVisibleItems([1]);
  const [visible,unrestricted]=await Promise.all([engine.get(attachment(),{visibleOnly:true}),engine.get(attachment())]);
  assert.ok(visible?.src&&unrestricted?.src);assert.equal(state.renders,1);
});

test('replacement work cannot reuse an atomic temporary file from a cancelled pending write', async t => {
  const { state, create, attachment } = diskFixture(t);
  const engine = create();
  state.holdWrites = true;
  const oldRequest = engine.get(attachment(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.pendingWrites.length, 1);
  engine.clearQueue();
  assert.equal(await oldRequest, null);
  const replacement = engine.get(attachment(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.pendingWrites.length, 2);
  assert.notEqual(state.writeOptions[0].tmpPath, state.writeOptions[1].tmpPath);
  assert.ok(state.writeOptions.every(options => /\/[0-9a-f]{32}\.png\.[a-z0-9]+\.tmp$/.test(options.tmpPath)));
  state.holdWrites = false;
  for (const release of state.pendingWrites) release();
  assert.ok((await replacement)?.src);
  assert.equal(engine._pending.size, 0);
  assert.equal(state.files.size, 1);
  assert.ok(engine.peek(attachment(1))?.src);
});

test('pruning removes only aged owned atomic-write leftovers', async t => {
  const {state,create,attachment}=diskFixture(t);const engine=create();await engine.get(attachment());
  const path=[...state.files.keys()][0];const bytes=testPNG();
  state.files.set(path+'.oldwriter.tmp',{bytes,modified:Date.now()-2*24*3600000});
  state.files.set(path+'.livewriter.tmp',{bytes,modified:Date.now()});
  state.files.set('/profile/cache/zoteroThumbLibrary/v1/unrelated.tmp',{bytes,modified:0});
  await engine._pruneDisk();
  assert.ok(!state.files.has(path+'.oldwriter.tmp'));assert.ok(state.files.has(path+'.livewriter.tmp'));
  assert.ok(state.files.has('/profile/cache/zoteroThumbLibrary/v1/unrelated.tmp'));
});

test('far-scroll cache references survive memory eviction and the former 1000-file disk limit', async t => {
  const { state, create, attachment } = diskFixture(t, { maxEntries: 2 });
  const engine = create();
  const first = await engine.get(attachment(1));
  for (let id = 2; id <= 1005; id++) await engine.get(attachment(id));
  const firstPath = [...state.files.keys()][0];
  state.files.get(firstPath).modified = Date.now() - 90 * 24 * 3600000;
  await engine._pruneDisk();
  assert.equal(state.files.size, 1005, 'previews below the default 2000-file limit are retained regardless of age');
  assert.ok(engine._cache.size <= 2, 'large libraries still have a bounded image cache');
  assert.equal(engine.peek(attachment(1)).src, first.src, 'ready file reference is available synchronously');
  await engine.get(attachment(1));
  assert.equal(state.renders, 1005, 'returning to the first attachment must not render it again');
  const reads = state.diskReads;
  await engine.get(attachment(1));
  assert.equal(state.diskReads, reads, 'validated references skip PNG reads and encoding');
  engine.destroy();
  const restarted = create();
  assert.ok((await restarted.get(attachment(1)))?.src);
  assert.equal(state.renders, 1005, 'first preview remains cached after a restart');
});

test('default disk cache retains 2000 previews and evicts the oldest unused preview at 2001', async t => {
  const { state, create, attachment } = diskFixture(t, { maxEntries: 2 });
  const engine = create();
  for (let id = 1; id <= 2000; id++) await engine.get(attachment(id));
  const paths = [...state.files.keys()];
  const old = Date.now() - 2 * 3600000;
  paths.forEach((path, index) => { state.files.get(path).modified = old + index; });
  await engine._pruneDisk();
  assert.equal(state.files.size, 2000, 'all previews fit at the default limit');

  await engine.get(attachment(1));
  assert.equal(state.renders, 2000, 'revisiting the oldest preview uses its cached PNG');
  assert.ok(state.files.get(paths[0]).modified > old + 2000, 'reuse updates its disk recency');
  await engine.get(attachment(2001));
  const latestPath = [...state.files.keys()].at(-1);
  await engine._pruneDisk();
  assert.equal(state.files.size, 2000, 'one preview is removed above the default limit');
  assert.ok(state.files.has(paths[0]), 'the recently reused preview survives');
  assert.ok(!state.files.has(paths[1]), 'the oldest unused preview is evicted');
  assert.ok(state.files.has(latestPath), 'the newly generated preview survives');
});

test('disk hits bypass an active slow PDF render and queued misses', async t => {
  const { state, create, attachment } = diskFixture(t, { maxConcurrentRenders: 1 });
  const seed = create();
  await seed.get(attachment(1));
  seed.destroy();
  const engine = create();
  const render = engine._render.bind(engine);
  let release;
  engine._render = async job => {
    if (job.attachmentID === 2) await new Promise(resolve => { release = resolve; });
    return render(job);
  };
  const slow = engine.get(attachment(2));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const queued = engine.get(attachment(3));
  let cached;
  const hit = engine.get(attachment(1)).then(result => { cached = result; });
  try {
    for (let i = 0; i < 10 && !cached; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(cached?.src, 'cached preview resolves before the held PDF render completes');
    assert.equal(state.renders, 1);
  }
  finally { release(); await Promise.all([slow, queued, hit]); }
});

test('disk lookup concurrency is bounded and collection changes cancel queued lookups', async t => {
  const { engine, state, attachment } = fixture(t);
  const releases = [];
  engine._readDisk = () => new Promise(resolve => { releases.push(resolve); });
  const pending = Array.from({ length: 20 }, (_, i) => engine.get(attachment(i + 1)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 4);
  assert.equal(engine._diskRunning, 4);
  engine.clearQueue();
  for (const release of releases) release(null);
  assert.ok((await Promise.all(pending)).every(result => result === null));
  assert.equal(state.renders, 0);
  assert.equal(engine._pending.size, 0);
  assert.equal(engine._diskQueue.length, 0);
});

test('removed or changed PNGs recover within the same session and invalidate ready references', async t => {
  const { state, create, attachment } = diskFixture(t);
  const engine = create();
  const first = await engine.get(attachment(1));
  const cachePath = [...state.files.keys()][0];
  state.files.delete(cachePath);
  assert.ok((await engine.get(attachment(1)))?.src);
  assert.equal(state.renders, 2, 'an externally removed PNG is regenerated');
  const file = state.files.get(cachePath);
  file.bytes[40] ^= 1;
  file.modified++;
  assert.ok((await engine.get(attachment(1)))?.src);
  assert.equal(state.renders, 3, 'changed cache files are checksummed and repaired');
  assert.ok(engine._pngDimensions(state.files.get(cachePath).bytes));
  state.modified++;
  const changed = await engine.get(attachment(1));
  assert.notEqual(changed.src.split('?')[0], first.src.split('?')[0]);
  assert.equal(engine.peek(attachment(1)), changed);
  engine.invalidate(1);
  assert.equal(engine.peek(attachment(1)), undefined);
});

test('ready parent references follow attachment invalidation and memory-only fallback stays bounded', async t => {
  const { engine, attachment } = fixture(t, { maxEntries: 1 });
  const parent = { id: 100, isAttachment: () => false, isRegularItem: () => true,
    getBestAttachment: async () => attachment(1) };
  await engine.get(parent);
  assert.equal(engine.peek(parent).attachmentID, 1);
  await engine.get(attachment(2));
  assert.equal(engine.peek(parent), undefined, 'evicted data strings cannot survive in ready index');
  await engine.get(parent);
  engine.invalidate(1);
  assert.equal(engine.peek(parent), undefined);
});
