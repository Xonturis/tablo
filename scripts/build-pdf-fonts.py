#!/usr/bin/env python3
"""Convert Excalidraw's web fonts (woff2, split into unicode subsets) into one TTF per
family, so they can be embedded in exported PDFs (jsPDF needs TrueType).

Run after `npm install` when upgrading Excalidraw:   python3 scripts/build-pdf-fonts.py
Requires: pip install fonttools brotli
Output: public/pdf-fonts/<Family>.ttf  (committed to the repo, so builds don't need Python)
"""
import glob
import os
import sys
import tempfile

from fontTools.merge import Merger
from fontTools.ttLib import TTFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "node_modules/@excalidraw/excalidraw/dist/prod/fonts")
DEST = os.path.join(ROOT, "public/pdf-fonts")
# Excalidraw font families we embed (Xiaolai, the CJK font, is 13 MB and left out)
FAMILIES = ["Excalifont", "Virgil", "Nunito", "Lilita", "ComicShanns", "Cascadia", "Liberation"]


def regular_files(family):
    files = sorted(glob.glob(os.path.join(SRC, family, "*.woff2")))
    regular = [f for f in files if "Regular" in os.path.basename(f)]
    return regular or files


def main():
    os.makedirs(DEST, exist_ok=True)
    for family in FAMILIES:
        files = regular_files(family)
        if not files:
            print(f"skip {family}: no files", file=sys.stderr)
            continue
        with tempfile.TemporaryDirectory() as tmp:
            ttfs = []
            for i, f in enumerate(files):
                font = TTFont(f)
                font.flavor = None  # woff2 -> plain TrueType
                if "CFF " in font:
                    print(f"skip {family}: CFF outlines are not supported by jsPDF", file=sys.stderr)
                    break
                path = os.path.join(tmp, f"{i}.ttf")
                font.save(path)
                ttfs.append(path)
            else:
                out = os.path.join(DEST, f"{family}.ttf")
                merged = Merger().merge(ttfs) if len(ttfs) > 1 else TTFont(ttfs[0])
                merged.save(out)
                print(f"{family}: {len(ttfs)} subset(s) -> {os.path.relpath(out, ROOT)} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
