/* Actual Zotero performance/regression probe. Disposable synthetic-only profile.
 * ROOT/fixtures must contain480 distinct image/vector five-page PDFs plus large.pdf.
 * Use the same inputs and bootstrap as runtime-preview-performance.js.
 * Unlike the older probe this measures creation/decoding of DOM images as well
 * as thumbnail-engine reads. A memory-pressure notification tests Gecko's native
 * decoded-image eviction. This deliberately does not claim naturalWidth proves
 * retained decoded pixels. The first visible image has an imgI observer attached.
 */
if (!ROOT.startsWith('/private/tmp/ziv-preview-runtime-') || Zotero.DataDirectory.dir !== ROOT+'/data' || PathUtils.profileDir !== ROOT+'/profile') throw new Error('Refusing personal profile');
const delay=ms=>Zotero.Promise.delay(ms),now=()=>window.performance.now();
const wait=async(fn,message,limit=2400)=>{for(let i=0;i<limit;i++){if(await fn())return;await delay(25);}throw new Error('Timeout: '+message);};
const ctl=window.ZoteroIconView;if(ctl.enabled)ctl.toggle();
const libraryID=Zotero.Libraries.userLibraryID;await Zotero.Libraries.get(libraryID).waitForDataLoad('item');
let collection=Zotero.Collections.getByLibrary(libraryID).find(c=>c.name==='Rich synthetic preview fixtures');
if(!collection){collection=new Zotero.Collection();collection.libraryID=libraryID;collection.name='Rich synthetic preview fixtures';await collection.saveTx();}
let parents=(await Zotero.Items.getAsync(collection.getChildItems(true))).filter(i=>i.isRegularItem()).sort((a,b)=>a.getField('title').localeCompare(b.getField('title')));
if(parents.length!==481){
 if(parents.length)throw new Error('Partial fixture collection');
 for(let i=0;i<481;i++){
  const item=new Zotero.Item('book');item.libraryID=libraryID;item.setField('title','Rich synthetic fixture '+String(i).padStart(3,'0'));item.setCollections([collection.id]);await item.saveTx();
  await Zotero.Attachments.linkFromFile({file:ROOT+'/fixtures/'+(i===480?'large':String(i).padStart(3,'0'))+'.pdf',parentItemID:item.id,contentType:'application/pdf',title:'Synthetic PDF'});parents.push(item);
  if(i%40===0)await IOUtils.writeUTF8(ROOT+'/progress.json',JSON.stringify({phase:'import',items:i}));
 }
}
const fixtureMeta=JSON.parse(await IOUtils.readUTF8(ROOT+'/fixtures-meta.json'));
const Engine=ctl.engine.constructor;
let sourceIO={readCalls:0,bytes:0,available:false},sourceRestores=[];
const ioTargets=new Set();
function trackIO(io){
 if(!io||ioTargets.has(io))return;ioTargets.add(io);
 const original=io.read;
 const wrapped=async function(path,...args){const bytes=await original.call(io,path,...args);if(String(path).startsWith(ROOT+'/fixtures/')){sourceIO.readCalls++;sourceIO.bytes+=bytes.byteLength;}return bytes;};
 try{io.read=wrapped;if(io.read===wrapped){sourceIO.available=true;sourceRestores.push(()=>io.read=original);}}catch(_){}
}
trackIO(IOUtils);
function instrument(engine){
 const metrics={renders:0,diskReads:0,getCalls:0,peakConcurrentRenders:0,activeRenders:0};
 for(const [method,key]of [['_readDisk','diskReads'],['get','getCalls']]){const old=engine[method];engine[method]=function(...args){metrics[key]++;return old.apply(this,args);};}
 const render=engine._render;engine._render=async function(...args){metrics.renders++;metrics.activeRenders++;metrics.peakConcurrentRenders=Math.max(metrics.peakConcurrentRenders,metrics.activeRenders);try{return await render.apply(this,args);}finally{metrics.activeRenders--;}};
 const getRenderer=engine._getRenderer;engine._getRenderer=async function(...args){const rw=await getRenderer.apply(this,args);trackIO(rw.wrappedJSObject.IOUtils);return rw;};return metrics;
}
const benchmark=[];
for(const concurrency of [1,3]){
 const engine=new Engine({Zotero,window,maxConcurrentRenders:concurrency});engine._diskDirectory=ROOT+'/profile/cache/rich-'+ctl.version+'-'+concurrency;
 await IOUtils.remove(engine._diskDirectory,{recursive:true,ignoreAbsent:true});const metrics=instrument(engine);sourceIO={readCalls:0,bytes:0,available:sourceIO.available};
 await IOUtils.writeUTF8(ROOT+'/progress.json',JSON.stringify({phase:'benchmark',concurrency,version:ctl.version}));
 const start=now();const images=await Promise.all(parents.slice(0,96).map(item=>engine.get(item)));
 const result={requestedConcurrency:concurrency,count:96,ms:Math.round(now()-start),images:images.filter(v=>v?.src).length,...metrics,sourceIO:{...sourceIO}};
 const bigStart=now();sourceIO={readCalls:0,bytes:0,available:sourceIO.available};const big=await engine.get(parents[480]);result.largePDF={ms:Math.round(now()-bigStart),image:!!big?.src,totalFileBytes:fixtureMeta.largeBytes,sourceIO:{...sourceIO}};
 engine.destroy();benchmark.push(result);
}
await window.ZoteroPane.collectionsView.selectCollection(collection.id);await window.ZoteroPane.clearQuicksearch();
// Hide the large attachment for the scroll traversal; it is separately benchmarked.
const large=parents[480];large.setCollections([]);await large.saveTx();
if(!ctl.enabled)ctl.toggle();await delay(250);ctl.refresh(true);
await wait(()=>ctl.items.length===480&&ctl.viewport.clientHeight>0&&ctl.cards.size>0,'Grid ready');
const gridMetrics=instrument(ctl.engine),imageMetrics={created:0,loads:0,decodeCalls:0};
const thumbnailImage=ctl.thumbnailImage;ctl.thumbnailImage=function(...args){const img=thumbnailImage.apply(this,args);imageMetrics.created++;img.addEventListener('load',()=>imageMetrics.loads++);const decode=img.decode;img.decode=function(...decodeArgs){imageMetrics.decodeCalls++;return decode.apply(this,decodeArgs);};return img;};
const ready=()=>[...ctl.cards.values()].every(card=>card._previewReady&&card._preview.querySelector('img')?.naturalWidth>0);
await wait(ready,'Initial grid previews');
const firstID=ctl.items[0].id,firstCard=ctl.cards.get(firstID),firstImage=firstCard._preview.querySelector('img');
const nativeEvents={};let observer,observerError=null;
try{const callbacks={};for(const name of ['sizeAvailable','frameUpdate','frameComplete','loadComplete','decodeComplete','discard','isAnimated','hasTransparency'])callbacks[name]=()=>nativeEvents[name]=(nativeEvents[name]||0)+1;observer=Cc['@mozilla.org/image/tools;1'].getService(Ci.imgITools).createScriptedObserver(callbacks);firstImage.addObserver(observer);}catch(e){observerError=String(e);}
const pixelSnapshot=img=>{const canvas=window.document.createElementNS('http://www.w3.org/1999/xhtml','canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const context=canvas.getContext('2d');const start=now();context.drawImage(img,0,0);const bytes=context.getImageData(0,0,canvas.width,canvas.height).data;let checksum=0;for(let i=0;i<bytes.length;i++)checksum=(Math.imul(checksum,31)+bytes[i])>>>0;return{checksum,ms:Math.round((now()-start)*100)/100,width:canvas.width,height:canvas.height};};
const initialPixels=pixelSnapshot(firstImage);
const nativeStatus=()=>{try{return firstImage.getRequest(Ci.nsIImageLoadingContent.CURRENT_REQUEST).imageStatus;}catch(e){return String(e);}};
const statusInitial=nativeStatus();let seen=new Set(ctl.cards.keys()),steps=0,step=Math.max(200,ctl.viewport.clientHeight-100);const scrollStart=now();
for(let top=step;top<ctl.canvas.scrollHeight;top+=step){ctl.viewport.scrollTop=top;ctl.render();await wait(ready,'Scrolled previews '+steps);for(const id of ctl.cards.keys())seen.add(id);steps++;if(steps%12===0)await IOUtils.writeUTF8(ROOT+'/progress.json',JSON.stringify({phase:'scroll',seen:seen.size,steps}));}
const farScroll={ms:Math.round(now()-scrollStart),steps,seenItems:seen.size,mountedCards:ctl.cards.size,detachedCards:ctl.detachedCards.size,previewImages:ctl.previewImages?.size,lockedPreviewImages:ctl.lockedPreviewImages?.size,lockedPreviewBytes:ctl.lockedPreviewBytes,...imageMetrics,statusInitial,statusAfterScroll:nativeStatus(),nativeEvents:{...nativeEvents}};
const startCounters={...imageMetrics};const startGridCounters={...gridMetrics};sourceIO={readCalls:0,bytes:0,available:sourceIO.available};
const pressureStart=now();Services.obs.notifyObservers(null,'memory-pressure','heap-minimize');await delay(150);
const pressure={ms:Math.round(now()-pressureStart),status:nativeStatus(),nativeEvents:{...nativeEvents}};
const returnStart=now();ctl.viewport.scrollTop=0;ctl.render();const returnedCard=ctl.cards.get(firstID),returnedImage=returnedCard?._preview.querySelector('img');
const immediate={sameCard:returnedCard===firstCard,sameImage:returnedImage===firstImage,hasImage:!!returnedImage,imageComplete:returnedImage?.complete,naturalWidth:returnedImage?.naturalWidth,src:returnedImage?.getAttribute('src')?.slice(0,30)};
await wait(ready,'Return previews');const returnedPixels=pixelSnapshot(returnedImage);await delay(100);
const returnToTop={...immediate,initialPixels,returnedPixels,identicalPixels:initialPixels.checksum===returnedPixels.checksum,ms:Math.round(now()-returnStart),created:imageMetrics.created-startCounters.created,loads:imageMetrics.loads-startCounters.loads,decodeCalls:imageMetrics.decodeCalls-startCounters.decodeCalls,renders:gridMetrics.renders-startGridCounters.renders,diskReads:gridMetrics.diskReads-startGridCounters.diskReads,getCalls:gridMetrics.getCalls-startGridCounters.getCalls,sourceIO:{...sourceIO},nativeEvents:{...nativeEvents}};
if(observer)try{firstImage.removeObserver(observer);}catch(_){}
ctl.thumbnailImage=thumbnailImage;
for(const restore of sourceRestores.reverse())restore();
large.setCollections([collection.id]);await large.saveTx();
ctl.toggle();
const pinnedRecords=[...(ctl.lockedPreviewImages?.values()||[])];ctl.destroy();
const afterDestroy={previewImages:ctl.previewImages?.size,lockedPreviewImages:ctl.lockedPreviewImages?.size,lockedPreviewBytes:ctl.lockedPreviewBytes,releasedRequests:pinnedRecords.filter(record=>record.lockRequest===null).length,previouslyPinned:pinnedRecords.length};
const expectedRetainedImages=!!ctl.previewImages;
const passed=returnToTop.identicalPixels&&(!expectedRetainedImages||(returnToTop.sameImage&&returnToTop.created===0&&returnToTop.loads===0&&returnToTop.decodeCalls===0&&farScroll.lockedPreviewImages>0&&afterDestroy.lockedPreviewImages===0&&afterDestroy.lockedPreviewBytes===0&&afterDestroy.releasedRequests===afterDestroy.previouslyPinned));
return{passed,testedAt:new Date().toISOString(),zoteroVersion:Zotero.version,pluginVersion:ctl.version,mode:'headless Zotero actual DOM and PDF.js; isolated synthetic library',fixtureMeta,benchmark,grid:{farScroll,pressure,returnToTop,observerError,afterDestroy}};
