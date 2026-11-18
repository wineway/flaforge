#!/usr/bin/env python3
"""Create PNG thumbnails for raster materials and report image metadata.

Input JSON: [{"src": "...", "out": "...", "max": 480}, ...]
Output JSON (stdout): [{"src", "out", "ok", "width", "height", "format",
                        "mode", "bytes", "sha256", "error"}]
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

from PIL import Image

Image.MAX_IMAGE_PIXELS = 200_000_000


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    spec_path = sys.argv[1]
    with open(spec_path, "r", encoding="utf-8") as handle:
        items = json.load(handle)
    results = []
    for item in items:
        src = item["src"]
        out = item["out"]
        max_side = int(item.get("max", 480))
        record = {
            "src": src,
            "out": out,
            "ok": False,
            "width": None,
            "height": None,
            "thumb_width": None,
            "thumb_height": None,
            "format": None,
            "mode": None,
            "bytes": None,
            "sha256": None,
            "error": None,
        }
        try:
            os.makedirs(os.path.dirname(out), exist_ok=True)
            record["bytes"] = os.path.getsize(src)
            record["sha256"] = sha256_file(src)
            with Image.open(src) as image:
                record["width"], record["height"] = image.size
                record["format"] = image.format
                record["mode"] = image.mode
                image.load()
                if image.mode in ("RGBA", "LA", "P"):
                    image = image.convert("RGBA")
                else:
                    image = image.convert("RGB")
                image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
                record["thumb_width"], record["thumb_height"] = image.size
                image.save(out, "PNG", optimize=True)
            record["ok"] = True
        except Exception as error:  # noqa: BLE001 - report, never abort the batch
            record["error"] = f"{type(error).__name__}: {error}"
        results.append(record)
    json.dump(results, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
