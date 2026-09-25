/* Companion restart/revalidation check for runtime-preview-performance.js.
 * Run in the same guarded disposable harness after quitting and relaunching
 * Zotero. This checks actual persistent-cache survival and alters/restores only
 * the synthetic fixture 000.pdf and a PNG under the dedicated test profile.
 */
if (!ROOT.startsWith('/private/tmp/ziv-preview-runtime-') || Zotero.DataDirectory.dir !== ROOT+'/data' || PathUtils.profileDir !== ROOT+'/profile') throw new Error('Unsafe profile');
const assert=(v,s)=>{if(!v)throw new Error(s);};const ctl=window.ZoteroIconView;if(ctl.enabled)ctl.toggle();
await Zotero.Libraries.get(Zotero.Libraries.userLibraryID).waitForDataLoad('item');
const collection=Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID).find(c=>c.name==='Preview performance synthetic fixtures');
const parents=(await Zotero.Items.getAsync(collection.getChildItems(true))).filter(i=>i.isRegularItem()).sort((a,b)=>a.getField('title').localeCompare(b.getField('title')));
const engine=new ctl.engine.constructor({Zotero,window});let renders=0;const render=engine._render;engine._render=function(...args){renders++;return render.apply(this,args);};
const start=window.performance.now();const values=[];for(let i=0;i<parents.length;i+=120)values.push(...await Promise.all(parents.slice(i,i+120).map(p=>engine.get(p))));
const restart={images:values.filter(v=>v?.src).length,ms:Math.round((window.performance.now()-start)*10)/10,renders,rendererCreated:!!engine._browser};await IOUtils.writeUTF8(ROOT+'/restart-progress.json',JSON.stringify(restart));assert(restart.images===220&&renders===0&&!engine._browser,'Persistent cache survived actual restart');
const image=new window.Image();image.src=values[0].src;await image.decode();assert(image.naturalWidth===360&&image.naturalHeight===466,'PNG file URL decoded');
const fixturePath=ROOT+'/fixtures/000.pdf',original=await IOUtils.read(fixturePath);let sourceChanged;
try {
 const changed=new window.TextEncoder().encode(new window.TextDecoder().decode(original).replace('Preview fixture 000','Preview fixture CHG'));assert(changed.length===original.length,'Same-size fixture change');
 await IOUtils.write(fixturePath,changed);const before=renders;const changedResult=await engine.get(parents[0]);sourceChanged={renders:renders-before,changedURI:changedResult.src!==values[0].src};assert(sourceChanged.renders===1&&sourceChanged.changedURI,'Source mtime revalidates cached preview');
 const cachePath=decodeURIComponent(new window.URL(changedResult.src).pathname);assert(cachePath.startsWith(ROOT+'/profile/cache/zoteroThumbLibrary/'),'Disposable cached PNG only');
 await IOUtils.remove(cachePath);const beforeDeletion=renders;const recovered=await engine.get(parents[0]);const missingCache={renders:renders-beforeDeletion,recovered:!!recovered?.src};assert(missingCache.renders===1&&missingCache.recovered,'Removed cached file regenerates');
 engine.destroy();return{passed:true,testedAt:new Date().toISOString(),version:Zotero.version,pluginVersion:ctl.version,restart,sourceChanged,missingCache,fileURIImage:{width:image.naturalWidth,height:image.naturalHeight},quickLookInvoked:false};
} finally {await IOUtils.write(fixturePath,original);engine.destroy();}
