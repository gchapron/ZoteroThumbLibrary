# ZoteroThumbLibrary

A macOS Zotero plugin that replaces the library table with a scrollable grid of first-page PDF thumbnails and local image previews. Switch between **Icons** and **List** from the library toolbar.

## Install

This initial release targets **Zotero 9.0.x** and was developed and exercised with **Zotero 9.0.6 on macOS**.

1. Download or use `dist/ZoteroThumbLibrary-0.1.2.xpi`.
2. In Zotero, choose **Tools → Plugins**.
3. Open the gear menu, choose **Install Plugin From File…**, and select the XPI.
4. Restart Zotero if prompted.

No Python, Node, or developer setup is needed to install the packaged plugin. It can be disabled or removed from Zotero's Plugins window.

## Use

- Each parent item uses its best attachment; standalone attachments have their own cards.
- Collections, saved searches, tags, and quick search use Zotero's existing filtered item view and sort order.
- Click to select a card and view its metadata. Double-click or press Enter to open it normally.
- Use ⌘-click or Shift-click for multiple selection, arrow keys to move, and ⌘A to select the displayed items.
- Right-click for Zotero's normal item actions.
- Adjust the **Size** slider to resize cards. Column changes animate while keeping the same item at the top of the viewport. The view choice and card size are remembered.

Use **List** for sorting columns, dragging items, expanding multiple attachments, and other table-specific operations. Expanded children are grouped into their parent's card. Disabling the plugin removes its controls and renderer and restores the original list.

## Previews and limits

PDFs and images must be available locally. Missing attachments are not downloaded automatically. Notes, snapshots, EPUBs, Office files, encrypted or corrupt PDFs, and files larger than **256 MiB** show a placeholder.

On macOS, rendering uses the system's native Quick Look service through the bundled `/usr/bin/qlmanage` tool. No extra software or compilation is required. Other platforms, unavailable native previews, and native errors fall back to Zotero's bundled PDF.js. Both paths operate locally. The plugin does not modify PDFs or annotations. It renders only cards near the visible area, prioritizes visible cards over offscreen preloading, and discards obsolete queued requests when scrolling. Scroll events are coalesced into animation frames, and recently decoded cards are reused when you reverse direction. Reduced-motion preferences are respected.

There are two cache levels: an in-memory cache limited to 160 entries and approximately 12 MiB of image strings, and a persistent local PNG cache targeting a limit of **128 MiB or 1,000 previews**. The disk cache survives Zotero restarts. Source path, attachment ID, file size, and modification time determine the cache key; ordinary metadata edits do not discard previews. Damaged entries are regenerated, and a filesystem failure falls back to normal rendering.

The disk cache is stored under `cache/zoteroThumbLibrary/v1` in the Zotero profile directory. Unused entries are pruned after 30 days, alongside size/count cleanup. The first preview of a new or changed file still needs rendering; subsequent visits reuse the result. A 30-second rendering timeout prevents one unavailable preview from indefinitely blocking the queue.

Native generation runs asynchronously with a five-second limit and uses a private temporary folder that is removed after the job. Failures fall back automatically. The PDF.js fallback uses an unthrottled, cancellable scheduler inside its dedicated hidden rendering document; this avoids Gecko's approximately one-second hidden-animation-frame delay without changing page display settings or the visible Zotero window.

In Zotero 9.0.6 on the development Mac, ten new synthetic PDFs took **922 ms total** with native previews; reloading their cached previews took **22 ms total** with no rendering. The forced PDF.js fallback took **487 ms total** for the same ten files. These timings describe simple test files, not a speed guarantee for complex or scanned documents.

The plugin uses internal Zotero interfaces and restricts installation to Zotero 9.0.x. Other major versions and operating systems have not been tested. Updates are manual: Zotero requires an HTTPS update URL, so the manifest uses the reserved `updates.invalid` domain without an update service. An update check may fail harmlessly.

## Build and test

The complete plugin source is at the repository root. Build with Python 3 using only its standard library:

```sh
python3 scripts/build.py
```

The script writes the reproducible XPI and SHA-256 checksum to `dist/`. It packages only the runtime files and license, with fixed ZIP timestamps and permissions.

Run the dependency-free tests with Node:

```sh
node --test tests/*.test.cjs
```

The 43 tests cover large-library layout bounds, selection, attachment grouping, window reopening, scroll coalescing, zoom anchoring, decoded-card reuse, reduced motion, request deduplication, source-file invalidation, disk-cache persistence and recovery, cache eviction, cancellation, rapid scrolling, native process handling, fallback behavior, and hidden-renderer scheduling.

`tests/runtime-results.json` records actual Zotero verification using a disposable profile and synthetic files. Checks included a decoded **360 × 466** first-page PNG, native selection, collection filtering, search and empty states, view switching, disable/enable cleanup, main-window reopening, and a cold application restart. Runtime checks inspected live DOM and application state; no screenshot-based visual review was completed. A real library containing 100,000 PDFs was not loaded; large-library bounds were checked by the portable model tests.

## Development references

- [Zotero plugin development](https://www.zotero.org/support/dev/client_coding/plugin_development)
- [Zotero plugin lifecycle and reader hooks](https://www.zotero.org/support/dev/zotero_7_for_developers)
- [Zotero source](https://github.com/zotero/zotero)
- [Zotero reader source](https://github.com/zotero/reader)
- [Apple Quick Look command-line documentation](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/Quicklook_Programming_Guide/Articles/QLDebugTest.html)

License: **AGPL-3.0-or-later**. See [LICENSE](LICENSE).
