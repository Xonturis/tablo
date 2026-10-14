#!/usr/bin/env python3
"""
miro_export.py - export Miro boards to open formats through the Miro REST API v2.

For every board it writes a folder containing:
  raw.json             everything the API returned (board, items, connectors, tags, mind map nodes)
  <board>.excalidraw   an Excalidraw scene (open on excalidraw.com, in Obsidian, VS Code, ...)
  <board>.md           all the text on the board, grouped by frame, in reading order
  files/               original images and documents placed on the board

Requirements: Python 3.8+ only (standard library, nothing to install).

Getting a token (about 2 minutes):
  1. Go to https://miro.com/app/settings/user-profile/apps and click "Create new app".
  2. In the app settings, under Permissions, tick "boards:read".
  3. Click "Install app and get OAuth token", choose your team, copy the token.
  (A token covers one team: repeat step 3 for each team that holds boards.)

Usage:
  python3 miro_export.py                          # asks for the token, exports every board
  python3 miro_export.py --board <ID or board URL>  # only some boards (repeat --board)
  python3 miro_export.py --out ./miro_backup --no-files
  MIRO_TOKEN=... python3 miro_export.py           # token from the environment

Offline conversion (no token needed):
  python3 miro_export.py --from-json miro_*.json  # JSON exported in the browser (Tampermonkey /
                                                  # Web SDK miro.board.get()), or a raw.json from
                                                  # this script; writes .excalidraw + .md next to it
  python3 miro_export.py --from-json miro_*.json --svg *.svg
                                                  # add Miro's SVG downloads: recovers stencil shapes
                                                  # and text, unattached lines, images and emojis,
                                                  # and Miro's exact text wrapping
"""

import argparse
import base64
import getpass
import html
import json
import math
import os
import random
import re
import sys
import textwrap
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.miro.com"
FONT_FAMILY = 2          # Excalidraw "Normal" (Helvetica) font
LINE_HEIGHT = 1.25
CHAR_WIDTH = 0.55        # rough average glyph width, as a fraction of the font size

# Approximation of Miro's sticky note palette
STICKY_COLORS = {
    "gray": "#e6e6e6", "light_yellow": "#fff9b1", "yellow": "#f5d128", "orange": "#ff9d48",
    "light_green": "#d5f692", "green": "#c9df56", "dark_green": "#93d275", "cyan": "#67c6c0",
    "light_pink": "#ffcee0", "pink": "#ea94bb", "violet": "#c6a2d2", "red": "#f0939d",
    "light_blue": "#a6ccf5", "blue": "#6cd8fa", "dark_blue": "#9ea9ff", "black": "#000000",
}
EXT_BY_MIME = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
    "image/svg+xml": ".svg", "image/bmp": ".bmp", "application/pdf": ".pdf",
}
EXCALIDRAW_IMAGE_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp"}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- API client

class MiroError(Exception):
    pass


class Miro:
    def __init__(self, token):
        self.token = token

    def fetch(self, url, auth=True):
        """GET a URL, retrying on rate limits and server errors. Returns (body, headers)."""
        if url.startswith("/"):
            url = API + url
        headers = {"Accept": "application/json"}
        if auth:
            headers["Authorization"] = "Bearer " + self.token
        for attempt in range(8):
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=120) as resp:
                    return resp.read(), resp.headers
            except urllib.error.HTTPError as e:
                if e.code == 429 or e.code >= 500:
                    wait = int(e.headers.get("Retry-After") or 0) or min(60, 2 ** attempt)
                    log(f"    HTTP {e.code}, retrying in {wait}s")
                    time.sleep(wait)
                    continue
                detail = e.read().decode("utf-8", "replace")[:400]
                raise MiroError(f"HTTP {e.code} for {url}: {detail}") from None
            except urllib.error.URLError:
                if attempt < 4:
                    time.sleep(2 ** attempt)
                    continue
                raise
        raise MiroError(f"Gave up on {url} after repeated errors")

    def get(self, url):
        body, _ = self.fetch(url)
        return json.loads(body or b"null")

    def paginate(self, path, **params):
        """Yield every element of a list endpoint (handles both cursor and offset paging)."""
        params.setdefault("limit", 50)
        cursor, offset = None, 0
        while True:
            q = dict(params)
            if cursor:
                q["cursor"] = cursor
            elif offset:
                q["offset"] = offset
            page = self.get(path + "?" + urllib.parse.urlencode(q))
            data = page.get("data") or []
            yield from data
            if page.get("cursor"):
                cursor = page["cursor"]
                continue
            if "offset" in page and "total" in page:
                offset = int(page.get("offset") or 0) + len(data)
                if data and offset < int(page["total"]):
                    continue
            break


def bpath(board_id):
    return "/v2/boards/" + urllib.parse.quote(board_id, safe="")


# --------------------------------------------------------------------------- helpers

def new_id():
    return uuid.uuid4().hex[:20]


def rnd():
    return random.randint(1, 2 ** 31 - 1)


def html_to_text(s):
    if not s:
        return ""
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"(?i)</(p|div|li|h[1-6])>", "\n", s)
    s = re.sub(r"(?i)<li[^>]*>", "• ", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s).replace("\xa0", " ")
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def slug(s, maxlen=60):
    s = re.sub(r"[^\w\-. ]+", "_", s or "untitled", flags=re.UNICODE).strip(" ._")
    return (s or "untitled")[:maxlen]


def item_text(it):
    d = it.get("data") or {}
    t = it.get("type")
    if t in ("sticky_note", "shape", "text"):
        return html_to_text(d.get("content"))
    if t in ("card", "app_card"):
        return "\n".join(x for x in (html_to_text(d.get("title")), html_to_text(d.get("description"))) if x)
    if t == "frame":
        return d.get("title") or ""
    if t in ("image", "document"):
        return d.get("title") or ""
    if t in ("embed", "preview"):
        return d.get("title") or d.get("url") or ""
    # mind map nodes and anything else: look for a "content" field somewhere in data
    stack = [d]
    while stack:
        x = stack.pop()
        if isinstance(x, dict):
            if isinstance(x.get("content"), str):
                return html_to_text(x["content"])
            stack.extend(x.values())
    return ""


def wrap_cols(text, cols, break_words=True):
    lines = []
    for para in text.split("\n"):
        lines.extend(textwrap.wrap(para, max(1, cols), break_long_words=break_words,
                                   replace_whitespace=False) or [""])
    return lines


def wrap(text, width, fs, break_words=True):
    return wrap_cols(text, int(width / (fs * CHAR_WIDTH)), break_words)


def fit_text(text, w, h, fs=None, max_fs=36, min_fs=8):
    """Return (font_size, wrapped_lines). Shrinks the font until the text fits the box
    without splitting words; only splits words as a last resort."""
    fs = fs or max_fs
    while fs > min_fs:
        cols = int(w / (fs * CHAR_WIDTH))
        lines = wrap_cols(text, cols, break_words=False)
        if len(lines) * fs * LINE_HEIGHT <= h and max(len(l) for l in lines) <= max(cols, 1):
            return fs, lines
        fs -= 2
    return min_fs, wrap(text, w, min_fs)


def wrap_like_miro(text, w, h, fs):
    """Wrap a free text item so it takes as many lines as it did in Miro (inferred from its height)."""
    cols = max(1, int(w / (fs * 0.5)))
    if not h:
        return wrap_cols(text, int(cols * 1.15), break_words=False)
    target = max(1, round(h / (fs * 1.4)))  # Miro renders text with ~1.4 line height
    lines = wrap_cols(text, cols, break_words=False)
    limit = int(cols * 1.6)
    while len(lines) > target and cols < limit:
        cols += 1
        lines = wrap_cols(text, cols, break_words=False)
    return lines


# --------------------------------------------------------------------------- geometry

class Geometry:
    """Absolute boxes (center x, center y, width, height) for every item."""

    def __init__(self, items):
        self.by_id = {it["id"]: it for it in items}
        self.cache = {}

    def size(self, it):
        g = it.get("geometry") or {}
        w, h = num(g.get("width")), num(g.get("height"))
        t = it.get("type")
        if t == "sticky_note":
            shape = (it.get("data") or {}).get("shape", "square")
            w = w or (h if h and shape == "square" else 199.0)
            h = h or (w if shape == "square" else w * 0.65)
        elif t == "text":
            w = w or 300.0
            if not h:
                fs = num((it.get("style") or {}).get("fontSize"), 14)
                h = max(1, len(wrap(item_text(it), w, fs))) * fs * LINE_HEIGHT
        return w or 100.0, h or 100.0

    def box(self, it, _depth=0):
        iid = it["id"]
        if iid in self.cache:
            return self.cache[iid]
        pos = it.get("position") or {}
        x, y = num(pos.get("x"), 0.0), num(pos.get("y"), 0.0)
        w, h = self.size(it)
        parent = self.by_id.get((it.get("parent") or {}).get("id"))
        if parent and pos.get("relativeTo") == "parent_top_left" and _depth < 20:
            pcx, pcy, pw, ph = self.box(parent, _depth + 1)
            x += pcx - pw / 2
            y += pcy - ph / 2
        self.cache[iid] = (x, y, w, h)
        return self.cache[iid]

    def top_left(self, it):
        cx, cy, w, h = self.box(it)
        return cx - w / 2, cy - h / 2


