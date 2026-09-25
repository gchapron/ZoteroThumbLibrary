/*
 * Actual Zotero integration probe. Run only through a disposable-profile harness
 * supplying Zotero, window, IOUtils, PathUtils, and ROOT as async-function inputs.
 * ROOT must be a newly created /private/tmp/ziv-preview-runtime-* directory with
 * profile/, data/, and fixtures/000.pdf ... fixtures/219.pdf (distinct synthetic
 * one-page PDFs). The harness disables sync, automatic updates and word-processor
 * installers, loads the packaged plugin, writes the returned object, and quits.
 * This probe creates synthetic records only after verifying exact profile/data
 * isolation. It does not open Quick Look or read a normal profile/library.
 */
if (!ROOT.startsWith('/private/tmp/ziv-preview-runtime-') || Zotero.DataDirectory.dir !== ROOT + '/data' || PathUtils.profileDir !== ROOT + '/profile') throw new Error('Refusing personal profile');
const delay = ms => Zotero.Promise.delay(ms);
const assert = (value, text) => {if (!value) throw new Error(text);};
const wait = async (fn, text, limit=600) => {for(let i=0;i<limit;i++){if(await fn()) return;await delay(25);}throw new Error('Timeout: '+text);};
const ctl=window.ZoteroIconView;
if (ctl.enabled) ctl.toggle();
const libraryID=Zotero.Libraries.userLibraryID;
await Zotero.Libraries.get(Zotero.Libraries.userLibraryID).waitForDataLoad('item');
let collection=Zotero.Collections.getByLibrary(libraryID).find(c=>c.name==='Preview performance synthetic fixtures');
if(!collection){collection=new Zotero.Collection();collection.libraryID=libraryID;collection.name='Preview performance synthetic fixtures';await collection.saveTx();}
let parents=(await Zotero.Items.getAsync(collection.getChildItems(true))).filter(i=>i.isRegularItem()).sort((a,b)=>a.getField('title').localeCompare(b.getField('title')));
if(!parents.length){
 for(let i=0;i<220;i++){
  const item=new Zotero.Item('book');item.libraryID=libraryID;item.setField('title','Preview fixture '+String(i).padStart(3,'0'));item.setCollections([collection.id]);await item.saveTx();
  await Zotero.Attachments.linkFromFile({file:ROOT+'/fixtures/'+String(i).padStart(3,'0')+'.pdf',parentItemID:item.id,contentType:'application/pdf',title:'Synthetic PDF'});parents.push(item);
 }
}
assert(parents.length===220,'Fixture count');
await IOUtils.writeUTF8(ROOT+'/progress.json',JSON.stringify({phase:'benchmark',version:ctl.version}));
const Engine=ctl.engine.constructor;
function instrument(engine){const metrics={renders:0,diskReads:0,getCalls:0};for(const [method,key] of [['_render','renders'],['_readDisk','diskReads'],['get','getCalls']]){let original=engine[method];engine[method]=function(...args){metrics[key]++;return original.apply(this,args);};}return metrics;}
const timed=async(fn)=>{let start=window.performance.now();let results=await fn();return{ms:Math.round((window.performance.now()-start)*10)/10,images:results.filter(v=>v?.src).length};};
const count=96, sample=parents.slice(0,count);
let engine=new Engine({Zotero,window});
engine._diskDirectory=ROOT+'/profile/cache/ziv-benchmark-'+ctl.version;
await IOUtils.remove(engine._diskDirectory,{recursive:true,ignoreAbsent:true});
let metrics=instrument(engine);
let cold=await timed(()=>Promise.all(sample.map(item=>engine.get(item))));cold={...cold,...metrics};
assert(cold.images===count,'All cold PDF previews generated');
metrics.renders=metrics.diskReads=metrics.getCalls=0;
let memory=await timed(()=>Promise.all(sample.map(item=>engine.get(item))));memory={...memory,...metrics};
assert(memory.images===count&&memory.renders===0,'Memory reuse');
const diskDirectory=engine._diskDirectory;engine.destroy();
engine=new Engine({Zotero,window});engine._diskDirectory=diskDirectory;metrics=instrument(engine);
let disk=await timed(()=>Promise.all(sample.map(item=>engine.get(item))));disk={...disk,...metrics};
assert(disk.images===count&&disk.renders===0,'Persistent reuse');
const blockedEngine=new Engine({Zotero,window});blockedEngine._diskDirectory=diskDirectory;const blockedMetrics=instrument(blockedEngine);
let releaseRender, didStart=false;
const originalRender=blockedEngine._render;
blockedEngine._render=function(job){if(job.requestedItemID===parents[219].id){didStart=true;return new Promise(resolve=>{releaseRender=()=>resolve(null);});}return originalRender.call(this,job);};
const pendingCold=blockedEngine.get(parents[219]);await wait(()=>didStart,'Blocked cold job starts');
let warmFinished=false;let warmStart=window.performance.now();const pendingWarm=blockedEngine.get(parents[0]).then(result=>{warmFinished=!!result?.src;return result;});
await delay(150);const cachedWhileRendering={finishedBeforeRelease:warmFinished,waitedMS:Math.round(window.performance.now()-warmStart),...blockedMetrics};releaseRender();await Promise.all([pendingCold,pendingWarm]);blockedEngine.destroy();engine.destroy();
await IOUtils.writeUTF8(ROOT+'/progress.json',JSON.stringify({phase:'grid',cold,memory,disk,cachedWhileRendering}));
await window.ZoteroPane.collectionsView.selectCollection(collection.id);await window.ZoteroPane.clearQuicksearch();
if(!ctl.enabled)ctl.toggle();await delay(250);ctl.refresh(true);await wait(()=>ctl.items.length===parents.length&&ctl.viewport.clientHeight>0&&ctl.cards.size>0,'Grid ready');
const gridMetrics=instrument(ctl.engine);
const ready=()=>[...ctl.cards.values()].every(card=>card._previewReady&&card._preview.querySelector('img')?.naturalWidth>0);
await wait(ready,'Initial grid previews');
const firstID=ctl.items[0].id,initialCard=ctl.cards.get(firstID),initialImage=initialCard._preview.querySelector('img');
const initialDimensions={width:initialImage.naturalWidth,height:initialImage.naturalHeight};
let seen=new Set([...ctl.cards.keys()]);let step=Math.max(200,ctl.viewport.clientHeight-100),steps=0;const scrollStart=window.performance.now();
for(let top=step;top<ctl.canvas.scrollHeight;top+=step){ctl.viewport.scrollTop=top;ctl.render();await wait(ready,'Scrolled previews '+steps);for(let id of ctl.cards.keys())seen.add(id);steps++;}
const farScroll={steps,seenItems:seen.size,ms:Math.round(window.performance.now()-scrollStart),mountedCards:ctl.cards.size,detachedCards:ctl.detachedCards.size,engineEntries:ctl.engine._cache.size};
gridMetrics.renders=gridMetrics.diskReads=gridMetrics.getCalls=0;
const returnStart=window.performance.now();ctl.viewport.scrollTop=0;ctl.render();
const immediateImage=ctl.cards.get(firstID)?._preview.querySelector('img');
const immediate={hasImage:!!immediateImage,decoded:!!immediateImage?.naturalWidth,fileURL:immediateImage?.getAttribute('src')?.startsWith('file://'),versionedURL:/[?]v=/.test(immediateImage?.getAttribute('src')||''),sameCard:ctl.cards.get(firstID)===initialCard,sameImage:immediateImage===initialImage};
await wait(ready,'Top previews restored');
const returnToTop={...immediate,ms:Math.round((window.performance.now()-returnStart)*10)/10,...gridMetrics};
assert(cachedWhileRendering.finishedBeforeRelease,'Cached previews must not wait behind a cold render');
assert(returnToTop.hasImage&&returnToTop.fileURL&&returnToTop.versionedURL,'Warm previews must attach their local PNG immediately');
assert(returnToTop.renders===0&&returnToTop.diskReads===0,'Far-scroll return must not render or reread a loaded preview');
assert(seen.size===220,'All fixtures traversed beyond the image/card memory caps');
const result={passed:true,testedAt:new Date().toISOString(),version:Zotero.version,pluginVersion:ctl.version,mode:'headless Zotero with actual DOM/PDF.js renderer',fixture:'220 distinct tiny one-page synthetic PDFs with unique paths and bytes',profile:PathUtils.profileDir,data:Zotero.DataDirectory.dir,benchmark:{count,cold,memory,disk,cachedWhileRendering},grid:{initialDimensions,farScroll,returnToTop},noQuickLookInstalled:true};
ctl.toggle();return result;
