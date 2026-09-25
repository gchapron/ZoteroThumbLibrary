/* Actual Zotero integration probe, supplied Zotero/window/IOUtils/PathUtils/ROOT
 * by a disposable-profile bootstrap. ROOT must be a fresh
 * /private/tmp/ziv-file-drop-runtime-* directory with profile/ and data/.
 * The harness disables sync and updates, installs the candidate XPI and runs
 * Zotero with -no-remote -profile ROOT/profile -headless. No personal data is used.
 * Synthetic nsIFile DataTransfers exercise the real DOM listeners and native
 * item-tree import command. They do not automate an actual Finder gesture.
 */
if (!ROOT.startsWith('/private/tmp/ziv-file-drop-runtime-')
    || Zotero.DataDirectory.dir !== ROOT + '/data'
    || PathUtils.profileDir !== ROOT + '/profile') {
  throw new Error('Refusing personal profile');
}
const delay = ms => Zotero.Promise.delay(ms);
const assert = (value, message) => { if (!value) throw new Error(message); };
const wait = async (fn, message) => {
  for (let i = 0; i < 600; i++) {
    if (await fn()) return;
    await delay(25);
  }
  throw new Error('Timeout: ' + message);
};
const pane = window.ZoteroPane;
const ctl = window.ZoteroIconView;
const libraryID = Zotero.Libraries.userLibraryID;
const checks = {};
const nativeCalls = [];
const restores = [];
const wrappedViews = new WeakSet();
let nativeActive = 0;
await Zotero.Libraries.get(libraryID).waitForDataLoad('item');
await IOUtils.makeDirectory(ROOT + '/fixtures', { ignoreExisting: true });
const source = async name => {
  const path = ROOT + '/fixtures/' + name + '.txt';
  await IOUtils.writeUTF8(path, 'Synthetic file-drop fixture: ' + name + '\n');
  return path;
};
const files = {};
for (const name of ['plain', 'multi-a', 'multi-b', 'parent', 'linked', 'moved', 'guard']) {
  files[name] = await source(name);
}
const attachments = async (lib = libraryID) =>
  (await Zotero.Items.getAll(lib)).filter(item => item.isAttachment());