# --------------------------------------------------------------------------- Excalidraw

def ex_base(type_, x, y, w, h, **kw):
    el = {
        "id": new_id(), "type": type_, "x": x, "y": y, "width": w, "height": h, "angle": 0,
        "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": 1, "strokeStyle": "solid", "roughness": 0, "opacity": 100,
        "groupIds": [], "frameId": None, "roundness": None, "seed": rnd(), "version": 1,
        "versionNonce": rnd(), "isDeleted": False, "boundElements": [],
        "updated": int(time.time() * 1000), "link": None, "locked": False,
    }
    el.update(kw)
    return el


def ex_text(x, y, text, fs, lines, color="#1e1e1e", align="left", width=None, **kw):
    width = width or max(len(l) for l in lines) * fs * CHAR_WIDTH
    height = len(lines) * fs * LINE_HEIGHT
    params = dict(strokeColor=color, text="\n".join(lines), originalText=text, fontSize=fs,
                  fontFamily=FONT_FAMILY, textAlign=align, verticalAlign="top", containerId=None,
                  lineHeight=LINE_HEIGHT, autoResize=True)
    params.update(kw)
    return ex_base("text", x, y, width, height, **params)


def ex_bound_text(container, text, fs, lines, color="#1e1e1e", align="center", valign="middle", pad=8):
    tw = max(1, container["width"] - 2 * pad)
    th = len(lines) * fs * LINE_HEIGHT
    if valign == "top":
        ty = container["y"] + pad
    elif valign == "bottom":
        ty = container["y"] + container["height"] - pad - th
    else:
        ty = container["y"] + (container["height"] - th) / 2
    t = ex_base("text", container["x"] + pad, ty, tw, th, strokeColor=color, angle=container["angle"],
                text="\n".join(lines), originalText=text, fontSize=fs, fontFamily=FONT_FAMILY,
                textAlign=align, verticalAlign=valign, containerId=container["id"],
                lineHeight=LINE_HEIGHT, autoResize=True, frameId=container["frameId"])
    container["boundElements"].append({"id": t["id"], "type": "text"})
    return t


def stroke_style(s):
    return {"dashed": "dashed", "dotted": "dotted"}.get(s or "", "solid")


def color_or(v, default):
    return v if isinstance(v, str) and v.startswith("#") else default


SHAPE_MAP = {
    "rectangle": ("rectangle", None), "round_rectangle": ("rectangle", {"type": 3}),
    "circle": ("ellipse", None), "ellipse": ("ellipse", None),
    "rhombus": ("diamond", None), "flow_chart_decision": ("diamond", None),
    "flow_chart_terminator": ("rectangle", {"type": 3}), "flow_chart_connector": ("ellipse", None),
}


def convert_item(it, geo, frame_ex_id, files_map, files_out, svg_text=None):
    """Return a list of Excalidraw elements for one Miro item (container first)."""
    t = it.get("type")
    d = it.get("data") or {}
    st = it.get("style") or {}
    cx, cy, w, h = geo.box(it)
    x, y = cx - w / 2, cy - h / 2
    angle = math.radians(num((it.get("geometry") or {}).get("rotation"), 0.0))
    text = item_text(it)
    common = dict(angle=angle, frameId=frame_ex_id, customData={"miroId": it["id"], "miroType": t})
    align = st.get("textAlign") if st.get("textAlign") in ("left", "center", "right") else "center"
    valign = st.get("textAlignVertical") if st.get("textAlignVertical") in ("top", "middle", "bottom") else "middle"

    if t == "sticky_note":
        bg = STICKY_COLORS.get(st.get("fillColor"), color_or(st.get("fillColor"), "#fff9b1"))
        box = ex_base("rectangle", x, y, w, h, backgroundColor=bg, strokeColor="transparent", **common)
        out = [box]
        if text:
            # Miro auto-sizes sticky text, so the starting font grows with the sticky
            fs, lines = svg_text or fit_text(text, w - 16, h - 16, max_fs=int(min(200, max(24, w * 0.18))))
            out.append(ex_bound_text(box, text, fs, lines, "#1e1e1e" if bg != "#000000" else "#ffffff", align, valign))
        return out

    if t == "shape":
        kind, roundness = SHAPE_MAP.get(d.get("shape"), ("rectangle", None))
        fill = st.get("fillColor")
        fill_op = num(st.get("fillOpacity"), 1)
        bg = _blend_white(fill, fill_op) if color_or(fill, None) and fill_op > 0 else "transparent"
        border = color_or(st.get("borderColor"), "#1e1e1e")
        if num(st.get("borderOpacity"), 1) == 0:
            border = "transparent"
        box = ex_base(kind, x, y, w, h, backgroundColor=bg, strokeColor=border, roundness=roundness,
                      strokeWidth=max(1, num(st.get("borderWidth"), 2)), strokeStyle=stroke_style(st.get("borderStyle")),
                      **common)
        box["customData"]["miroShape"] = d.get("shape")
        out = [box]
        if text:
            fs, lines = svg_text or fit_text(text, w - 16, h - 16, num(st.get("fontSize")))
            out.append(ex_bound_text(box, text, fs, lines, color_or(st.get("color"), "#1e1e1e"), align, valign))
        return out

    if t == "text":
        fs = num(st.get("fontSize"), 14)
        lines = wrap_like_miro(text, w, num((it.get("geometry") or {}).get("height")), fs)
        if svg_text:
            fs, lines = svg_text
        width = max(w, max(len(l) for l in lines) * fs * 0.5)
        return [ex_text(x, y, text, fs, lines, color_or(st.get("color"), "#1e1e1e"),
                        st.get("textAlign") if st.get("textAlign") in ("left", "center", "right") else "left",
                        width=width, **common)]

    if t == "stencil":
        # Shapes from Miro's newer shape libraries. Browser (Web SDK) exports only carry their
        # position and size, not their text or colours, so draw a plain rounded box: the layout
        # and the connectors attached to it are kept.
        box = ex_base("rectangle", x, y, w, h, strokeColor="#868e96", roundness={"type": 3}, **common)
        out = [box]
        if text:
            fs, lines = fit_text(text, w - 16, h - 16, max_fs=20)
            out.append(ex_bound_text(box, text, fs, lines))
        return out

    if t == "image" and it["id"] in files_map and files_map[it["id"]]["mime"] in EXCALIDRAW_IMAGE_MIMES:
        f = files_map[it["id"]]
        fid = new_id()
        files_out[fid] = {"mimeType": f["mime"], "id": fid, "created": int(time.time() * 1000),
                          "dataURL": "data:%s;base64,%s" % (f["mime"], base64.b64encode(f["bytes"]).decode())}
        return [ex_base("image", x, y, w, h, fileId=fid, status="saved", scale=[1, 1], **common)]

    if t in ("card", "app_card"):
        box = ex_base("rectangle", x, y, w, h, backgroundColor="#ffffff",
                      strokeColor=color_or(st.get("cardTheme"), "#2d9bf0"), strokeWidth=2,
                      roundness={"type": 3}, **common)
        out = [box]
        if text:
            fs, lines = fit_text(text, w - 16, h - 16, max_fs=16)
            out.append(ex_bound_text(box, text, fs, lines, align="left", valign="top"))
        return out

    # images that could not be downloaded, documents, embeds, previews, unknown types: labelled placeholder
    label = f"[{t}] {text}".strip()
    link = d.get("url") or d.get("documentUrl") or d.get("imageUrl")
    box = ex_base("rectangle", x, y, w, h, strokeStyle="dashed", strokeColor="#868e96",
                  link=link if isinstance(link, str) and link.startswith("http") else None, **common)
    fs, lines = fit_text(label, w - 16, h - 16, max_fs=16)
    return [box, ex_bound_text(box, label, fs, lines, "#495057")]


def pct(v):
    s = str(v).strip()
    return float(s.rstrip("%")) / 100 if s.endswith("%") else float(s)


