const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../thumbnails.js"), "utf8");

// This harness exercises queue/cache/lifecycle logic. PDF pixel rendering is
// separately verified inside Zotero, which supplies Gecko and its PDF.js build.
function fixture(t, options = {}) {
  const state = { renders: 0, reads: 0, modified: 1, size: 200, hold: false, release: null, renderOptions: null };
  const context = {
    IOUtils: {
      stat: async () => ({ size: state.size, lastModified: state.modified }),
      read: async () => { state.reads++; return new Uint8Array([1, 2]); }
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
    setTimeout, clearTimeout,
    document: {
      createXULElement() {
        const listeners = new Map();
        const element = {
          style: {}, setAttribute() {}, remove() {},
          addEventListener(type, callback) { listeners.set(type, callback); },
          removeEventListener(type) { listeners.delete(type); },
          loaded() { listeners.get("load")?.(); },
          contentWindow: { wrappedJSObject: { LibraryThumbnailRenderer: {
            async render(options) {
              state.renderOptions = options;
              state.renders++;
              if (state.hold) await new Promise(resolve => { state.release = resolve; });
              return { src: "data:image/png;base64,abc", width: 12, height: 20 };
            },
            cancel() {
              state.hold = false;
              state.release?.();
              state.release = null;
            }
          } } }
        };
        return element;
      },
      documentElement: { appendChild(element) { queueMicrotask(() => element.loaded()); } }
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
  assert.equal(engine._browser, null);
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
  assert.equal(engine._browser, null);
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
  const { engine, state, attachment } = fixture(t);
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

test("finishing an offscreen active render does not cache an empty preview", async t => {
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
  assert.equal(state.renders, 2);
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
  const state = { files: new Map(), renders: 0, diskReads: 0, writes: 0, modified: 1, failDisk: false };
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
    async write(path,bytes) { if(state.failDisk)throw new Error('disk unavailable');state.writes++;state.files.set(path,{bytes:new Uint8Array(bytes),modified:Date.now()}); },
    async remove(path) { state.files.delete(path); },
    async getChildren() { return [...state.files.keys()]; },
    async setModificationTime(path) { const f=state.files.get(path);if(f)f.modified=Date.now(); }
  } };
  vm.createContext(context);vm.runInContext(source,context);
  const Zotero={ debug() {}, Profile:{dir:'/profile'}, Utilities:{Internal:{md5:value=>require('node:crypto').createHash('md5').update(value).digest('hex')}} };
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
  assert.equal(cached.width,12);assert.equal(cached.height,20);assert.equal(second._browser,null);
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

test('disk pruning bounds entry count, bytes, and stale entries using recent access', async t => {
  const {state,create,attachment,png}=diskFixture(t,{maxDiskEntries:2,maxDiskBytes:2*testPNG().length});
  const engine=create();await engine.get(attachment(1));await engine.get(attachment(2));await engine.get(attachment(3));
  const paths=[...state.files.keys()];const now=Date.now();
  state.files.get(paths[0]).modified=now-3*3600000;state.files.get(paths[1]).modified=now-2*3600000;state.files.get(paths[2]).modified=now-3600000;
  engine.clear();await engine.get(attachment(1));await engine._pruneDisk();
  assert.equal(state.files.size,2);assert.ok(state.files.has(paths[0]));assert.ok(state.files.has(paths[2]));
  assert.ok([...state.files.values()].reduce((sum,f)=>sum+f.bytes.length,0)<=2*png.length);
  state.files.get(paths[2]).modified=now-31*24*3600000;await engine._pruneDisk();assert.equal(state.files.size,1);
});

test('visible and unrestricted queued requests reuse the completed cached render', async t => {
  const {state,create,attachment}=diskFixture(t);const engine=create();engine.setVisibleItems([1]);
  const [visible,unrestricted]=await Promise.all([engine.get(attachment(),{visibleOnly:true}),engine.get(attachment())]);
  assert.ok(visible?.src&&unrestricted?.src);assert.equal(state.renders,1);
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
