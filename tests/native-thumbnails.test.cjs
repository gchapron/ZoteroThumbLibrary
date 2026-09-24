const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../native-thumbnails.js'),'utf8');
const flush = () => new Promise(resolve=>setImmediate(resolve));
function fixture(options={}) {
  let state={calls:[],removed:[],created:[],kills:0,reads:0,decoded:0,draws:[],canvases:[],drained:0};
  const png=new Uint8Array(33);
  png.set([137,80,78,71,13,10,26,10]);png[11]=13;png.set([73,72,68,82],12);
  const data=new DataView(png.buffer);data.setUint32(16,370);data.setUint32(20,480);
  let finishExit,finishSpawn;
  const proc={exitCode:null,stdin:{close:async()=>{if(options.stdinFailure)throw Error("already closed");}},stdout:{read:async()=>{state.drained++;return new ArrayBuffer(state.drained===1?30:0);}},
    wait:()=>options.hang?new Promise(resolve=>{finishExit=resolve;}):Promise.resolve((proc.exitCode=options.exitCode||0,{exitCode:proc.exitCode})),
    kill:async()=>{state.kills++;proc.exitCode=-9;finishExit?.({exitCode:-9});return {exitCode:-9};}};
  const Subprocess={ERROR_BAD_EXECUTABLE:1,call:async args=>{state.calls.push(args);if(options.unavailable)throw{errorCode:1};if(options.holdSpawn)return new Promise(resolve=>{finishSpawn=resolve;});return proc;}};
  class Image {
    constructor(){this.naturalWidth=370;this.naturalHeight=480;}
    async decode(){state.decoded++;if(options.badPNG)throw Error('bad PNG');}
    removeAttribute(){}
  }
  const window={setTimeout,clearTimeout,Image,btoa:s=>Buffer.from(s,'binary').toString('base64'),document:{createElementNS:()=>{
    const canvas={width:0,height:0,getContext:()=>({fillRect(){},drawImage:(_img,_x,_y,w,h)=>state.draws.push({width:w,height:h})}),toDataURL:()=> 'data:image/png;base64,normalized'};
    state.canvases.push(canvas);return canvas;
  }}};
  const context={ChromeUtils:{importESModule:()=>({Subprocess})},PathUtils:{isAbsolute:path.posix.isAbsolute,join:path.posix.join,parent:path.posix.dirname},IOUtils:{
    makeDirectory:async(dir,opts)=>{state.created.push({dir,opts});if(options.existing)throw Error('exists');},
    getChildren:async dir=>[dir+'/文 件 --file.pdf.png'],
    stat:async()=>({size:options.oversize?5*1024*1024:png.length}),
    read:async()=>{state.reads++;return options.badSignature?new Uint8Array(40):png;},
    remove:async(dir,opts)=>{assert.notEqual(proc.exitCode,null,'Process must exit before deleting native output');state.removed.push({dir,opts});}
  }};
  // If no process was ever launched, removing its owned temporary folder is safe.
  context.IOUtils.remove=async(dir,opts)=>{if(state.calls.length&&!options.unavailable)assert.notEqual(proc.exitCode,null);state.removed.push({dir,opts});};
  vm.createContext(context);vm.runInContext(source,context);
  const adapter=new context.LibraryNativeThumbnails({Zotero:{isMac:options.mac!==false,Utilities:{randomString:()=> 'abc123unique'},getTempDirectory:()=>({path:'/private/tmp/org.zotero.zotero'})},window,timeoutMS:options.timeoutMS||1000});
  const request={path:'/tmp/文 件/--option-looking name.pdf',mime:'application/pdf',maxWidth:360,maxHeight:480};
  return {adapter,state,request,finishSpawn:()=>finishSpawn?.(proc),settled:async()=>{await Promise.all([...adapter._jobs].map(job=>job.done));}};
}

test('native adapter passes absolute Unicode/spaced paths as one argument without a shell',async()=>{
  const {adapter,state,request}=fixture();const result=await adapter.render(request);
  assert.equal(state.calls.length,1);assert.equal(state.calls[0].command,'/usr/bin/qlmanage');
  assert.equal(state.calls[0].arguments.at(-1),request.path);assert.equal(state.calls[0].arguments.length,6);
  assert.equal(state.created[0].opts.permissions,0o700);assert.equal(state.created[0].opts.ignoreExisting,false);
  assert.equal(result.width,360);assert.equal(result.height,467);
  assert.equal(state.decoded,1);assert.equal(state.drained,2);
  assert.equal(state.removed.length,1);assert.equal(state.removed[0].dir,state.created[0].dir);
  assert.equal(state.canvases[0].width,0);assert.equal(state.canvases[0].height,0);
});

test('unsupported platform, MIME and unsafe input paths immediately return fallback',async()=>{
  const a=fixture({mac:false});assert.equal(await a.adapter.render(a.request),null);assert.equal(a.state.calls.length,0);
  const b=fixture();for(const change of [{mime:'image/png'},{path:'--relative.pdf'},{path:'/tmp/a\0b.pdf'}])assert.equal(await b.adapter.render({...b.request,...change}),null);
  assert.equal(b.state.calls.length,0);
});

test('failed, corrupt and oversized native previews return fallback and clean owned output',async()=>{
  for(const options of [{exitCode:1},{badPNG:true},{badSignature:true},{oversize:true}]){
    const f=fixture(options);assert.equal(await f.adapter.render(f.request),null);assert.equal(f.state.removed.length,1);
  }
});

test('an existing temporary directory is never treated as owned or deleted',async()=>{
  const f=fixture({existing:true});assert.equal(await f.adapter.render(f.request),null);
  assert.equal(f.state.calls.length,0);assert.equal(f.state.removed.length,0);
});

test('timeout kills the native process before owned-directory cleanup',async()=>{
  const f=fixture({hang:true,timeoutMS:10});assert.equal(await f.adapter.render(f.request),null);
  await f.settled();assert.ok(f.state.kills>=1);assert.equal(f.state.removed.length,1);
});

test('cancel and destroy promptly suppress output and terminate native work',async()=>{
  const f=fixture({hang:true});const pending=f.adapter.render(f.request);await flush();
  f.adapter.cancel();assert.equal(await pending,null);await f.settled();assert.ok(f.state.kills>=1);
  f.adapter.destroy();assert.equal(await f.adapter.render(f.request),null);assert.equal(f.state.calls.length,1);
});

test('cancellation during asynchronous process creation still kills the late child',async()=>{
  const f=fixture({holdSpawn:true});const pending=f.adapter.render(f.request);await flush();
  f.adapter.cancel();assert.equal(await pending,null);assert.equal(f.state.removed.length,0);
  f.finishSpawn();await f.settled();assert.ok(f.state.kills>=1);assert.equal(f.state.removed.length,1);
});

test('missing system executable disables repeated native attempts and retains fallback',async()=>{
  const f=fixture({unavailable:true});assert.equal(await f.adapter.render(f.request),null);assert.equal(await f.adapter.render(f.request),null);
  assert.equal(f.state.calls.length,1);assert.equal(f.state.removed.length,1);
});


test('an already-closed stdin pipe does not reject a valid native preview',async()=>{
  const f=fixture({stdinFailure:true});assert.ok(await f.adapter.render(f.request));assert.equal(f.state.removed.length,1);
});
