# ZoteroThumbLibrary

A macOS Zotero plugin that replaces the library table with a scrollable grid of first-page PDF thumbnails, EPUB covers, and local image previews. Use the compact view button in the library toolbar to switch between the grid and list.

## Install

The current release targets **Zotero 9.0.x** and was developed and exercised with **Zotero 9.0.6 on macOS**.

1. Open the [latest GitHub release](https://github.com/gchapron/ZoteroThumbLibrary/releases/latest) and download its **ZoteroThumbLibrary `.xpi` asset**. The source-code ZIP and TAR archives are for development and cannot be installed as plugins.
2. In Zotero, choose **Tools → Plugins**.
3. Open the gear menu, choose **Install Plugin From File…**, and select the XPI.
4. Restart Zotero if prompted.

No Python, Node, or developer setup is needed to install the packaged plugin. It can be disabled or removed from Zotero's Plugins window. To update, download and install the newer release's XPI the same way; your existing plugin settings are retained.

## Use

- Each parent item uses its best attachment; standalone attachments have their own cards.
- Collections, saved searches, tags, and quick search use Zotero's existing filtered item view and sort order.
- Click to select a card and view its metadata. Double-click or press Enter to open it normally.
- Use ⌘-click or Shift-click for multiple selection, arrow keys to move, and ⌘A to select the displayed items.
- Press **Space** to open or close the selected file in **Zotero7QuickLook**, when that plugin is installed. Its Escape, ⌘Y, Shift-Space, and Option-Space shortcuts also work from the grid. Previewing preserves the selection and grid focus.
- Drag a card onto a tag in Zotero's bottom-left tag panel to assign that tag. Dragging an already-selected card includes all selected items; dragging an unselected card selects that item first. On macOS, hold **⌘** while dropping to remove the tag.
- Press **1–9** to toggle the corresponding colored tag on the selected items, or **0** to remove their colored tags. Assign colors and shortcut positions in Zotero's tag panel first. Number-pad keys work too. Read-only libraries cannot be changed.
- Right-click for Zotero's normal item actions.
- Adjust the **Size** slider to resize cards. Column changes animate while keeping the same item at the top of the viewport. The view choice and card size are remembered.

Switch to list view for sorting columns, expanding multiple attachments, and other table-specific operations. Expanded children are grouped into their parent's card. Disabling the plugin removes its controls and renderer and restores the original list.

## Previews and limits

PDFs, EPUBs, and images must be available locally. Missing attachments are not downloaded automatically. Notes, snapshots, EPUBs without an extractable cover, Office files, encrypted or corrupt PDFs, and files larger than **256 MiB** show a placeholder.

PDF previews use Zotero's bundled PDF.js on every platform, including macOS. Generation stays inside Zotero and does not launch Quick Look processes, eliminating the repeated process activity associated with Dock flickering. No extra software is needed. The fast hidden-renderer scheduler avoids the former one-second delay per page. Quick Look is invoked only when you request it through your separate preview plugin.

EPUB covers come directly from the book's declared cover image, including EPUB 3 cover-image metadata, EPUB 2 cover metadata, and cover pages that wrap a raster image in HTML or SVG. They retain the cover's natural proportions without an extra white page around the artwork. Only local archive resources are read; book HTML is not opened or executed.

The plugin does not modify files or annotations. It renders only cards near the visible area, prioritizes visible cards over offscreen preloading, and discards obsolete queued requests when scrolling. Scroll events are coalesced into animation frames, and recently decoded cards are reused when you reverse direction. Reduced-motion preferences are respected. Both thumbnail toolbars use a compact 32-pixel row.

There are two cache levels: an in-memory cache limited to 160 entries and approximately 12 MiB of image strings, and a persistent local PNG cache targeting a limit of **128 MiB or 1,000 previews**. The disk cache survives Zotero restarts. Source path, attachment ID, file size, and modification time determine the cache key; ordinary metadata edits do not discard previews. Damaged entries are regenerated, and a filesystem failure falls back to normal rendering.

The disk cache is stored under `cache/zoteroThumbLibrary/v1` in the Zotero profile directory. Unused entries are pruned after 30 days, alongside size/count cleanup. The first preview of a new or changed file still needs rendering; subsequent visits reuse the result. A 30-second rendering timeout prevents one unavailable preview from indefinitely blocking the queue.

The PDF renderer uses an unthrottled, cancellable scheduler inside its dedicated hidden document; this avoids Gecko's approximately one-second hidden-animation-frame delay without changing page display settings or the visible Zotero window. Earlier isolated testing generated ten simple PDFs in about half a second using this path. Complex scans and vector-heavy files can take longer.

The plugin uses internal Zotero interfaces and restricts installation to Zotero 9.0.x. Other major versions and operating systems have not been tested. Updates are manual: Zotero requires an HTTPS update URL, so the manifest uses the reserved `updates.invalid` domain without an update service. An update check may fail harmlessly.

## Build and test

The complete plugin source is at the repository root. Build with Python 3 using only its standard library:

```sh
python3 scripts/build.py
```

The script writes the reproducible XPI and `SHA256SUMS.txt` to `dist/`. This generated directory is ignored by Git; installers and checksums are distributed as GitHub Release assets. It packages only the runtime files and license, with fixed ZIP timestamps and permissions. From `dist/`, run `shasum -a 256 -c SHA256SUMS.txt` on macOS to check the package.

Run the dependency-free tests with Node:

```sh
node --test tests/*.test.cjs
```

Tests cover large-library layout bounds, selection, attachment grouping, window reopening, scroll coalescing, zoom anchoring, decoded-card reuse, reduced motion, native item dragging and colored-tag shortcut forwarding, QuickLook shortcut forwarding, EPUB cover extraction, request deduplication, source-file invalidation, disk-cache persistence and recovery, cache eviction, cancellation, rapid scrolling, and hidden-renderer scheduling.

The tagging update includes 61 passing portable tests. Actual Zotero checks exercise card drag events through the native tag panel, multiple selection, Command-drop removal, numbered colored-tag toggling, range-selection anchoring, and the read-only shortcut guard.

`tests/runtime-results.json` records actual Zotero verification using a disposable profile and synthetic files. Checks included a decoded **360 × 466** first-page PNG, native selection, collection filtering, search and empty states, view switching, disable/enable cleanup, main-window reopening, and a cold application restart. Runtime checks inspected live DOM and application state; no screenshot-based visual review was completed. A real library containing 100,000 PDFs was not loaded; large-library bounds were checked by the portable model tests.

## Publish a release

1. Set the intended version in `manifest.json`, update the README, and run the tests and build above.
2. Verify the installer in a disposable Zotero profile and retain the results under `tests/`.
3. Commit and push the source, then create a Git tag matching the manifest version (for example, `v0.1.4`) on that exact commit.
4. Create a draft GitHub Release for the tag, add release notes, and attach the generated XPI and `SHA256SUMS.txt`. Verify the assets before publishing.

The tag preserves the release source; its assets provide the installable package. Keep generated files out of commits.

## Development references

- [Zotero plugin development](https://www.zotero.org/support/dev/client_coding/plugin_development)
- [Zotero plugin lifecycle and reader hooks](https://www.zotero.org/support/dev/zotero_7_for_developers)
- [Zotero source](https://github.com/zotero/zotero)
- [Zotero reader source](https://github.com/zotero/reader)
- [EPUB 3.3 specification](https://www.w3.org/TR/epub-33/)

License: **AGPL-3.0-or-later**. See [LICENSE](LICENSE).
