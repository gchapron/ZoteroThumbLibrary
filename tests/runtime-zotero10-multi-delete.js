/* Run only in the project's guarded disposable Zotero test harness. */
if (!Zotero.Profile.dir.endsWith('/work/test-profile') || !Zotero.DataDirectory.dir.endsWith('/work/test-data')) throw new Error('Refusing to mutate a normal Zotero profile');
window=Zotero.getMainWindow();
const assert=(v,m)=>{if(!v)throw new Error(m);};
const wait=async(fn,label)=>{for(let i=0;i<150;i++){if(fn())return;await delay(50);}throw new Error('Timeout: '+label);};
const pane=window.ZoteroPane,ctl=window.ZoteroIconView,lib=Zotero.Libraries.userLibraryID;
window.Zotero_Tabs.select('zotero-pane');
const group=Zotero.Groups.getAll().find(g=>g.name==='Synthetic Read-only Tag Group');
const groupItem=(await Zotero.Items.getAll(group.libraryID))[0];
const cols=['Z10 Multi Context Left','Z10 Multi Context Right'].map(name=>Zotero.Collections.getByLibrary(lib).find(c=>c.name===name));
let target=new Zotero.Item('book');target.setField('title','Z10 Multi Collection Delete '+Date.now());target.setCollections(cols.map(c=>c.id));await target.saveTx();
const allowed=new Set([target.id,groupItem.id]);
let prompts=0,alerts=0,calls=0,accept=true;
const originalPrompt=Services.prompt,originalDelete=pane.deleteSelectedItems;
const check=()=>assert(pane.itemsView.getSelectedItems(true).every(id=>allowed.has(id)),'Only authorized synthetic deletion targets');
const promptStub=new Proxy({}, {get(_,name){if(name==='confirm')return ()=>{check();prompts++;return accept;};if(name==='alert')return ()=>{check();alerts++;};let value=originalPrompt[name];return typeof value==='function'?value.bind(originalPrompt):value;}});
async function selectRows(ids){for(const id of ids){if(id[0]==='C')await pane.collectionsView.expandToCollection(+id.slice(1));else await pane.collectionsView.expandLibrary(+id.slice(1));}const sel=pane.collectionsView.selection;sel.selectEventsSuppressed=true;try{sel.clearSelection();for(const id of ids)sel.toggleSelect(pane.collectionsView.getRowIndexByID(id));sel.focused=pane.collectionsView.getRowIndexByID(ids.at(-1));}finally{sel.selectEventsSuppressed=false;}await wait(()=>pane.itemsView.collectionTreeRows.map(r=>r.id).sort().join(',')===ids.slice().sort().join(','),'Multiple collection context');await delay(180);ctl.refresh(true);}
const send=()=>ctl.viewport.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Backspace',code:'Backspace',bubbles:true,cancelable:true}));
try {
 Services.prompt=promptStub;pane.deleteSelectedItems=async function(force){check();calls++;return originalDelete.call(this,force);};
 await selectRows(cols.map(c=>'C'+c.id));await ctl.select(target.id,{});send();await wait(()=>!ctl.deleting,'Multiple collection Delete finished');await delay(150);
 assert(cols.every(c=>!target.inCollection(c.id))&&!target.deleted&&prompts===1&&calls===1,'Native Delete removes membership from both selected collections, preserving item');
 await selectRows(['L'+lib,'L'+group.libraryID]);await ctl.select(target.id,{});await ctl.select(groupItem.id,{metaKey:true});accept=false;const beforeCalls=calls;send();await wait(()=>!ctl.deleting,'Cross library Delete finished');await delay(100);
 assert(!target.deleted&&!groupItem.deleted&&calls===beforeCalls+1&&alerts===1&&prompts===1,'Native permission blocks cross-library selection containing read-only item: '+JSON.stringify({targetDeleted:target.deleted,groupDeleted:groupItem.deleted,calls,beforeCalls,alerts,prompts,selected:pane.itemsView.getSelectedItems(true)}));
 await pane.collectionsView.selectCollection(cols[0].id);await delay(100);ctl.refresh(true);
 return{passed:true,zoteroVersion:Zotero.version,pluginVersion:ctl.version,multiCollectionDeleteRemovesBothMemberships:true,itemRetainedInLibrary:true,mixedReadOnlyNativeDeleteRejected:true,nativeCalls:calls,confirmationCount:prompts,readOnlyAlertCount:alerts,fixtureItemID:target.id};
}finally{Services.prompt=originalPrompt;pane.deleteSelectedItems=originalDelete;}
