/* Run only in the project's guarded disposable Zotero test harness. */
if (!Zotero.Profile.dir.endsWith('/work/test-profile') || !Zotero.DataDirectory.dir.endsWith('/work/test-data')) throw new Error('Refusing to mutate a normal Zotero profile');
window=Zotero.getMainWindow();
const assert=(v,m)=>{if(!v)throw new Error(m);};
const wait=async(fn,label)=>{for(let i=0;i<150;i++){if(fn())return;await delay(50);}throw new Error('Timeout: '+label);};
const pane=window.ZoteroPane,ctl=window.ZoteroIconView,lib=Zotero.Libraries.userLibraryID;
window.Zotero_Tabs.select('zotero-pane');
const group=Zotero.Groups.getAll().find(g=>g.name==='Synthetic Read-only Tag Group');
let left=Zotero.Collections.getByLibrary(lib).find(c=>c.name==='Z10 Multi Context Left');
let right=Zotero.Collections.getByLibrary(lib).find(c=>c.name==='Z10 Multi Context Right');
for (const [which,name] of [['left','Z10 Multi Context Left'],['right','Z10 Multi Context Right']]) {if((which==='left'?left:right))continue;const c=new Zotero.Collection();c.name=name;await c.saveTx();if(which==='left')left=c;else right=c;}
let regular=[];
for(let n=0;n<2;n++){const c=[left,right][n];let item=(await c.getChildItems()).find(i=>i.isRegularItem());if(!item){item=new Zotero.Item('book');item.setField('title','Z10 Multi Context '+n);item.setCollections([c.id]);await item.saveTx();}item.removeTag('Fixture Red');await item.saveTx();regular.push(item);}
const groupItem=(await Zotero.Items.getAll(group.libraryID))[0];
async function selectRows(ids){
 for(const id of ids){if(id[0]==='C')await pane.collectionsView.expandToCollection(+id.slice(1));else await pane.collectionsView.expandLibrary(+id.slice(1));}
 const sel=pane.collectionsView.selection;sel.selectEventsSuppressed=true;
 try{sel.clearSelection();for(const id of ids){const index=pane.collectionsView.getRowIndexByID(id);assert(index!==false&&index!==undefined,'Native collection row exists '+id);sel.toggleSelect(index);}sel.focused=pane.collectionsView.getRowIndexByID(ids.at(-1));}finally{sel.selectEventsSuppressed=false;}
 await wait(()=>pane.itemsView.collectionTreeRows.map(r=>r.id).sort().join(',')===ids.slice().sort().join(','),'Native multiple collection context');
 await delay(180);await pane.clearQuicksearch();ctl.refresh(true);
}
const key=(n)=>{const event=new window.KeyboardEvent('keydown',{key:String(n),code:'Digit'+n,bubbles:true,cancelable:true});ctl.viewport.dispatchEvent(event);return event;};
if(!ctl.enabled)ctl.toggle();
await selectRows(['C'+left.id,'C'+right.id]);
await wait(()=>regular.every(i=>ctl.cards.has(i.id)),'Both collection cards');
assert(ctl.items.length===2,'Two selected collection rows show union of items');
await ctl.select(regular[0].id,{});await ctl.select(regular[1].id,{metaKey:true});key(1);await wait(()=>regular.every(i=>i.hasTag('Fixture Red')),'Native color shortcut in same-library multi-collection view');key(1);await wait(()=>regular.every(i=>!i.hasTag('Fixture Red')),'Native color toggle off');
const dt=new window.DataTransfer();const card=ctl.cards.get(regular[0].id);card.dispatchEvent(new window.DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));assert(dt.getData('zotero/item').split(',').length===2,'Multi-collection native drag includes both selected items');assert(Zotero.DragDrop.currentDragSource===pane.itemsView.collectionTreeRows[0],'Native first row drag source remains compatible');card.dispatchEvent(new window.DragEvent('dragend',{bubbles:true,dataTransfer:dt}));
await selectRows(['L'+lib,'L'+group.libraryID]);
await wait(()=>ctl.items.some(i=>i.id===groupItem.id),'Multi-library read-only card');
assert(ctl.items.every(i=>i instanceof Zotero.Item),'Library headers and spacer rows are not thumbnail items');
await ctl.select(regular[0].id,{});key(1);await delay(150);assert(!regular[0].hasTag('Fixture Red'),'Native colored shortcut disabled across libraries even selecting one editable item');
await ctl.select(groupItem.id,{metaKey:true});const selected=pane.itemsView.getSelectedItems(true);assert(selected.includes(groupItem.id)&&selected.includes(regular[0].id),'Cross-library multi selection includes editable and read-only items');
const oldUserTags=regular[0].getTags().map(x=>x.tag).sort().join('|'),oldGroupTags=groupItem.getTags().map(x=>x.tag).sort().join('|');key(0);key(1);await delay(150);assert(oldUserTags===regular[0].getTags().map(x=>x.tag).sort().join('|')&&oldGroupTags===groupItem.getTags().map(x=>x.tag).sort().join('|'),'Mixed editable/read-only library selection leaves tags unchanged');
const rows=pane.itemsView.collectionTreeRows.map(r=>({id:r.id,editable:r.editable,libraryID:r.ref?.libraryID}));
await pane.collectionsView.selectCollection(left.id);await delay(150);ctl.refresh(true);await wait(()=>ctl.items.length===1&&ctl.items[0].id===regular[0].id,'Single context refresh after combined libraries');
return {passed:true,zoteroVersion:Zotero.version,pluginVersion:ctl.version,multiCollectionUnion:true,sameLibraryColoredKeys:true,nativeMultiCollectionDrag:true,multiLibraryUnion:true,headerRowsExcluded:true,crossLibrarySelection:true,multiLibraryColoredKeysDisabled:true,mixedReadonlyTagsUnchanged:true,contextSwitchRefresh:true,rows};
