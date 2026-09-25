/* Run only in the project's guarded disposable Zotero test harness. */
if (!Zotero.Profile.dir.endsWith('/work/test-profile') || !Zotero.DataDirectory.dir.endsWith('/work/test-data')) throw new Error('Refusing to mutate a normal Zotero profile');
window=Zotero.getMainWindow();const assert=(v,m)=>{if(!v)throw new Error(m);};
const wait=async(fn,label)=>{for(let i=0;i<100;i++){if(fn())return;await delay(50);}throw new Error('Timeout: '+label);};
const libraryID=Zotero.Libraries.userLibraryID,red='Fixture Red',blue='Fixture Blue',targetName='Fixture Drop Target';
const collection=Zotero.Collections.getByLibrary(libraryID).find(c=>c.name==='Grid Tag Integration Fixtures');
const items=(await collection.getChildItems()).filter(i=>i.isRegularItem()).sort((a,b)=>a.getField('title').localeCompare(b.getField('title')));const [a,b,c]=items;
for(const item of [a,b]){for(const tag of [red,blue,targetName])item.removeTag(tag);await item.saveTx();}
window.Zotero_Tabs.select('zotero-pane');await window.ZoteroPane.collectionsView.selectCollection(collection.id);await window.ZoteroPane.clearQuicksearch();
window.document.getElementById('zotero-tag-selector-container').setAttribute('collapsed','false');
if(!window.ZoteroPane.tagSelector)await window.ZoteroPane.initTagSelector();
const ctl=window.ZoteroIconView;if(!ctl.enabled)ctl.toggle();await delay(250);ctl.refresh(true);await wait(()=>ctl.items.length===3&&ctl.cards.has(c.id),'Tag fixture cards');
const key=(number,options={})=>{const e=new window.KeyboardEvent('keydown',{key:String(number),code:'Digit'+number,bubbles:true,cancelable:true,...options});ctl.viewport.dispatchEvent(e);return e;};
const selected=()=>ctl.view.getSelectedItems(true).sort((x,y)=>x-y);
const expected=[a.id,b.id].sort((x,y)=>x-y);
await ctl.select(a.id,{});await ctl.select(b.id,{metaKey:true});assert(JSON.stringify(selected())===JSON.stringify(expected),'Multiple selection established');
key(1,{key:'&'});await wait(()=>a.hasTag(red)&&b.hasTag(red),'Digit1 adds first native colored tag to all selected');
key(1);await wait(()=>!a.hasTag(red)&&!b.hasTag(red),'Digit1 removes tag when all selected have it');
a.addTag(red);await a.saveTx();key(1);await wait(()=>!a.hasTag(red)&&!b.hasTag(red),'Mixed selection native toggle removes from all');key(1);await wait(()=>a.hasTag(red)&&b.hasTag(red),'Unmarked selection adds to all');
key(2,{code:'Numpad2'});await wait(()=>a.hasTag(blue)&&b.hasTag(blue),'Numpad2 applies second native colored tag');
for(const modifier of ['metaKey','ctrlKey','altKey','shiftKey']){key(1,{[modifier]:true});await delay(30);assert(a.hasTag(red)&&b.hasTag(red),'Modified number shortcut does not edit tags: '+modifier);}
window.Zotero_Tabs.select('zotero-pane');
key(0);await wait(()=>![a,b].some(i=>i.hasTag(red)||i.hasTag(blue)),'0 removes all colored tags');
assert(JSON.stringify(selected())===JSON.stringify(expected),'Keyboard tags retain selection');
await window.ZoteroPane.setTagScope();
const tagElement=()=>[...window.document.querySelectorAll('.tag-selector-item')].find(e=>e.textContent===targetName);
await wait(()=>!!tagElement(),'Native tag target rendered');
function start(item){const dataTransfer=new window.DataTransfer();const card=ctl.cards.get(item.id);assert(card?.draggable,'Grid card draggable');const e=new window.DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer});card.dispatchEvent(e);return {dataTransfer,card,event:e};}
const anchorBeforeSelectedDrag=ctl.anchor;
let drag=start(a);assert(ctl.anchor===anchorBeforeSelectedDrag,'Dragging selected item preserves existing selection anchor');assert(drag.dataTransfer.getData('zotero/item').split(',').map(Number).sort((x,y)=>x-y).join(',')===expected.join(','),'Native item drag carries all selected IDs');
assert(Zotero.DragDrop.currentDragSource===ctl.view.collectionTreeRows[0],'Native drag source recorded');
let overPrevented=false;window.ZoteroPane.tagSelector.dragObserver.onDragOver({target:tagElement(),dataTransfer:drag.dataTransfer,metaKey:false,shiftKey:false,preventDefault(){overPrevented=true;}});
assert(overPrevented&&drag.dataTransfer.dropEffect==='copy','Native tag drag-over accepts payload');
await window.ZoteroPane.tagSelector.dragObserver.onDrop({target:tagElement(),dataTransfer:drag.dataTransfer,metaKey:false,shiftKey:false});
assert(a.hasTag(targetName)&&b.hasTag(targetName),'Actual native tag drop assigns all selected items');
drag.card.dispatchEvent(new window.DragEvent('dragend',{bubbles:true,dataTransfer:drag.dataTransfer}));
assert(JSON.stringify(selected())===JSON.stringify(expected),'Tag drop retains selection');
drag=start(a);await window.ZoteroPane.tagSelector.dragObserver.onDrop({target:tagElement(),dataTransfer:drag.dataTransfer,metaKey:true,shiftKey:false});assert(!a.hasTag(targetName)&&!b.hasTag(targetName),'Command-drop removes tags through native handler');drag.card.dispatchEvent(new window.DragEvent('dragend',{bubbles:true,dataTransfer:drag.dataTransfer}));
drag=start(c);assert(drag.dataTransfer.getData('zotero/item')===String(c.id),'Unselected source becomes sole drag item synchronously');assert(selected().join(',')===String(c.id),'Unselected drag updates native selection');drag.card.dispatchEvent(new window.DragEvent('dragend',{bubbles:true,dataTransfer:drag.dataTransfer}));
await ctl.select(a.id,{shiftKey:true});assert(selected().length===3,'Shift selection after unselected drag starts at dragged item');
const group=Zotero.Groups.getAll().find(g=>g.name==='Synthetic Read-only Tag Group');
const groupItem=(await Zotero.Items.getAll(group.libraryID))[0];
await window.ZoteroPane.collectionsView.selectLibrary(group.libraryID);await delay(250);ctl.refresh(true);await wait(()=>ctl.items.length===1&&ctl.cards.has(groupItem.id),'Read-only group card');await ctl.select(groupItem.id,{});
assert(!ctl.view.collectionTreeRows[0].editable,'Actual native group row is read-only');key(1);await delay(200);assert(!groupItem.hasTag('Read-only Red'),'Read-only group rejects colored-tag edit');
await window.ZoteroPane.collectionsView.selectCollection(collection.id);await delay(200);ctl.refresh(true);
return{passed:true,nativeColoredTagNumbers:true,physicalDigitCode:true,numpad:true,toggleOff:true,mixedSelectionRemovesAll:true,zeroClearsColors:true,modifierGuard:true,selectionRetained:true,nativeTagDrop:true,dropItemCount:2,commandDropRemoves:true,unselectedDragSelectsSource:true,selectionAnchorRetained:true,shiftAnchorFollowsNewDrag:true,nativeDragSource:true,readOnlyGroupGuard:true};