def anchor_point(end, box, toward):
    """Where a connector touches an item: its explicit anchor, else the box edge facing `toward`."""
    cx, cy, w, h = box
    pos = end.get("position") or {}
    if "x" in pos and "y" in pos:
        try:
            return cx - w / 2 + w * pct(pos["x"]), cy - h / 2 + h * pct(pos["y"])
        except ValueError:
            pass
    dx, dy = toward[0] - cx, toward[1] - cy
    tx = (w / 2) / abs(dx) if dx else math.inf
    ty = (h / 2) / abs(dy) if dy else math.inf
    t = min(tx, ty, 1.0)
    return cx + dx * t, cy + dy * t


def arrowhead(cap):
    cap = (cap or "").lower()
    if cap in ("", "none"):
        return None
    if "triangle" in cap or "stealth" in cap:
        return "triangle"
    if "oval" in cap or "circle" in cap:
        return "dot"
    if "line" in cap or "bar" in cap:
        return "bar"
    return "arrow"


def convert_connector(c, geo, ex_by_miro):
    s_end, e_end = c.get("startItem") or {}, c.get("endItem") or {}
    s_item, e_item = geo.by_id.get(s_end.get("id")), geo.by_id.get(e_end.get("id"))
    if not s_item or not e_item:
        return []
    sb, eb = geo.box(s_item), geo.box(e_item)
    sx, sy = anchor_point(s_end, sb, eb[:2])
    ex, ey = anchor_point(e_end, eb, sb[:2])
    dx, dy = ex - sx, ey - sy
    if c.get("shape") == "elbowed" and abs(dx) > 1 and abs(dy) > 1:
        points = [[0, 0], [dx / 2, 0], [dx / 2, dy], [dx, dy]]
    else:
        points = [[0, 0], [dx, dy]]
    st = c.get("style") or {}
    s_ex, e_ex = ex_by_miro.get(s_end.get("id")), ex_by_miro.get(e_end.get("id"))
    bindable = ("rectangle", "ellipse", "diamond", "image", "text")
    arrow = ex_base(
        "arrow", sx, sy, abs(dx), abs(dy), points=points, lastCommittedPoint=None, elbowed=False,
        strokeColor=color_or(st.get("strokeColor"), "#1e1e1e"),
        strokeWidth=max(1, num(st.get("strokeWidth"), 1)), strokeStyle=stroke_style(st.get("strokeStyle")),
        roundness={"type": 2} if c.get("shape") == "curved" else None,
        startArrowhead=arrowhead(st.get("startStrokeCap")),
        endArrowhead=arrowhead(st.get("endStrokeCap", "stealth")),
        startBinding={"elementId": s_ex["id"], "focus": 0, "gap": 1} if s_ex and s_ex["type"] in bindable else None,
        endBinding={"elementId": e_ex["id"], "focus": 0, "gap": 1} if e_ex and e_ex["type"] in bindable else None,
        customData={"miroId": c.get("id"), "miroType": "connector"},
    )
    for target, binding in ((s_ex, arrow["startBinding"]), (e_ex, arrow["endBinding"])):
        if binding:
            target["boundElements"].append({"id": arrow["id"], "type": "arrow"})
    out = [arrow]
    captions = [html_to_text(cap.get("content")) for cap in (c.get("captions") or [])]
    label = " / ".join(x for x in captions if x)
    if label:
        fs = num(st.get("fontSize"), 14)
        lines = wrap(label, 200, fs)
        lw = max(len(l) for l in lines) * fs * CHAR_WIDTH
        lh = len(lines) * fs * LINE_HEIGHT
        t = ex_base("text", sx + dx / 2 - lw / 2, sy + dy / 2 - lh / 2, lw, lh,
                    strokeColor=color_or(st.get("color"), "#1e1e1e"), text="\n".join(lines),
                    originalText=label, fontSize=fs, fontFamily=FONT_FAMILY, textAlign="center",
                    verticalAlign="middle", containerId=arrow["id"], lineHeight=LINE_HEIGHT, autoResize=True)
        arrow["boundElements"].append({"id": t["id"], "type": "text"})
        out.append(t)
    return out


def to_excalidraw(items, connectors, files_map, svg=None):
    """Build the Excalidraw scene. With `svg` (a SvgBoard), stencils, images, emojis, tables and
    every line's route come from the SVG, and text uses Miro's exact wrapping."""
    geo = Geometry(items)
    frame_ids = {it["id"] for it in items if it.get("type") == "frame"}
    ex_by_miro, frames, files = {}, [], {}
    per_item = {}  # miro id -> elements
    stats = {"from_svg": 0, "lines_without_route": 0}
    if svg:
        svg.calibrate(items, geo)

    for it in items:  # frames first, so children can reference them
        if it.get("type") != "frame":
            continue
        x, y = geo.top_left(it)
        _, _, w, h = geo.box(it)
        fr = ex_base("frame", x, y, w, h, name=item_text(it) or "Frame", strokeColor="#bbbbbb",
                     customData={"miroId": it["id"], "miroType": "frame"})
        ex_by_miro[it["id"]] = fr
        frames.append(fr)

    def frame_of(obj):
        parent = (obj.get("parent") or {}).get("id") or obj.get("parentId")
        return ex_by_miro[parent]["id"] if parent in frame_ids else None

    svg_kinds = ("stencil", "image", "emoji", "table", "table_text", "unsupported")
    for it in items:
        if it.get("type") == "frame":
            continue
        frame_ex = frame_of(it)
        els = None
        in_svg = svg is not None and it["id"] in svg.raw
        unknown_shape = it.get("type") == "shape" and (it.get("data") or {}).get("shape") not in SHAPE_MAP
        if in_svg and (it.get("type") in svg_kinds or unknown_shape or it.get("type") not in TYPE_LABEL):
            els = svg_widget_elements(it, svg, geo, frame_ex, files)
            if els:
                stats["from_svg"] += 1
        if not els:
            svg_text = svg.text_lines(it["id"]) if in_svg and it.get("type") in ("sticky_note", "shape", "text") else None
            els = convert_item(it, geo, frame_ex, files_map, files, svg_text=svg_text)
        if it.get("groupId"):  # Miro groups (only in browser exports) become Excalidraw groups
            for el in els:
                el["groupIds"] = el.get("groupIds", []) + ["g" + str(it["groupId"])]
        ex_by_miro[it["id"]] = els[0]
        per_item[it["id"]] = els

    for c in connectors:
        els = None
        if svg is not None and c.get("id") in svg.raw:
            els = svg_connector_elements(c, svg, ex_by_miro, frame_of(c))
        if not els:
            els = convert_connector(c, geo, ex_by_miro)
        if not els:
            stats["lines_without_route"] += 1
            continue
        if c.get("groupId"):
            for el in els:
                el["groupIds"] = el.get("groupIds", []) + ["g" + str(c["groupId"])]
        per_item[c.get("id")] = els

    # Stacking order: Miro's own (the SVG draws items back to front), else items then lines
    keys = list(per_item)
    if svg is not None:
        pos = {k: n for n, k in enumerate(keys)}
        keys.sort(key=lambda k: svg.z.get(k, len(svg.z) + pos[k]))
    elements = [el for k in keys for el in per_item[k]]
    return {
        "type": "excalidraw", "version": 2, "source": "miro_export.py",
        "elements": elements + frames,  # Excalidraw keeps frames above their children
        "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None},
        "files": files,
    }, stats


# --------------------------------------------------------------------------- SVG enrichment
#
# Miro's "Download as SVG" draws every item inside <g data-widget-id="ID">, where ID is the
# same as in the JSON export. The SVG has what the JSON lacks (stencil shapes and text,
# routes of every line, embedded images and emojis, exact text wrapping), while the JSON
# has the structure (item types, frames, which arrow connects which boxes). We use both.

SVG_NS = "{http://www.w3.org/2000/svg}"
XLINK_HREF = "{http://www.w3.org/1999/xlink}href"
ASCENT = 0.77  # Helvetica ascent as a fraction of the font size (to place text by its baseline)


def _mat_mul(m, n):
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return (a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2,
            a * e2 + c * f2 + e, b * e2 + d * f2 + f)


def _apply(m, x, y):
    a, b, c, d, e, f = m
    return a * x + c * y + e, b * x + d * y + f


def _mat_scale(m):
    return math.sqrt(abs(m[0] * m[3] - m[1] * m[2])) or 1.0


def _mat_angle(m):
    return math.atan2(m[1], m[0])


