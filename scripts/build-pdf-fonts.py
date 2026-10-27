#!/usr/bin/env python3
"""Convert Excalidraw's web fonts (woff2, split into unicode subsets) into one TTF per
family, so they can be embedded in exported PDFs (jsPDF needs TrueType).

Run after `npm install` when upgrading Excalidraw:   python3 scripts/build-pdf-fonts.py
Requires: pip install fonttools brotli
Output: public/pdf-fonts/<Family>.ttf  (committed to the repo, so builds don't need Python)
        public/pdf-fonts/DejaVuSans.ttf  fallback for characters those fonts lack (Greek, maths,
                                         arrows...), copied from the system or $DEJAVU_SANS
        public/pdf-fonts/coverage.json   which characters each font has, so the export can pick
                                         a font per character
"""
import json
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


DEJAVU_PATHS = [
    os.environ.get("DEJAVU_SANS", ""),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/DejaVuSans.ttf",
    os.path.expanduser("~/Library/Fonts/DejaVuSans.ttf"),
]


def ranges(codepoints):
    out = []
    for cp in sorted(codepoints):
        if out and cp == out[-1][1] + 1:
            out[-1][1] = cp
        else:
            out.append([cp, cp])
    return out


def write_coverage():
    coverage = {}
    for path in sorted(glob.glob(os.path.join(DEST, "*.ttf"))):
        name = os.path.splitext(os.path.basename(path))[0]
        coverage[name] = ranges(TTFont(path).getBestCmap().keys())
    out = os.path.join(DEST, "coverage.json")
    with open(out, "w") as f:
        json.dump(coverage, f, separators=(",", ":"))
    print(f"coverage of {len(coverage)} fonts -> {os.path.relpath(out, ROOT)}")


def copy_fallback():
    src = next((p for p in DEJAVU_PATHS if p and os.path.exists(p)), None)
    dest = os.path.join(DEST, "DejaVuSans.ttf")
    if src:
        TTFont(src).save(dest)
        print(f"DejaVuSans: {src} -> {os.path.relpath(dest, ROOT)}")
    elif not os.path.exists(dest):
        print("DejaVu Sans not found: set DEJAVU_SANS=/path/to/DejaVuSans.ttf", file=sys.stderr)


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
    copy_fallback()
    write_coverage()


if __name__ == "__main__":
    main()