const transfer = paths => {
  const dt = new window.DataTransfer();
  for (const [index, path] of paths.entries()) {
    dt.mozSetDataAt('application/x-moz-file', Zotero.File.pathToFile(path), index);
  }
  dt.effectAllowed = 'all';
  dt.dropEffect = 'move'; // Finder's initial macOS file effect; native drop chooses copy.
  return dt;
};
const instrumentView = () => {
  const view = pane.itemsView;
  if (wrappedViews.has(view)) return;
  wrappedViews.add(view);
  const original = view.onDrop;
  view.onDrop = async function(event, row) {
    const call = { row, orientation: Zotero.DragDrop.currentOrientation,
      metaKey: event.metaKey, altKey: event.altKey, completed: false };
    nativeCalls.push(call);
    nativeActive++;
    try {
      const result = await original.call(this, event, row);
      call.completed = true;
      return result;
    } catch (error) {
      call.error = String(error);
      throw error;
    } finally { nativeActive--; }
  };
  restores.push(() => view.onDrop = original);
};
const context = async (kind, id) => {
  window.Zotero_Tabs.select('zotero-pane');
  if (kind === 'collection') await pane.collectionsView.selectCollection(id);
  else if (kind === 'search') await pane.collectionsView.selectSearch(id);
  else await pane.collectionsView.selectLibrary(id);
  await pane.clearQuicksearch();
  if (!ctl.enabled) ctl.toggle();
  ctl.refresh(true);
  await delay(200);
  instrumentView();
};
const dispatch = (target, dt, options = {}) => {
  const rect = target.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, dataTransfer: dt,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, ...options };
  const over = new window.DragEvent('dragover', init);
  target.dispatchEvent(over);
  const effect = dt.dropEffect;
  const drop = new window.DragEvent('drop', init);
  target.dispatchEvent(drop);
  return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented, effect };
};
const importFiles = async (target, paths, options = {}) => {
  const before = new Set((await attachments()).map(item => item.id));
  const callCount = nativeCalls.length;
  const events = dispatch(target, transfer(paths), options);
  await wait(() => nativeCalls.length > callCount && nativeActive === 0, 'Native file drop completed');
  assert(nativeCalls.at(-1).completed, 'Native import did not throw');
  const added = (await attachments()).filter(item => !before.has(item.id));
  assert(added.length === paths.length, 'Exactly one imported attachment per source');
  assert(events.overPrevented && events.dropPrevented, 'Grid accepts dragover and drop');
  await delay(200);
  return { added, events };
};
const verifyCopy = async (item, path) => {
  const storedPath = await item.getFilePathAsync();
  assert(item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_IMPORTED_FILE, 'Stored attachment mode');
  assert(storedPath.startsWith(ROOT + '/data/storage/'), 'Imported bytes are in isolated Zotero storage');
  assert(await IOUtils.exists(path), 'Finder source remains after plain copy');
  assert(await IOUtils.readUTF8(storedPath) === await IOUtils.readUTF8(path), 'Imported bytes match source');
};
const reject = async (target, dt, label, lib = libraryID) => {
  const before = (await attachments(lib)).map(item => item.id).join(',');
  const callCount = nativeCalls.length;
  const events = dispatch(target, dt);
  await delay(250);
  assert((await attachments(lib)).map(item => item.id).join(',') === before, label + ': no attachment created');
  assert(nativeCalls.length === callCount, label + ': import command not called');
  return events;
};
try {
  const collection = new Zotero.Collection();
  collection.libraryID = libraryID;
  collection.name = 'Synthetic Finder drop collection';
  await collection.saveTx();
  await context('collection', collection.id);
  assert(ctl.items.length === 0, 'Collection starts empty');
  const plain = await importFiles(ctl.root, [files.plain]);
  await verifyCopy(plain.added[0], files.plain);
  assert(plain.added[0].inCollection(collection.id) && !plain.added[0].parentID,
    'Empty-background drop creates top-level collection attachment');
  await wait(() => ctl.cards.has(plain.added[0].id), 'Imported attachment appears in grid');
  checks.emptyCollectionBackgroundCopy = plain.events;
  checks.storedBytesMatchAndSourcePreserved = true;
  checks.importedCardAppears = true;

  let multipleTransfer;
  try { multipleTransfer = transfer([files['multi-a'], files['multi-b']]); }
  catch (error) {
    if (error.name !== 'IndexSizeError') throw error;
    checks.multipleFileImport = { tested: false,
      reason: 'Constructed Gecko DataTransfer rejects mozSetDataAt index 1. Multiple-file database import was not runtime-tested.' };
  }
  if (multipleTransfer) {
    const multiple = await importFiles(ctl.viewport, [files['multi-a'], files['multi-b']]);
    for (const [index, item] of multiple.added.entries()) {
      const sourcePath = [files['multi-a'], files['multi-b']].find(path => path.endsWith(item.attachmentFilename));
      assert(sourcePath, 'Multiple-file filename preserved: ' + index);
      await verifyCopy(item, sourcePath);
      assert(item.inCollection(collection.id) && !item.parentID, 'Both files added to selected collection');
    }
    checks.multipleFileImport = { tested: true };
  }

  const parent = new Zotero.Item('book');
  parent.libraryID = libraryID;
  parent.setField('title', 'Synthetic parent drop target');
  parent.setCollections([collection.id]);
  await parent.saveTx();
  await wait(() => ctl.cards.has(parent.id), 'Parent card available');
  const parentCard = ctl.cards.get(parent.id);
  const child = await importFiles(parentCard.querySelector('.ziv-title') || parentCard.firstElementChild, [files.parent]);
  await verifyCopy(child.added[0], files.parent);
  assert(child.added[0].parentID === parent.id, 'Drop on a card descendant attaches file to that item');
  checks.cardDescendantAttachesToParent = true;

  const linked = await importFiles(ctl.root, [files.linked], { metaKey: true, altKey: true });
  assert(linked.added[0].attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE,
    'Command-Option invokes native linked-file behavior');
  assert(await linked.added[0].getFilePathAsync() === files.linked, 'Linked file points to synthetic source');
  assert(linked.added[0].inCollection(collection.id) && await IOUtils.exists(files.linked), 'Link has collection membership and preserves source');
  checks.macCommandOptionLinksFile = true;

  const movedBytes = await IOUtils.readUTF8(files.moved);
  const moved = await importFiles(ctl.root, [files.moved], { metaKey: true });
  assert(moved.added[0].attachmentLinkMode === Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
    'Command-drop creates stored attachment');
  const movedPath = await moved.added[0].getFilePathAsync();
  assert(movedPath.startsWith(ROOT + '/data/storage/') && await IOUtils.readUTF8(movedPath) === movedBytes,
    'Moved bytes imported into isolated storage');
  assert(!await IOUtils.exists(files.moved), 'Command-drop removes only the disposable source');
  checks.macCommandMovesFile = true;

  await wait(() => ctl.cards.has(plain.added[0].id), 'Standalone attachment card remains visible');
  checks.attachmentCardRejected = await reject(ctl.cards.get(plain.added[0].id),
    transfer([files.guard]), 'Standalone attachment card');

  const text = new window.DataTransfer();
  text.setData('text/plain', 'Unsupported synthetic text');
  checks.unsupportedTextIgnored = await reject(ctl.root, text, 'Unsupported text');
  const internal = transfer([files.guard]);
  internal.setData('zotero/item', String(parent.id));
  checks.internalItemWithFileFlavorIgnored = await reject(ctl.root, internal, 'Internal item drag');

  const search = new Zotero.Search();
  search.libraryID = libraryID;
  search.name = 'Synthetic file-drop saved search';
  search.addCondition('title', 'contains', 'Synthetic');
  await search.saveTx();
  await context('search', search.id);
  checks.savedSearchBackgroundRejected = await reject(ctl.root, transfer([files.guard]), 'Saved search background');

  const group = new Zotero.Group({ groupID: 987654321, name: 'Synthetic readonly file-drop group',
    description: '', version: 0, editable: false, filesEditable: false });
  await group.saveTx();
  await context('library', group.libraryID);
  let readOnlyWarnings = 0;
  const cannotEdit = pane.displayCannotEditLibraryMessage;
  pane.displayCannotEditLibraryMessage = () => { readOnlyWarnings++; };
  restores.push(() => pane.displayCannotEditLibraryMessage = cannotEdit);
  const groupBefore = (await attachments(group.libraryID)).length;
  const readOnlyEvents = dispatch(ctl.root, transfer([files.guard]));
  await delay(350);
  await wait(() => nativeActive === 0, 'Read-only drop complete');
  assert((await attachments(group.libraryID)).length === groupBefore, 'Readonly library rejects file import');
  assert(await IOUtils.exists(files.guard), 'Rejected source preserved');
  checks.readOnlyLibraryRejected = { ...readOnlyEvents, nativeWarnings: readOnlyWarnings };
  await context('collection', collection.id);
  return { passed: true, testedAt: new Date().toISOString(), zoteroVersion: Zotero.version,
    pluginVersion: ctl.version, platform: 'macOS', profile: PathUtils.profileDir,
    data: Zotero.DataDirectory.dir,
    mode: 'Headless Zotero actual DOM DragEvents and nsIFile DataTransfer; isolated synthetic text files',
    checks, nativeCalls, fixtureCollectionID: collection.id, fixtureParentItemID: parent.id,
    importedAttachmentCount: (await attachments()).length,
    limitations: 'Synthetic browser events exercise actual import/database code; no manual Finder drag or screenshot review. Multiple-file runtime coverage depends on constructed DataTransfer support, as recorded above. Only the read-only message display is stubbed.' };
} finally {
  for (const restore of restores.reverse()) restore();
}