def parse_transform(t):
    m = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", t or ""):
        v = [float(x) for x in re.findall(r"-?[\d.]+(?:e-?\d+)?", args)]
        if name == "translate":
            n = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == "scale":
            n = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            r = math.radians(v[0])
            cos, sin = math.cos(r), math.sin(r)
            n = (cos, sin, -sin, cos, 0, 0)
            if len(v) == 3:
                n = _mat_mul(_mat_mul((1, 0, 0, 1, v[1], v[2]), n), (1, 0, 0, 1, -v[1], -v[2]))
        elif name == "matrix" and len(v) == 6:
            n = tuple(v)
        else:
            continue
        m = _mat_mul(m, n)
    return m


STYLE_KEYS = ("fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray",
              "font-size", "font-weight", "opacity")


def _style_of(el, parent):
    st = dict(parent)
    for k in STYLE_KEYS:
        if el.get(k) is not None and el.get(k) != "":
            st[k] = el.get(k).strip()
    for decl in (el.get("style") or "").split(";"):
        if ":" in decl:
            k, v = decl.split(":", 1)
            k, v = k.strip(), v.strip()
            if k in STYLE_KEYS and v:
                st[k] = v
            elif k == "font":  # shorthand like 'font: 20px "Noto Sans"'
                mm = re.search(r"([\d.]+)px", v)
                if mm:
                    st["font-size"] = mm.group(1)
    st["opacity"] = str(num(parent.get("opacity"), 1) * num(el.get("opacity"), 1))
    return st


