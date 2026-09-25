var scope, chromeHandle;

async function startup({ rootURI, version }) {
  chromeHandle = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup)
    .registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
      ["content", "library-icon-view", ""]
    ]);
  scope = { Zotero, Services, ChromeUtils, Components, IOUtils, PathUtils, rootURI, version };
  for (let file of ["epub-cover.js", "thumbnails.js", "model.js", "grid.js"]) {
    Services.scriptloader.loadSubScript(rootURI + file, scope);
  }
  for (let window of Zotero.getMainWindows()) await onMainWindowLoad({ window });
}

async function onMainWindowLoad({ window }) {
  await window.Zotero?.uiReadyPromise;
  if (!scope || window.closed || window.ZoteroIconView) return;
  try {
    let controller = new scope.LibraryIconView(window, scope.rootURI, scope.version);
    window.ZoteroIconView = controller;
    await controller.init();
  }
  catch (error) {
    Zotero.logError(error);
    try { window.ZoteroIconView?.destroy(); }
    catch (cleanupError) { Zotero.logError(cleanupError); }
    finally { delete window.ZoteroIconView; }
  }
}

function onMainWindowUnload({ window }) {
  window.ZoteroIconView?.destroy();
  delete window.ZoteroIconView;
}

function shutdown() {
  for (let window of Zotero.getMainWindows()) onMainWindowUnload({ window });
  chromeHandle?.destruct();
  chromeHandle = null;
  scope = null;
}

function install() {}
function uninstall() {}
