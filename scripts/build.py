#!/usr/bin/env python3
"""Build the reproducible ZoteroThumbLibrary XPI with the Python standard library."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = (
    "bootstrap.js",
    "grid.css",
    "grid.js",
    "manifest.json",
    "model.js",
    "native-thumbnails.js",
    "prefs.js",
    "thumbnail-renderer.html",
    "thumbnail-renderer.js",
    "thumbnails.js",
)


def add_file(archive, path, name):
    info = zipfile.ZipInfo(name, (2026, 9, 24, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    archive.writestr(info, path.read_bytes())


def build():
    manifest = json.loads((ROOT / "manifest.json").read_text())
    app = manifest["applications"]["zotero"]
    for key in ("id", "update_url", "strict_min_version", "strict_max_version"):
        assert app.get(key), f"Missing required Zotero manifest field: {key}"
    assert app["update_url"].startswith("https:"), "Zotero requires secure update URLs"
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    target = dist / f"ZoteroThumbLibrary-{manifest['version']}.xpi"
    with zipfile.ZipFile(target, "w") as archive:
        for name in sorted(RUNTIME_FILES):
            add_file(archive, ROOT / name, name)
        add_file(archive, ROOT / "LICENSE", "LICENSE")
    with zipfile.ZipFile(target) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(RUNTIME_FILES) | {"LICENSE"}
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    (dist / "SHA256SUMS.txt").write_text(f"{digest}  {target.name}\n")
    print(f"Built {target.name} ({target.stat().st_size:,} bytes)")


if __name__ == "__main__":
    build()