def _path_points(d, m, curve_steps=12):
    """Flatten an SVG path into subpaths of absolute points (with transform m applied)."""
    toks = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", d or "")
    subs, cur, closed = [], [], []
    x = y = sx = sy = 0.0
    i, cmd = 0, None
    last_ctrl = None

    def num_at(k):
        return float(toks[k])

    def add(px, py):
        cur.append(_apply(m, px, py))

    while i < len(toks):
        if re.match(r"[A-Za-z]", toks[i]):
            cmd = toks[i]
            i += 1
            if cmd in "Zz":
                if cur:
                    add(sx, sy)
                    subs.append(cur)
                    closed.append(True)
                cur = []
                x, y = sx, sy
                continue
        if cmd is None:
            i += 1
            continue
        rel = cmd.islower()
        C = cmd.upper()
        try:
            if C == "M":
                nx, ny = num_at(i), num_at(i + 1)
                i += 2
                if rel:
                    nx, ny = x + nx, y + ny
                if cur:
                    subs.append(cur)
                    closed.append(False)
                cur = []
                x, y, sx, sy = nx, ny, nx, ny
                add(x, y)
                cmd = "l" if rel else "L"
            elif C == "L":
                nx, ny = num_at(i), num_at(i + 1)
                i += 2
                x, y = (x + nx, y + ny) if rel else (nx, ny)
                add(x, y)
            elif C == "H":
                nx = num_at(i)
                i += 1
                x = x + nx if rel else nx
                add(x, y)
            elif C == "V":
                ny = num_at(i)
                i += 1
                y = y + ny if rel else ny
                add(x, y)
            elif C in "CQ":
                n = 6 if C == "C" else 4
                v = [num_at(i + k) for k in range(n)]
                i += n
                if rel:
                    v = [v[k] + (x if k % 2 == 0 else y) for k in range(n)]
                pts = [(x, y)] + [(v[k], v[k + 1]) for k in range(0, n, 2)]
                steps = curve_steps if C == "C" else max(3, curve_steps // 3)
                for s in range(1, steps + 1):
                    t = s / steps
                    if C == "C":
                        (x0, y0), (x1, y1), (x2, y2), (x3, y3) = pts
                        px = (1 - t) ** 3 * x0 + 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3 * x3
                        py = (1 - t) ** 3 * y0 + 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3 * y3
                    else:
                        (x0, y0), (x1, y1), (x2, y2) = pts
                        px = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * x1 + t * t * x2
                        py = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * y1 + t * t * y2
                    add(px, py)
                x, y = pts[-1]
            elif C in "ST":  # smooth curves: approximate with a straight segment to the end point
                n = 4 if C == "S" else 2
                v = [num_at(i + k) for k in range(n)]
                i += n
                ex, ey = v[-2], v[-1]
                x, y = (x + ex, y + ey) if rel else (ex, ey)
                add(x, y)
            elif C == "A":
                rx, ry, rot, large, sweep, ex, ey = [num_at(i + k) for k in range(7)]
                i += 7
                if rel:
                    ex, ey = x + ex, y + ey
                for px, py in _arc_points(x, y, rx, ry, rot, large, sweep, ex, ey, curve_steps):
                    add(px, py)
                x, y = ex, ey
            else:
                i += 1
        except (IndexError, ValueError):
            break
    if cur:
        subs.append(cur)
        closed.append(False)
    return list(zip(subs, closed))


def _arc_points(x1, y1, rx, ry, phi, fa, fs, x2, y2, steps):
    """Sample an SVG elliptical arc (endpoint parameterisation, SVG spec F.6.5)."""
    if rx == 0 or ry == 0 or (x1 == x2 and y1 == y2):
        return [(x2, y2)]
    phi = math.radians(phi)
    cos, sin = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = cos * dx + sin * dy, -sin * dx + cos * dy
    rx, ry = abs(rx), abs(ry)
    lam = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num_ = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2
    den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
    coef = math.sqrt(max(0.0, num_ / den)) if den else 0.0
    if fa == fs:
        coef = -coef
    cxp, cyp = coef * rx * y1p / ry, -coef * ry * x1p / rx
    cx = cos * cxp - sin * cyp + (x1 + x2) / 2
    cy = sin * cxp + cos * cyp + (y1 + y2) / 2

    def ang(ux, uy, vx, vy):
        a = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return a

    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not fs and dt > 0:
        dt -= 2 * math.pi
    elif fs and dt < 0:
        dt += 2 * math.pi
    out = []
    for s in range(1, steps + 1):
        t = t1 + dt * s / steps
        out.append((cx + rx * math.cos(t) * cos - ry * math.sin(t) * sin,
                    cy + rx * math.cos(t) * sin + ry * math.sin(t) * cos))
    return out


def _visible(st, key):
    """Colour of fill/stroke if it is actually painted, else None."""
    col = (st.get(key) or "").strip()
    if not col or col in ("none", "transparent"):
        return None
    op = num(st.get(f"{key}-opacity"), 1)
    if key == "stroke" and num(st.get("stroke-width"), 1) == 0:
        return None
    if op <= 0.02:
        return None
    return _blend_white(col, op) if op < 0.99 else col


def _blend_white(col, alpha):
    mm = re.fullmatch(r"#([0-9a-fA-F]{6})", col)
    if not mm:
        return col
    r, g, b = (int(mm.group(1)[k:k + 2], 16) for k in (0, 2, 4))
    mix = lambda c: round(c * alpha + 255 * (1 - alpha))  # noqa: E731
    return "#%02x%02x%02x" % (mix(r), mix(g), mix(b))


class SvgBoard:
    def __init__(self, path):
        import xml.etree.ElementTree as ET
        text = open(path, encoding="utf-8").read()
        self.path = path
        self.name = os.path.splitext(os.path.basename(path))[0]
        self.order, self.raw = [], {}
        tag = re.compile(r"<(/?)g\b[^>]*?(/?)>")
        for mm in re.finditer(r'<g data-widget-id="(\d+)">', text):
            depth = 0
            for t in tag.finditer(text, mm.start()):
                depth += -1 if t.group(1) else (0 if t.group(2) else 1)
                if depth == 0:
                    self.raw[mm.group(1)] = text[mm.start():t.end()]
                    self.order.append(mm.group(1))
                    break
        self._ET = ET
        self._parsed = {}
        self.offset = (0.0, 0.0)
        self.z = {wid: k for k, wid in enumerate(self.order)}

    def ids(self):
        return set(self.raw)

    def tree(self, wid):
        if wid not in self._parsed:
            xml = ('<root xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">'
                   + self.raw[wid] + "</root>")
            try:
                self._parsed[wid] = self._ET.fromstring(xml)[0]
            except self._ET.ParseError:
                self._parsed[wid] = None
        return self._parsed[wid]

    def calibrate(self, items, geo):
        """SVG coordinates = board coordinates + offset. Estimate the offset from frames/shapes."""
        dxs, dys = [], []
        for it in items:
            if it["id"] not in self.raw or it.get("type") not in ("frame", "shape", "stencil", "sticky_note"):
                continue
            node = self.tree(it["id"])
            first = next((c for c in list(node) if c.get("transform")), None) if node is not None else None
            if first is None:
                continue
            m = parse_transform(first.get("transform"))
            if abs(_mat_angle(m)) > 1e-3:
                continue
            x, y = geo.top_left(it)
            dxs.append(m[4] - x)
            dys.append(m[5] - y)
        if dxs:
            dxs.sort()
            dys.sort()
            self.offset = (dxs[len(dxs) // 2], dys[len(dys) // 2])
        return len(dxs)

    def to_board(self, p):
        return p[0] - self.offset[0], p[1] - self.offset[1]

    def primitives(self, wid):
        """Flatten one widget into drawing primitives, in board coordinates."""
        node = self.tree(wid)
        out = []
        if node is None:
            return out

        def walk(el, m, st, depth=0):
            tag = el.tag.replace(SVG_NS, "")
            if tag in ("clipPath", "defs", "style", "mask", "filter") or depth > 40:
                return
            m = _mat_mul(m, parse_transform(el.get("transform")))
            st = _style_of(el, st)
            if el.get("clip-path") and tag in ("path", "rect", "ellipse") and st.get("stroke-width"):
                st["stroke-width"] = str(num(st["stroke-width"], 0) / 2)  # half of the stroke is clipped away
            s = _mat_scale(m)
            if tag == "rect":
                x, y = num(el.get("x"), 0), num(el.get("y"), 0)
                w, h = num(el.get("width"), 0), num(el.get("height"), 0)
                out.append(self._box("rect", m, x, y, w, h, st, rx=num(el.get("rx"), 0) * s))
            elif tag in ("ellipse", "circle"):
                cx, cy = num(el.get("cx"), 0), num(el.get("cy"), 0)
                rx = num(el.get("rx"), None) or num(el.get("r"), 0)
                ry = num(el.get("ry"), None) or num(el.get("r"), 0)
                out.append(self._box("ellipse", m, cx - rx, cy - ry, 2 * rx, 2 * ry, st))
            elif tag == "line":
                p1 = self.to_board(_apply(m, num(el.get("x1"), 0), num(el.get("y1"), 0)))
                p2 = self.to_board(_apply(m, num(el.get("x2"), 0), num(el.get("y2"), 0)))
                out.append({"kind": "poly", "pts": [p1, p2], "closed": False, "st": st, "scale": s})
            elif tag in ("path", "polyline", "polygon"):
                d = el.get("d")
                if tag != "path":
                    nums_ = re.findall(r"-?[\d.]+", el.get("points") or "")
                    d = "M " + " ".join(nums_[:2]) + " L " + " ".join(nums_[2:]) + (" Z" if tag == "polygon" else "")
                for pts, closed in _path_points(d, m):
                    if len(pts) >= 2:
                        out.append({"kind": "poly", "pts": [self.to_board(p) for p in pts], "closed": closed, "st": st, "scale": s})
            elif tag == "text":
                txt = "".join(el.itertext())
                if txt.strip():
                    fs = num(st.get("font-size"), 14) * s
                    x, y = num(el.get("x"), 0), num(el.get("y"), 0) + num(el.get("dy"), 0)
                    bx, by = self.to_board(_apply(m, x, y))
                    width = (num(el.get("textLength"), None) or num(el.get("width"), None) or len(txt) * 0.55 * fs / s) * s
                    out.append({"kind": "text", "text": txt.rstrip(), "x": bx, "y": by, "fs": fs, "w": width,
                                "fill": el.get("fill") or st.get("fill") or "#1a1a1a",
                                "bold": (el.get("font-weight") or st.get("font-weight") or "") in ("bold", "600", "700"),
                                "angle": _mat_angle(m)})
            elif tag == "image":
                href = el.get("href") or el.get(XLINK_HREF) or ""
                if el.get("data-frame") == "true":
                    return
                w = num((el.get("width") or "0").replace("px", ""), 0)
                h = num((el.get("height") or "0").replace("px", ""), 0)
                box = self._box("image", m, 0, 0, w, h, st)
                box["href"] = href
                out.append(box)
            elif tag == "use":
                href = el.get(XLINK_HREF) or el.get("href") or ""
                out.append({"kind": "use", "ref": href.lstrip("#"), "at": self.to_board(_apply(m, 0, 0)),
                            "fill": el.get("fill")})
            for child in list(el):
                walk(child, m, st, depth + 1)

        walk(node, (1.0, 0.0, 0.0, 1.0, 0.0, 0.0), {"fill": "black", "opacity": "1"})
        return out

    def _box(self, kind, m, x, y, w, h, st, rx=0.0):
        s = _mat_scale(m)
        cx, cy = self.to_board(_apply(m, x + w / 2, y + h / 2))
        return {"kind": kind, "cx": cx, "cy": cy, "w": w * s, "h": h * s, "angle": _mat_angle(m),
                "st": st, "rx": rx, "scale": s}

    def text_lines(self, wid):
        """(font size, lines) of the text drawn inside a widget, exactly as Miro wrapped it."""
        texts = [p for p in self.primitives(wid) if p["kind"] == "text"]
        if not texts:
            return None
        texts.sort(key=lambda t: (round(t["y"], 1), t["x"]))
        return texts[0]["fs"], [t["text"] for t in texts]


def _ex_style(st, scale=1.0):
    stroke = _visible(st, "stroke")
    fill = _visible(st, "fill")
    dash = (st.get("stroke-dasharray") or "").strip()
    return {
        "strokeColor": stroke or "transparent",
        "backgroundColor": fill or "transparent",
        "strokeWidth": max(0.5, round(num(st.get("stroke-width"), 1) * scale, 2)) if stroke else 1,
        "strokeStyle": "solid" if dash in ("", "none") else ("dotted" if dash.split(",")[0].strip() in ("1", "2") else "dashed"),
        "opacity": max(1, min(100, round(num(st.get("opacity"), 1) * 100))),
    }


def _text_blocks(texts):
    """Group consecutive text lines (same size, regular spacing) into multi-line blocks."""
    texts = sorted(texts, key=lambda t: (round(t["y"], 1), t["x"]))
    blocks = []
    for t in texts:
        b = blocks[-1] if blocks else None
        if (b and abs(b[-1]["fs"] - t["fs"]) < 0.5 and abs(b[-1]["angle"] - t["angle"]) < 1e-3
                and 0 < t["y"] - b[-1]["y"] <= 1.9 * t["fs"]
                and min(abs(t["x"] - b[0]["x"]), abs((t["x"] + t["w"] / 2) - (b[0]["x"] + b[0]["w"] / 2))) < 2 * t["fs"]):
            b.append(t)
        else:
            blocks.append([t])
    return blocks


def _text_element(block, frame_id, extra=None):
    fs = block[0]["fs"]
    lh = (block[-1]["y"] - block[0]["y"]) / (len(block) - 1) / fs if len(block) > 1 else LINE_HEIGHT
    lh = min(max(lh, 1.0), 2.5)
    lefts = [t["x"] for t in block]
    centers = [t["x"] + t["w"] / 2 for t in block]
    rights = [t["x"] + t["w"] for t in block]
    if max(lefts) - min(lefts) < 2:
        align = "left"
    elif max(centers) - min(centers) < 2:
        align = "center"
    elif max(rights) - min(rights) < 2:
        align = "right"
    else:
        align = "left"
    width = max(t["w"] for t in block)
    x = {"left": min(lefts), "center": centers[0] - width / 2, "right": max(rights) - width}[align]
    top = block[0]["y"] - ((lh - 1) / 2 + ASCENT) * fs
    text = "\n".join(t["text"] for t in block)
    el = ex_text(x, top, text, round(fs, 2), text.split("\n"), color_or(block[0]["fill"], "#1a1a1a"), align,
                 width=width, frameId=frame_id, angle=block[0]["angle"], lineHeight=round(lh, 3))
    el["height"] = len(block) * fs * lh
    if extra:
        el.update(extra)
    return el


IMAGE_MIMES_FROM_HREF = re.compile(r"data:(image/[\w+.-]+)(;base64)?(?:;utf8)?,(.*)", re.S)


def _image_file(href):
    """Turn an SVG <image href> into (mime, bytes), or None."""
    mm = IMAGE_MIMES_FROM_HREF.match(href or "")
    if not mm:
        return None
    mime, is_b64, data = mm.groups()
    try:
        body = base64.b64decode(data) if is_b64 else urllib.parse.unquote(data).encode("utf-8")
    except Exception:
        return None
    return mime, body


def svg_widget_elements(it, svg, geo, frame_ex_id, files_out):
    """Excalidraw elements for one item drawn from its SVG (stencils, images, emojis, tables...).
    The first element returned is the one arrows bind to. Returns None if nothing usable."""
    prims = svg.primitives(it["id"])
    if not prims:
        return None
    common = {"frameId": frame_ex_id, "customData": {"miroId": it["id"], "miroType": it.get("type"), "source": "svg"}}
    shapes, texts, images = [], [], []
    for p in prims:
        if p["kind"] in ("rect", "ellipse", "poly"):
            shapes.append(p)
        elif p["kind"] == "text":
            texts.append(p)
        elif p["kind"] == "image":
            images.append(p)
    # Widget bounding box, from the JSON geometry (board coordinates)
    bcx, bcy, geo_w, geo_h = geo.box(it)
    pos = (bcx, bcy)
    els = []

    # Images and emojis: a single embedded picture
    if images and not shapes:
        img = images[0]
        f = _image_file(img["href"])
        if f and f[0] in EXCALIDRAW_IMAGE_MIMES:
            fid = new_id()
            files_out[fid] = {"mimeType": f[0], "id": fid, "created": int(time.time() * 1000),
                              "dataURL": "data:%s;base64,%s" % (f[0], base64.b64encode(f[1]).decode())}
            return [ex_base("image", img["cx"] - img["w"] / 2, img["cy"] - img["h"] / 2, img["w"], img["h"],
                            fileId=fid, status="saved", scale=[1, 1], angle=img["angle"], **common)]
        return None

    # Is there one shape covering the whole widget? Then it is the container (text binds to it).
    container = None
    if pos and geo_w and geo_h:
        cx, cy = pos
        for p in shapes:
            if p["kind"] in ("rect", "ellipse") and abs(p["w"] - geo_w) < 3 and abs(p["h"] - geo_h) < 3 \
                    and abs(p["cx"] - cx) < 3 and abs(p["cy"] - cy) < 3 and (_visible(p["st"], "fill") or _visible(p["st"], "stroke")):
                container = p
                break

    def box_el(p):
        kind = "rectangle" if p["kind"] == "rect" else "ellipse"
        return ex_base(kind, p["cx"] - p["w"] / 2, p["cy"] - p["h"] / 2, p["w"], p["h"], angle=p["angle"],
                       roundness={"type": 3} if p["kind"] == "rect" and p.get("rx", 0) > 1 else None,
                       **_ex_style(p["st"], p.get("scale", 1)), **common)

    def poly_el(p):
        pts = p["pts"]
        x0, y0 = pts[0]
        rel = [[round(px - x0, 2), round(py - y0, 2)] for px, py in pts]
        xs, ys = [q[0] for q in rel], [q[1] for q in rel]
        style = _ex_style(p["st"], p.get("scale", 1))
        if not p["closed"]:
            style["backgroundColor"] = "transparent"
        return ex_base("line", x0, y0, max(xs) - min(xs), max(ys) - min(ys), points=rel, lastCommittedPoint=None,
                       startBinding=None, endBinding=None, startArrowhead=None, endArrowhead=None,
                       polygon=bool(p["closed"]), **style, **common)

    if container is not None:
        main = box_el(container)
    else:
        # invisible box for arrows to attach to (e.g. stick-figure actors)
        if pos and geo_w and geo_h:
            main = ex_base("rectangle", pos[0] - geo_w / 2, pos[1] - geo_h / 2, geo_w, geo_h,
                           strokeColor="transparent", **common)
        else:
            main = None
    if main is not None:
        els.append(main)
    for p in shapes:
        if p is container:
            continue
        if p["kind"] in ("rect", "ellipse"):
            if not (_visible(p["st"], "fill") or _visible(p["st"], "stroke")):
                continue
            els.append(box_el(p))
        elif _visible(p["st"], "stroke") or (p["closed"] and _visible(p["st"], "fill")):
            els.append(poly_el(p))
    blocks = _text_blocks(texts)
    if container is not None and len(blocks) == 1 and abs(blocks[0][0]["angle"]) < 1e-3:
        # Text inside the shape: bind it so it moves and wraps with the shape
        b = blocks[0]
        t = _text_element(b, frame_ex_id)
        t.update(containerId=main["id"], verticalAlign="middle", textAlign="center")
        t["x"] = main["x"] + 4
        t["width"] = max(1, main["width"] - 8)
        main["boundElements"].append({"id": t["id"], "type": "text"})
        els.append(t)
    else:
        for b in blocks:
            els.append(_text_element(b, frame_ex_id))
    for p in images:
        f = _image_file(p.get("href"))
        if f and f[0] in EXCALIDRAW_IMAGE_MIMES:
            fid = new_id()
            files_out[fid] = {"mimeType": f[0], "id": fid, "created": int(time.time() * 1000),
                              "dataURL": "data:%s;base64,%s" % (f[0], base64.b64encode(f[1]).decode())}
            els.append(ex_base("image", p["cx"] - p["w"] / 2, p["cy"] - p["h"] / 2, p["w"], p["h"],
                               fileId=fid, status="saved", scale=[1, 1], angle=p["angle"], **common))
    if len(els) > 1:  # keep the pieces of one stencil together
        gid = "w" + it["id"]
        for el in els:
            el["groupIds"] = [gid]
    return els or None


def svg_connector_elements(c, svg, ex_by_miro, frame_ex_id):
    """An arrow following the exact route Miro drew (works for unattached lines too)."""
    prims = svg.primitives(c["id"])
    polys = [p for p in prims if p["kind"] == "poly"]
    if not polys:
        return None
    route = max(polys, key=lambda p: len(p["pts"]))
    pts = [route["pts"][0]]
    for p in route["pts"][1:]:
        if math.dist(p, pts[-1]) > 0.5:
            pts.append(p)
    if len(pts) < 2:
        pts.append((pts[0][0] + 0.01, pts[0][1]))
    # Miro shortens the line under the arrowhead; extend it to the arrowhead's tip
    for u in (p for p in prims if p["kind"] == "use" and p["ref"].startswith("LineHead")):
        if math.dist(u["at"], pts[-1]) <= math.dist(u["at"], pts[0]):
            if math.dist(u["at"], pts[-1]) < 40:
                pts[-1] = u["at"]
        elif math.dist(u["at"], pts[0]) < 40:
            pts[0] = u["at"]
    st = c.get("style") or {}
    x0, y0 = pts[0]
    rel = [[round(px - x0, 2), round(py - y0, 2)] for px, py in pts]
    xs, ys = [q[0] for q in rel], [q[1] for q in rel]
    s_end, e_end = c.get("startItem") or {}, c.get("endItem") or {}
    s_ex, e_ex = ex_by_miro.get(s_end.get("id")), ex_by_miro.get(e_end.get("id"))
    bindable = ("rectangle", "ellipse", "diamond", "image", "text")
    style = _ex_style(route["st"], route.get("scale", 1))
    arrow = ex_base(
        "arrow", x0, y0, max(xs) - min(xs), max(ys) - min(ys), points=rel, lastCommittedPoint=None, elbowed=False,
        strokeColor=color_or(st.get("strokeColor"), style["strokeColor"]),
        strokeWidth=max(1, num(st.get("strokeWidth"), style["strokeWidth"])),
        strokeStyle=stroke_style(st.get("strokeStyle")) if st.get("strokeStyle") else style["strokeStyle"],
        roundness=None,
        startArrowhead=arrowhead(st.get("startStrokeCap")),
        endArrowhead=arrowhead(st.get("endStrokeCap", "none")),
        startBinding={"elementId": s_ex["id"], "focus": 0, "gap": 1} if s_ex and s_ex["type"] in bindable else None,
        endBinding={"elementId": e_ex["id"], "focus": 0, "gap": 1} if e_ex and e_ex["type"] in bindable else None,
        frameId=frame_ex_id,
        customData={"miroId": c.get("id"), "miroType": "connector", "source": "svg"},
    )
    for target, binding in ((s_ex, arrow["startBinding"]), (e_ex, arrow["endBinding"])):
        if binding:
            target["boundElements"].append({"id": arrow["id"], "type": "arrow"})
    out = [arrow]
    # Captions, placed (and rotated) exactly where Miro drew them
    texts = [p for p in prims if p["kind"] == "text"]
    if texts:
        gid = "w" + str(c.get("id"))
        arrow["groupIds"] = [gid]
        for b in _text_blocks(texts):
            t = _text_element(b, frame_ex_id, {"groupIds": [gid]})
            out.append(t)
    return out


def match_svgs(json_paths, svg_paths):
    """Pair each SVG with the JSON export of the same board (they share item IDs)."""
    pairs = {}
    if not svg_paths:
        return pairs
    id_sets = {}
    for jp in json_paths:
        try:
            with open(jp, encoding="utf-8") as fh:
                doc = json.load(fh)
            recs = doc.get("items", []) + doc.get("connectors", []) if isinstance(doc, dict) else doc
            id_sets[jp] = {str(r.get("id")) for r in recs if isinstance(r, dict)}
        except Exception:
            id_sets[jp] = set()
    for sp in svg_paths:
        with open(sp, encoding="utf-8") as fh:
            wids = set(re.findall(r'data-widget-id="(\d+)"', fh.read()))
        best = max(id_sets, key=lambda jp: len(wids & id_sets[jp]), default=None)
        if best and wids & id_sets[best]:
            pairs[best] = sp
        else:
            log(f"    no JSON export matches {sp}")
    return pairs


# --------------------------------------------------------------------------- Markdown

TYPE_LABEL = {"sticky_note": "Sticky", "shape": "Shape", "text": "Text", "card": "Card",
              "app_card": "App card", "image": "Image", "document": "Document",
              "embed": "Embed", "preview": "Link"}


def to_markdown(board, items, connectors, item_tags, mindmap):
    geo = Geometry(items)
    frames = [it for it in items if it.get("type") == "frame"]
    frame_ids = {f["id"] for f in frames}

    def reading_order(it):
        x, y = geo.top_left(it)
        return (round(y / 40), x)

    groups = {f["id"]: [] for f in frames}
    groups[None] = []
    for it in items:
        if it.get("type") == "frame":
            continue
        p = (it.get("parent") or {}).get("id")
        groups[p if p in frame_ids else None].append(it)

    def line(it):
        d, st = it.get("data") or {}, it.get("style") or {}
        label = TYPE_LABEL.get(it.get("type"), it.get("type"))
        bits = []
        if it.get("type") == "sticky_note" and st.get("fillColor"):
            bits.append(st["fillColor"])
        tags = item_tags.get(it["id"])
        if tags:
            bits.append("tags: " + ", ".join(tags))
        meta = f" ({'; '.join(bits)})" if bits else ""
        text = item_text(it)
        if it.get("type") in ("embed", "preview") and d.get("url"):
            text = f"{text} <{d['url']}>" if text != d["url"] else f"<{d['url']}>"
        if not text:
            return None  # nothing readable to list (empty shapes, stencils, images without a title)
        body = text.replace("\n", "\n  ")
        return f"- **{label}**{meta}: {body}"

    out = [f"# {board.get('name') or 'Untitled board'}", ""]
    if board.get("description"):
        out += [board["description"], ""]
    if board.get("viewLink"):
        out += [f"Source: {board['viewLink']}", ""]
    for f in sorted(frames, key=reading_order) + [None]:
        members = groups[f["id"] if f else None]
        if f is None and not members:
            continue
        out += [f"## {item_text(f) or 'Untitled frame'}" if f else "## Outside frames", ""]
        lines = [l for l in (line(it) for it in sorted(members, key=reading_order)) if l]
        out += (lines or ["_(empty)_"]) + [""]

    short = {it["id"]: (item_text(it).split("\n")[0][:60] or it.get("type")) for it in items}
    if connectors:
        out += ["## Connections", ""]
        for c in connectors:
            a = short.get((c.get("startItem") or {}).get("id"), "?")
            b = short.get((c.get("endItem") or {}).get("id"), "?")
            cap = " / ".join(html_to_text(x.get("content")) for x in (c.get("captions") or []) if x.get("content"))
            out.append(f"- {a} → {b}" + (f" ({cap})" if cap else ""))
        out.append("")
    if mindmap:
        out += ["## Mind map nodes", ""]
        out += [f"- {item_text(n)}" for n in mindmap if item_text(n)] + [""]
    return "\n".join(out)


# --------------------------------------------------------------------------- export

def with_query(url, **params):
    parts = urllib.parse.urlsplit(url)
    q = dict(urllib.parse.parse_qsl(parts.query))
    q.update(params)
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(q)))


def download_files(miro, items, dest):
    """Download images and documents. Returns {item_id: {path, mime, bytes}}."""
    found = {}
    for it in items:
        d = it.get("data") or {}
        if it.get("type") == "image" and d.get("imageUrl"):
            url = with_query(d["imageUrl"], format="original", redirect="false")
        elif it.get("type") == "document" and d.get("documentUrl"):
            url = with_query(d["documentUrl"], redirect="false")
        else:
            continue
        try:
            meta = miro.get(url)
            real = meta.get("url") if isinstance(meta, dict) else None
            if not real:
                raise MiroError("no download URL returned")
            body, headers = miro.fetch(real, auth=False)
            mime = (headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
            title_ext = os.path.splitext(d.get("title") or "")[1]
            ext = EXT_BY_MIME.get(mime) or title_ext or ".bin"
            name = slug(os.path.splitext(d.get("title") or "")[0], 40)
            fname = f"{name}__{it['id']}{ext}" if name != "untitled" else f"{it['id']}{ext}"
            os.makedirs(dest, exist_ok=True)
            with open(os.path.join(dest, fname), "wb") as fh:
                fh.write(body)
            found[it["id"]] = {"path": "files/" + fname, "mime": mime, "bytes": body}
        except Exception as e:  # keep going: one broken file should not stop the export
            log(f"    could not download {it.get('type')} {it['id']}: {e}")
    return found


def export_board(miro, board, out_root, with_files=True):
    bid = board["id"]
    name = board.get("name") or "Untitled"
    folder = os.path.join(out_root, f"{slug(name)}__{slug(bid, 30)}")
    os.makedirs(folder, exist_ok=True)

    items = list(miro.paginate(bpath(bid) + "/items"))
    connectors = list(miro.paginate(bpath(bid) + "/connectors"))
    tags, item_tags, mindmap = [], {}, []
    try:
        tags = list(miro.paginate(bpath(bid) + "/tags"))
        for tag in tags:
            for it in miro.paginate(bpath(bid) + "/items", tag_id=tag["id"]):
                item_tags.setdefault(it["id"], []).append(tag.get("title") or tag["id"])
    except MiroError as e:
        log(f"    tags skipped: {e}")
    try:
        mindmap = list(miro.paginate("/v2-experimental/boards/" + urllib.parse.quote(bid, safe="") + "/mindmap_nodes"))
    except MiroError:
        pass  # experimental endpoint; not available everywhere

    files_map = download_files(miro, items, os.path.join(folder, "files")) if with_files else {}

    raw = {
        "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "board": board, "items": items, "connectors": connectors, "tags": tags,
        "itemTags": item_tags, "mindmapNodes": mindmap,
        "files": {k: {"path": v["path"], "mime": v["mime"]} for k, v in files_map.items()},
    }
    with open(os.path.join(folder, "raw.json"), "w", encoding="utf-8") as fh:
        json.dump(raw, fh, ensure_ascii=False, indent=2)
    with open(os.path.join(folder, slug(name) + ".excalidraw"), "w", encoding="utf-8") as fh:
        json.dump(to_excalidraw(items, connectors, files_map)[0], fh, ensure_ascii=False)
    with open(os.path.join(folder, slug(name) + ".md"), "w", encoding="utf-8") as fh:
        fh.write(to_markdown(board, items, connectors, item_tags, mindmap))

    counts = {}
    for it in items:
        counts[it.get("type")] = counts.get(it.get("type"), 0) + 1
    return {"id": bid, "name": name, "folder": os.path.basename(folder), "items": len(items),
            "connectors": len(connectors), "files": len(files_map), "types": counts}


# --------------------------------------------------------------------------- offline conversion

SDK_DATA_FIELDS = {  # Web SDK flat fields that the REST API nests under "data"
    "sticky_note": ("content", "shape"), "shape": ("content", "shape"), "text": ("content",),
    "frame": ("title",), "card": ("title", "description"), "app_card": ("title", "description"),
    "image": ("title",), "document": ("title",), "embed": ("url",), "preview": ("url",),
}


def sdk_end(end):
    if not end or not end.get("item"):
        return {}
    pos = end.get("position") or {}
    out = {"id": end["item"]}
    if "x" in pos and "y" in pos:
        out["position"] = {"x": pos["x"], "y": pos["y"]}  # fractions 0..1, understood by pct()
    return out


def normalize_sdk(records):
    """Convert a Web SDK `miro.board.get()` dump into the REST API shape used by the converters."""
    items, connectors, skipped = [], [], 0
    for r in records:
        t = r.get("type")
        if t == "group":
            continue  # group membership is already on each item as groupId
        if t == "connector":
            c = {"id": r.get("id"), "shape": r.get("shape"), "style": r.get("style") or {},
                 "captions": r.get("captions") or [], "groupId": r.get("groupId"),
                 "startItem": sdk_end(r.get("start")), "endItem": sdk_end(r.get("end"))}
            if not (c["startItem"] and c["endItem"]):
                skipped += 1  # not attached at both ends: only drawable with the SVG export
            if r.get("parentId"):
                c["parentId"] = r["parentId"]
            connectors.append(c)
            continue
        data = {k: r[k] for k in SDK_DATA_FIELDS.get(t, ()) if r.get(k) is not None}
        if t == "image" and r.get("url"):
            data["imageUrl"] = r["url"]
        if t == "document" and r.get("url"):
            data["documentUrl"] = r["url"]
        item = {
            "id": r.get("id"), "type": t, "data": data, "style": r.get("style") or {},
            "position": {"x": r.get("x") or 0, "y": r.get("y") or 0,
                         "origin": r.get("origin", "center"), "relativeTo": r.get("relativeTo", "canvas_center")},
            "geometry": {k: r[k] for k in ("width", "height", "rotation") if r.get(k) is not None},
            "groupId": r.get("groupId"), "createdAt": r.get("createdAt"), "modifiedAt": r.get("modifiedAt"),
        }
        if r.get("parentId"):
            item["parent"] = {"id": r["parentId"]}
        if r.get("tagIds"):
            item["tagIds"] = r["tagIds"]
        items.append(item)
    return items, connectors, skipped


def fetch_public_images(items, dest):
    """Best effort: download images whose URL works without logging in."""
    found = {}
    for it in items:
        url = (it.get("data") or {}).get("imageUrl")
        if it.get("type") != "image" or not (isinstance(url, str) and url.startswith("http")):
            continue
        try:
            with urllib.request.urlopen(urllib.request.Request(url), timeout=30) as resp:
                body = resp.read()
                mime = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
            if mime not in EXCALIDRAW_IMAGE_MIMES:
                raise ValueError(f"not an image ({mime or 'unknown type'})")
            os.makedirs(dest, exist_ok=True)
            fname = f"{it['id']}{EXT_BY_MIME.get(mime, '.bin')}"
            with open(os.path.join(dest, fname), "wb") as fh:
                fh.write(body)
            found[it["id"]] = {"path": "files/" + fname, "mime": mime, "bytes": body}
        except Exception as e:
            log(f"    image {it['id']} kept as a link only: {e}")
    return found


def convert_json_file(path, out_dir=None, with_files=True, svg_path=None):
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    stem = os.path.splitext(os.path.basename(path))[0]
    out_dir = out_dir or os.path.dirname(os.path.abspath(path))
    os.makedirs(out_dir, exist_ok=True)
    skipped = 0

    if isinstance(doc, dict) and "items" in doc and "board" in doc:  # raw.json from this script
        board, items, connectors = doc["board"], doc["items"], doc.get("connectors", [])
        item_tags, mindmap = doc.get("itemTags", {}), doc.get("mindmapNodes", [])
        files_map = {}
        base = os.path.dirname(os.path.abspath(path))
        for iid, f in (doc.get("files") or {}).items():
            fp = os.path.join(base, f["path"])
            if os.path.exists(fp):
                with open(fp, "rb") as fh:
                    files_map[iid] = dict(f, bytes=fh.read())
        if stem == "raw":
            stem = slug(board.get("name") or "board")
    else:  # browser / Web SDK export: a list of items (or {"items": [...]})
        records = doc.get("items", doc.get("data", [])) if isinstance(doc, dict) else doc
        if not isinstance(records, list):
            raise ValueError("unrecognised JSON layout (expected a list of Miro items)")
        items, connectors, skipped = normalize_sdk(records)
        m = re.match(r"miro_(.+)$", stem)
        board = {"name": stem, "id": m.group(1) if m else None}
        if m:
            bid = m.group(1) + ("=" if len(m.group(1)) == 11 else "")  # board IDs end with "="
            board["viewLink"] = f"https://miro.com/app/board/{bid}/"
        item_tags, mindmap = {}, []
        files_map = fetch_public_images(items, os.path.join(out_dir, "files")) if with_files else {}

    svg = SvgBoard(svg_path) if svg_path else None
    if svg:
        stem = slug(svg.name, 80)  # the SVG is named after the board
        board["name"] = svg.name
    scene, stats = to_excalidraw(items, connectors, files_map, svg)
    skipped = stats["lines_without_route"]
    md = to_markdown(board, items, connectors, item_tags, mindmap)
    if skipped:
        md += (f"\n> Note: {skipped} line(s) drawn without being attached to items could not be placed:"
               " the export has no coordinates for them.\n")
    in_svg = svg.ids() if svg else set()
    stencils = sum(1 for it in items if it.get("type") == "stencil" and it["id"] not in in_svg)
    blank_images = sum(1 for it in items if it.get("type") == "image" and it["id"] not in files_map and it["id"] not in in_svg)
    if stencils:
        md += (f"\n> Note: {stencils} shape(s) from Miro's shape libraries (\"stencils\") were exported with"
               " their position and size only; their text and colours are not in this export.\n")
    if blank_images:
        md += f"\n> Note: {blank_images} image(s) have no file in this export and appear as placeholders.\n"
    ex_path = os.path.join(out_dir, stem + ".excalidraw")
    md_path = os.path.join(out_dir, stem + ".md")
    with open(ex_path, "w", encoding="utf-8") as fh:
        json.dump(scene, fh, ensure_ascii=False)
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(md)
    return {"items": len(items), "connectors": len(connectors) - skipped, "skipped_lines": skipped,
            "images": len(scene["files"]), "stencils": stencils, "from_svg": stats["from_svg"],
            "svg": svg_path, "excalidraw": ex_path, "markdown": md_path}


def board_id_from(arg):
    m = re.search(r"/board/([^/?#]+)", arg)
    return urllib.parse.unquote(m.group(1)) if m else arg.strip()


def main():
    ap = argparse.ArgumentParser(description="Export Miro boards to JSON, Excalidraw and Markdown.")
    ap.add_argument("--token", default=os.environ.get("MIRO_TOKEN"), help="OAuth access token (or set MIRO_TOKEN)")
    ap.add_argument("--board", action="append", help="board ID or board URL; repeat for several (default: all)")
    ap.add_argument("--out", default="miro_export", help="output folder (default: ./miro_export)")
    ap.add_argument("--no-files", action="store_true", help="skip downloading images and documents")
    ap.add_argument("--from-json", nargs="+", metavar="FILE",
                    help="convert already-exported JSON files offline (no token); output goes next to "
                         "each file unless --out is given explicitly")
    ap.add_argument("--svg", nargs="+", metavar="FILE", default=[],
                    help="with --from-json: SVG downloads of the same boards (Miro > Export > SVG). Each is "
                         "matched to its JSON automatically and fills in what the JSON lacks")
    args = ap.parse_args()

    if args.from_json:
        out_dir = args.out if "--out" in sys.argv else None
        failed = 0
        svg_for = match_svgs(args.from_json, args.svg)
        for path in args.from_json:
            log(f"Converting {path}" + (f"  (+ {os.path.basename(svg_for[path])})" if path in svg_for else ""))
            try:
                r = convert_json_file(path, out_dir, with_files=not args.no_files, svg_path=svg_for.get(path))
                note = f", {r['skipped_lines']} line(s) without position skipped" if r["skipped_lines"] else ""
                note += f", {r['stencils']} stencil(s) without content" if r["stencils"] else ""
                note += f", {r['from_svg']} item(s) drawn from the SVG" if r["from_svg"] else ""
                log(f"    {r['items']} items, {r['connectors']} lines, {r['images']} images{note}")
                log(f"    -> {r['excalidraw']}\n    -> {r['markdown']}")
            except Exception as e:
                failed += 1
                log(f"    FAILED: {e}")
        sys.exit(1 if failed else 0)

    token = args.token or getpass.getpass("Miro access token (input hidden): ").strip()
    if not token:
        sys.exit("No token given.")
    miro = Miro(token)
    os.makedirs(args.out, exist_ok=True)

    try:
        if args.board:
            boards = [miro.get(bpath(board_id_from(b))) for b in args.board]
        else:
            log("Listing boards...")
            boards = list(miro.paginate("/v2/boards", sort="alphabetically"))
    except MiroError as e:
        sys.exit(f"Could not list boards: {e}\nCheck that the token is valid and has the boards:read scope.")
    log(f"{len(boards)} board(s) to export into {os.path.abspath(args.out)}")

    summary, failures = [], []
    for i, b in enumerate(boards, 1):
        log(f"[{i}/{len(boards)}] {b.get('name')!r}")
        try:
            r = export_board(miro, b, args.out, with_files=not args.no_files)
            summary.append(r)
            log(f"    {r['items']} items, {r['connectors']} connectors, {r['files']} files")
        except Exception as e:
            failures.append({"id": b.get("id"), "name": b.get("name"), "error": str(e)})
            log(f"    FAILED: {e}")

    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"boards": summary, "failures": failures}, fh, ensure_ascii=False, indent=2)
    log(f"\nDone: {len(summary)} exported, {len(failures)} failed. See {os.path.join(args.out, 'index.json')}")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
