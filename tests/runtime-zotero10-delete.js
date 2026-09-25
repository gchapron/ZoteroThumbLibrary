/* Run only in the project's guarded disposable Zotero test harness. */
if (!Zotero.Profile.dir.endsWith('/work/test-profile') || !Zotero.DataDirectory.dir.endsWith('/work/test-data')) throw new Error('Refusing to mutate a normal Zotero profile');
window=Zotero.getMainWindow();
const assert=(value,message)=>{if(!value)throw new Error(message);};
const wait=async(fn,label)=>{for(let i=0;i<160;i++){if(fn())return;await delay(50);}throw new Error('Timeout: '+label);};
const pane=window.ZoteroPane, ctl=window.ZoteroIconView, libraryID=Zotero.Libraries.userLibraryID;
assert(ctl.version==='0.1.6','Expected candidate0.1.6');
const collection=Zotero.Collections.getByLibrary(libraryID).filter(c=>c.name.startsWith('Grid Delete Integration ')).sort((a,b)=>b.id-a.id)[0];
const items=(await collection.getChildItems()).filter(i=>i.isRegularItem()).sort((a,b)=>a.getField('title').localeCompare(b.getField('title')));
assert(items.length===6,'Six fresh synthetic deletion targets');
const [parent,remove,forced,multi1,multi2,guard]=items;const child=Zotero.Items.get(parent.getAttachments()[0]);
const group=Zotero.Groups.getAll().find(g=>g.name==='Synthetic Read-only Tag Group');
const groupItem=(await Zotero.Items.getAll(group.libraryID))[0];
const allowedIDs=new Set([...items.map(i=>i.id),groupItem.id]);
let mode='cancel', calls=[], prompts=[], alerts=[];
const origPrompt=Services.prompt, origDelete=pane.deleteSelectedItems;
const checkSelection=()=>assert(pane.itemsView.getSelectedItems(true).every(id=>allowedIDs.has(id)),'Only synthetic item selected for test command');
const promptStub=new Proxy({}, {get(_,name){if(name==='confirm')return (_window,title,text)=>{checkSelection();prompts.push({title,text,accepted:mode==='accept'});return mode==='accept';};if(name==='alert')return (_window,title,text)=>{checkSelection();alerts.push({title,text});};const value=origPrompt[name];return typeof value==='function'?value.bind(origPrompt):value;}});
const send=(key='Backspace',options={},target=ctl.viewport)=>{const event=new window.KeyboardEvent('keydown',{key,code:key,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);return event;};
async function settle(){await wait(()=>!ctl.deleting,'Native delete command finished');await delay(100);}
async function context(kind,id){window.Zotero_Tabs.select('zotero-pane');if(kind==='library')await pane.collectionsView.selectLibrary(id);else await pane.collectionsView.selectCollection(id);await pane.clearQuicksearch();if(!ctl.enabled)ctl.toggle();ctl.refresh(true);await delay(150);ctl.refresh(true);}
async function select(...selected){await ctl.select(selected[0].id,{});for(const item of selected.slice(1))await ctl.select(item.id,{metaKey:true});assert(pane.itemsView.getSelectedItems(true).sort((a,b)=>a-b).join(',')===selected.map(i=>i.id).sort((a,b)=>a-b).join(','),'Native grid selection matches test items');}
try{
 Services.prompt=promptStub;assert(Services.prompt===promptStub&&window.Services.prompt===promptStub,'Scoped confirmation service installed');
 pane.deleteSelectedItems=async function(force){checkSelection();calls.push({force,ids:this.itemsView.getSelectedItems(true)});return await origDelete.call(this,force);};
 await context('collection',collection.id);await select(guard);
 let before=calls.length;send('Backspace',{repeat:true});send('Delete',{isComposing:true});await delay(100);assert(calls.length===before&&!guard.deleted&&guard.inCollection(collection.id),'Repeat and composition do not delete');
 const input=window.document.createElement('input');input.value='text';ctl.viewport.appendChild(input);send('Backspace',{},input);input.remove();assert(calls.length===before,'Editable field Backspace does not delete entry');
 // Plain library deletion first tests cancellation, then native Trash behavior.
 await context('library',libraryID);await select(parent);mode='cancel';let promptBefore=prompts.length;let event=send();assert(event.defaultPrevented,'Mac Backspace consumed');await settle();assert(!parent.deleted&&prompts.length===promptBefore+1&&!prompts.at(-1).accepted,'Native confirmation cancellation preserves entry');
 mode='accept';promptBefore=prompts.length;before=calls.length;event=send();const overlap=send();await settle();assert(calls.length===before+1,'In-flight second Delete cannot act on another item');assert(overlap.defaultPrevented,'Overlapping Delete consumed');assert(parent.deleted&&prompts.length===promptBefore+1,'Native accepted library Delete moves entry to Trash');assert(Zotero.Items.get(parent.id)&&Zotero.Items.get(child.id)&&await child.fileExists(),'Parent and attached PDF remain recoverable');assert(!ctl.items.some(i=>i.id===parent.id),'Trashed card disappears');assert(ctl.focusID!==parent.id&&ctl.anchor!==parent.id,'Focus and shift anchor no longer reference deleted card');
 await context('collection',collection.id);await select(remove);mode='accept';promptBefore=prompts.length;send();await settle();assert(!remove.inCollection(collection.id)&&!remove.deleted&&prompts.length===promptBefore+1,'Collection Backspace removes membership but retains library item');assert(!ctl.items.some(i=>i.id===remove.id),'Removed collection card disappears');
 await select(forced);promptBefore=prompts.length;send('Backspace',{metaKey:true});await settle();assert(forced.deleted&&prompts.length===promptBefore+1&&calls.at(-1).force,'Command-Backspace in collection prompts and trashes');
 await context('library',libraryID);await select(multi1,multi2);promptBefore=prompts.length;send('Delete');await settle();assert(multi1.deleted&&multi2.deleted&&prompts.length===promptBefore+1&&calls.at(-1).ids.length===2,'Forward Delete native multiple selection trashed together');
 await select(guard);promptBefore=prompts.length;send('Backspace',{metaKey:true});await settle();assert(guard.deleted&&prompts.length===promptBefore&&calls.at(-1).force,'Command-Backspace library uses native no-prompt behavior');
 await context('library',group.libraryID);await select(groupItem);before=calls.length;const alertBefore=alerts.length;send();await settle();assert(!groupItem.deleted&&calls.length===before+1&&alerts.length===alertBefore+1,'Native read-only group permission rejects deletion');
 await context('collection',collection.id);
 return {passed:true,zoteroVersion:Zotero.version,pluginVersion:ctl.version,platform:'macOS',profile:Zotero.Profile.dir,data:Zotero.DataDirectory.dir,checks:{macBackspace:true,forwardDelete:true,confirmationCancellation:true,confirmedLibraryTrash:true,parentAndPDFRecoverable:true,multipleSelection:true,collectionMembershipRemoval:true,commandDeleteCollectionTrash:true,commandDeleteLibrarySkipsPrompt:true,readOnlyNativePermission:true,autorepeatGuard:true,overlappingCommandGuard:true,compositionGuard:true,editableFieldGuard:true,cardRemovalRefresh:true,focusAndAnchorRepair:true},nativeDeleteCalls:calls.length,confirmationCount:prompts.length,readOnlyAlertCount:alerts.length,nativeImplementation:'ZoteroPane.deleteSelectedItems → itemsView.deleteSelection',confirmationHandling:'Only the confirmation service responses were controlled; the native deletion command, permissions, selection, and database operations ran unchanged.',fixtureItemIDs:items.map(i=>i.id),fixtureAttachmentID:child.id};
}finally{pane.deleteSelectedItems=origDelete;Services.prompt=origPrompt;}
