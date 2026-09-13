# -*- coding: utf-8 -*-
"""套色木刻工作台 —— Flask + SQLite 后端。

功能:
  * 项目 / 色版 / 区域 的增删改查
  * 试印校准:由三对(设计坐标, 实测坐标)最小二乘解算 平移+旋转+统一缩放
  * 版序枚举:锁定部分版的位置,枚举剩余排列,按 混色误差 / 清墨换色次数 / 干燥等待次数 排序
  * 方案与试印记录持久化到 SQLite
  * 减版木刻流程:同一块实体木版的连续刻印阶段,阶段差分(保留凸面/刻除区)
    在后端栅格化计算并写入 SQLite
"""
import base64
import binascii
import json
import math
import os
import sqlite3
import itertools
import zlib

from flask import Flask, g, jsonify, render_template, request, abort

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "woodcut.db")

app = Flask(__name__)

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  paper_w REAL NOT NULL DEFAULT 210,
  paper_h REAL NOT NULL DEFAULT 297,
  orientation TEXT NOT NULL DEFAULT 'portrait',
  sketch TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ink_color TEXT NOT NULL DEFAULT '#1a1a1a',
  opacity REAL NOT NULL DEFAULT 1.0,
  target_color TEXT NOT NULL DEFAULT '#1a1a1a',
  min_line_width REAL NOT NULL DEFAULT 1.5,
  reg_marks TEXT NOT NULL DEFAULT '[]',
  drying_rule TEXT NOT NULL DEFAULT 'none',
  seq INTEGER NOT NULL DEFAULT 0,
  offset_x REAL NOT NULL DEFAULT 0,
  offset_y REAL NOT NULL DEFAULT 0,
  rotation REAL NOT NULL DEFAULT 0,
  locked_correction INTEGER NOT NULL DEFAULT 0,
  locked_position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS regions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  points TEXT NOT NULL,
  target_color TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  design TEXT NOT NULL,
  measured TEXT NOT NULL,
  correction TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  block_order TEXT NOT NULL,
  metrics TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS reduction_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_block_id INTEGER REFERENCES blocks(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  paper_w REAL NOT NULL,
  paper_h REAL NOT NULL,
  grid_w INTEGER NOT NULL,
  grid_h INTEGER NOT NULL,
  scale REAL NOT NULL,
  reg_marks TEXT NOT NULL DEFAULT '[]',
  snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS jig_boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  metrics TEXT NOT NULL DEFAULT '{}',
  adopted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS reduction_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER NOT NULL REFERENCES reduction_flows(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  carve_polys TEXT NOT NULL DEFAULT '[]',
  zone_ids TEXT NOT NULL DEFAULT '[]',
  ink_color TEXT NOT NULL DEFAULT '#1a1a1a',
  opacity REAL NOT NULL DEFAULT 1.0,
  plan_prints INTEGER NOT NULL DEFAULT 0,
  printed_count INTEGER NOT NULL DEFAULT 0,
  waste_count INTEGER NOT NULL DEFAULT 0,
  invalid INTEGER NOT NULL DEFAULT 0,
  base_mask BLOB,
  relief_mask BLOB,
  carve_mask BLOB,
  ink_mask BLOB,
  narrow_mask BLOB,
  outside_area REAL NOT NULL DEFAULT 0,
  issues TEXT NOT NULL DEFAULT '[]',
  log TEXT NOT NULL DEFAULT '[]',
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
"""

MIN_BLOCKS, MAX_BLOCKS = 2, 8


# ---------------------------------------------------------------- 数据库工具

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    db.commit()
    db.close()


@app.errorhandler(400)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(409)
def json_error(err):
    return jsonify({"description": str(err.description)}), err.code


def now_ts():
    import datetime
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def row_to_block(r):
    d = dict(r)
    d["reg_marks"] = json.loads(d["reg_marks"])
    d["locked_correction"] = bool(d["locked_correction"])
    d["locked_position"] = bool(d["locked_position"])
    return d


def row_to_region(r):
    d = dict(r)
    d["points"] = json.loads(d["points"])
    return d


def load_project_full(pid):
    db = get_db()
    proj = db.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if not proj:
        abort(404)
    p = dict(proj)
    blocks = [row_to_block(r) for r in db.execute(
        "SELECT * FROM blocks WHERE project_id=? ORDER BY seq, id", (pid,))]
    for b in blocks:
        b["regions"] = [row_to_region(r) for r in db.execute(
            "SELECT * FROM regions WHERE block_id=? ORDER BY id", (b["id"],))]
    p["blocks"] = blocks
    return p


# ---------------------------------------------------------------- 几何计算

def hex_to_rgb(h):
    h = (h or "#000000").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return (0, 0, 0)


def transform_point(x, y, cx, cy, dx, dy, rot_deg):
    """绕 (cx,cy) 旋转 rot_deg 后平移 (dx,dy)。"""
    a = math.radians(rot_deg)
    c, s = math.cos(a), math.sin(a)
    rx, ry = x - cx, y - cy
    return (cx + c * rx - s * ry + dx, cy + s * rx + c * ry + dy)


def point_in_poly(x, y, pts):
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def fit_similarity(design, measured):
    """由 >=3 对点最小二乘拟合 平移+旋转+统一缩放:  q ≈ s·R·p + t"""
    n = len(design)
    if n < 3:
        abort(400, "至少需要 3 对标记点")
    px = sum(p[0] for p in design) / n
    py = sum(p[1] for p in design) / n
    qx = sum(p[0] for p in measured) / n
    qy = sum(p[1] for p in measured) / n
    a = b = su2 = 0.0
    for (pxi, pyi), (qxi, qyi) in zip(design, measured):
        ux, uy = pxi - px, pyi - py
        vx, vy = qxi - qx, qyi - qy
        a += ux * vx + uy * vy
        b += ux * vy - uy * vx
        su2 += ux * ux + uy * uy
    if su2 < 1e-9:
        abort(400, "设计坐标三点重合,无法解算")
    theta = math.atan2(b, a)
    s = math.hypot(a, b) / su2
    c, sn = s * math.cos(theta), s * math.sin(theta)
    tx = qx - (c * px - sn * py)
    ty = qy - (sn * px + c * py)
    # 残差(均方根,毫米)
    sse = 0.0
    for (pxi, pyi), (qxi, qyi) in zip(design, measured):
        ex = c * pxi - sn * pyi + tx - qxi
        ey = sn * pxi + c * pyi + ty - qyi
        sse += ex * ex + ey * ey
    rms = math.sqrt(sse / n)
    return {"tx": tx, "ty": ty, "rot_deg": math.degrees(theta),
            "scale": s, "rms_error": rms}


# ---------------------------------------------------------------- 减版木刻流程 —— 几何内核

FLOW_SCALE = 3.0          # 栅格化分辨率 px/mm(与前端检测 ANALYSIS_SCALE 一致)
MASK_GAP = 1              # 灰度 PNG 中 1=凸面/着墨, 0=刻除
STATUS_ORDER = {"draft": 0, "pending": 1, "printed": 2, "locked": 3}


def rasterize_polys(polys, W, H, scale=FLOW_SCALE):
    """多边形列表(mm 坐标)并集 → 位掩码(整数,位 i = 像素 y*W+x)。
    扫描线算法,与前端 Canvas nonzero 填充、point_in_poly 的覆盖判定一致。"""
    bits = 0
    for pts in polys:
        n = len(pts)
        if n < 3:
            continue
        ys = [p[1] * scale for p in pts]
        ymin = max(0, int(math.floor(min(ys) - 0.5)) + 1)
        ymax = min(H - 1, int(math.floor(max(ys) + 0.5)))
        for py in range(ymin, ymax + 1):
            y = (py + 0.5) / scale
            xs = []
            j = n - 1
            for i in range(n):
                xi, yi = pts[i]
                xj, yj = pts[j]
                if (yi > y) != (yj > y):
                    xs.append((xj - xi) * (y - yi) / (yj - yi) + xi)
                j = i
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                xa, xb = xs[k] * scale, xs[k + 1] * scale
                x0 = max(0, int(math.floor(xa - 0.5)) + 1)
                x1 = min(W - 1, int(math.floor(xb + 0.5)))
                if x1 < x0:
                    continue
                row = (1 << (x1 + 1)) - 1
                row ^= (1 << x0) - 1
                bits |= row << (py * W)
    return bits


def _erode_rows(bits, W, H, r):
    """逐行水平腐蚀:每行保留左右各 r 像素内全为 1 的位置。"""
    out = 0
    rowmask = (1 << W) - 1
    for y in range(H):
        row = (bits >> (y * W)) & rowmask
        e = row
        for k in range(1, r + 1):
            e &= (row >> k) & (row << k) & rowmask
        out |= e << (y * W)
    return out


def _dilate_rows(bits, W, H, r):
    out = 0
    rowmask = (1 << W) - 1
    for y in range(H):
        row = (bits >> (y * W)) & rowmask
        d = row
        for k in range(1, r + 1):
            d |= (row >> k) | ((row << k) & rowmask)
        out |= d << (y * W)
    return out


def _erode_cols(bits, W, H, r):
    """竖直腐蚀:上下 r 行同列均为 1(按 W 位整掩码移位,行间天然不串位)。"""
    e = bits
    for k in range(1, r + 1):
        e &= (bits >> (k * W)) & (bits << (k * W))
    return e


def _dilate_cols(bits, W, H, r):
    d = bits
    for k in range(1, r + 1):
        d |= (bits >> (k * W)) | (bits << (k * W))
    return d


def morph_open_bits(bits, W, H, r):
    """位域方形 (2r+1)² 8 邻域开运算:水平+竖直一维腐蚀后再膨胀。
    凸面或连接桥任一方向窄于 (2r+1) 像素都会在结果中消失。"""
    if r <= 0:
        return bits
    e = _erode_rows(bits, W, H, r)
    e = _erode_cols(e, W, H, r)
    d = _dilate_rows(e, W, H, r)
    d = _dilate_cols(d, W, H, r)
    return d



_UNPACK_TABLE = [bytes((b >> i) & 1 for i in range(8)) for b in range(256)]


def mask_to_bytes(bits, n):
    """位掩码 → 每像素 1 字节(0/1),供形态学使用(每字节查表展开为 8 字节)。"""
    packed = bits.to_bytes((n + 7) // 8, "little")
    out = b"".join(_UNPACK_TABLE[b] for b in packed)
    return bytearray(out[:n])


def pack_bits(by):
    """每像素 1 字节(0/1) → 位掩码 int(小端位序)。"""
    out = bytearray((len(by) + 7) // 8)
    for k in range(8):
        for i, v in enumerate(by[k::8]):
            if v:
                out[i] |= 1 << k
    return int.from_bytes(bytes(out), "little")


_REV_BYTE = bytes(int(f"{b:08b}"[::-1], 2) for b in range(256))


def encode_mask_png(bits, W, H):
    """位掩码 → 1 位色深灰度 PNG(黑=0/刻除,白=1/凸面),每扫描行加 filter 0。
    PNG 行内按 MSB-first 打包且每行按字节对齐,内部位掩码为 LSB-first,
    故逐行独立打包(行宽非 8 倍数时行尾 padding 必须清零),再逐字节位序反转。"""
    row_bytes = (W + 7) // 8
    rowmask = (1 << W) - 1
    raw = bytearray()
    for y in range(H):
        raw.append(0)
        row = ((bits >> (y * W)) & rowmask).to_bytes(row_bytes, "little")
        raw += row.translate(_REV_BYTE)
    comp = zlib.compress(bytes(raw), 6)

    def chunk(tag, data):
        c = binascii.crc32(tag + data) & 0xffffffff
        return (len(data).to_bytes(4, "big") + tag + data + c.to_bytes(4, "big"))

    ihdr = W.to_bytes(4, "big") + H.to_bytes(4, "big") + bytes((1, 0, 0, 0, 0))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", comp) + chunk(b"IEND", b""))


def decode_mask_png(blob):
    """解码本系统生成的 1 位(兼容 8 位)灰度 PNG,返回 (位掩码, W, H)。"""
    pos = 8
    idat = b""
    W = H = depth = 0
    while pos < len(blob):
        ln = int.from_bytes(blob[pos:pos + 4], "big")
        tag = blob[pos + 4:pos + 8]
        data = blob[pos + 8:pos + 8 + ln]
        if tag == b"IHDR":
            W = int.from_bytes(data[0:4], "big")
            H = int.from_bytes(data[4:8], "big")
            depth = data[8]
        elif tag == b"IDAT":
            idat += data
        pos += 12 + ln
    raw = zlib.decompress(idat)
    if depth == 1:
        row_bytes = (W + 7) // 8
        bits = 0
        for y in range(H):
            row = raw[y * (row_bytes + 1) + 1:y * (row_bytes + 1) + 1 + row_bytes]
            bits |= int.from_bytes(row.translate(_REV_BYTE), "little") << (y * W)
        return bits, W, H
    # 兼容旧版 8 位灰度
    n = W * H
    out = bytearray(n)
    for y in range(H):
        out[y * W:(y + 1) * W] = raw[y * (W + 1) + 1:y * (W + 1) + 1 + W]
    return pack_bits(out), W, H


def mask_b64(b):
    if b is None:
        return None
    return "data:image/png;base64," + base64.b64encode(b).decode("ascii")


def add_stage_log(row_stage, text):
    log = json.loads(row_stage["log"] or "[]")
    log.append({"at": now_ts(), "text": text})
    return log


# ---------------------------------------------------------------- 页面

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------- 项目 API

@app.get("/api/projects")
def list_projects():
    rows = get_db().execute(
        "SELECT id,name,paper_w,paper_h,orientation,created_at FROM projects ORDER BY id DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/projects")
def create_project():
    data = request.get_json(force=True)
    name = (data.get("name") or "未命名画稿").strip()
    db = get_db()
    cur = db.execute(
        "INSERT INTO projects(name,paper_w,paper_h,orientation) VALUES(?,?,?,?)",
        (name, float(data.get("paper_w", 210)), float(data.get("paper_h", 297)),
         data.get("orientation", "portrait")))
    db.commit()
    return jsonify(load_project_full(cur.lastrowid)), 201


@app.get("/api/projects/<int:pid>")
def get_project(pid):
    return jsonify(load_project_full(pid))


@app.put("/api/projects/<int:pid>")
def update_project(pid):
    data = request.get_json(force=True)
    db = get_db()
    fields, vals = [], []
    for k in ("name", "paper_w", "paper_h", "orientation", "sketch"):
        if k in data:
            fields.append(f"{k}=?")
            vals.append(data[k])
    if fields:
        vals.append(pid)
        db.execute(f"UPDATE projects SET {', '.join(fields)} WHERE id=?", vals)
        db.commit()
    return jsonify(load_project_full(pid))


@app.delete("/api/projects/<int:pid>")
def delete_project(pid):
    db = get_db()
    db.execute("DELETE FROM projects WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- 色版 API

@app.post("/api/projects/<int:pid>/blocks")
def add_block(pid):
    db = get_db()
    cnt = db.execute("SELECT COUNT(*) c FROM blocks WHERE project_id=?", (pid,)).fetchone()["c"]
    if cnt >= MAX_BLOCKS:
        abort(400, f"最多 {MAX_BLOCKS} 块色版")
    data = request.get_json(force=True) or {}
    seq = cnt
    cur = db.execute(
        """INSERT INTO blocks(project_id,name,ink_color,opacity,target_color,
                              min_line_width,drying_rule,seq)
           VALUES(?,?,?,?,?,?,?,?)""",
        (pid, data.get("name") or f"第{cnt + 1}版",
         data.get("ink_color", "#1a1a1a"), float(data.get("opacity", 1.0)),
         data.get("target_color", data.get("ink_color", "#1a1a1a")),
         float(data.get("min_line_width", 1.5)),
         data.get("drying_rule", "none"), seq))
    db.commit()
    return jsonify(load_project_full(pid)), 201


@app.put("/api/blocks/<int:bid>")
def update_block(bid):
    data = request.get_json(force=True)
    db = get_db()
    allowed = ("name", "ink_color", "opacity", "target_color", "min_line_width",
               "reg_marks", "drying_rule", "seq", "offset_x", "offset_y",
               "rotation", "locked_correction", "locked_position")
    fields, vals = [], []
    for k in allowed:
        if k in data:
            v = data[k]
            if k == "reg_marks":
                v = json.dumps(v)
            if k in ("locked_correction", "locked_position"):
                v = 1 if v else 0
            fields.append(f"{k}=?")
            vals.append(v)
    if fields:
        vals.append(bid)
        db.execute(f"UPDATE blocks SET {', '.join(fields)} WHERE id=?", vals)
        db.commit()
    row = db.execute("SELECT project_id FROM blocks WHERE id=?", (bid,)).fetchone()
    if not row:
        abort(404)
    return jsonify(load_project_full(row["project_id"]))


@app.delete("/api/blocks/<int:bid>")
def delete_block(bid):
    db = get_db()
    row = db.execute("SELECT project_id FROM blocks WHERE id=?", (bid,)).fetchone()
    if not row:
        abort(404)
    if db.execute("SELECT COUNT(*) c FROM blocks WHERE project_id=?",
                  (row["project_id"],)).fetchone()["c"] <= MIN_BLOCKS:
        abort(400, f"至少保留 {MIN_BLOCKS} 块色版")
    db.execute("DELETE FROM blocks WHERE id=?", (bid,))
    db.commit()
    return jsonify(load_project_full(row["project_id"]))


# ---------------------------------------------------------------- 区域 API

@app.post("/api/blocks/<int:bid>/regions")
def add_region(bid):
    data = request.get_json(force=True)
    pts = data.get("points") or []
    if len(pts) < 3:
        abort(400, "封闭区域至少需要 3 个顶点")
    db = get_db()
    row = db.execute("SELECT project_id FROM blocks WHERE id=?", (bid,)).fetchone()
    if not row:
        abort(404)
    db.execute("INSERT INTO regions(block_id,points,target_color) VALUES(?,?,?)",
               (bid, json.dumps(pts), data.get("target_color", "")))
    db.commit()
    return jsonify(load_project_full(row["project_id"])), 201


@app.put("/api/regions/<int:rid>")
def update_region(rid):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute(
        "SELECT b.project_id pid FROM regions r JOIN blocks b ON b.id=r.block_id WHERE r.id=?",
        (rid,)).fetchone()
    if not row:
        abort(404)
    if "target_color" in data:
        db.execute("UPDATE regions SET target_color=? WHERE id=?",
                   (data["target_color"], rid))
    if "points" in data:
        db.execute("UPDATE regions SET points=? WHERE id=?",
                   (json.dumps(data["points"]), rid))
    db.commit()
    return jsonify(load_project_full(row["pid"]))


@app.delete("/api/regions/<int:rid>")
def delete_region(rid):
    db = get_db()
    row = db.execute(
        "SELECT b.project_id pid FROM regions r JOIN blocks b ON b.id=r.block_id WHERE r.id=?",
        (rid,)).fetchone()
    if not row:
        abort(404)
    db.execute("DELETE FROM regions WHERE id=?", (rid,))
    db.commit()
    return jsonify(load_project_full(row["pid"]))


# ---------------------------------------------------------------- 试印校准 API

@app.post("/api/blocks/<int:bid>/trials")
def add_trial(bid):
    data = request.get_json(force=True)
    design = data.get("design") or []
    measured = data.get("measured") or []
    if len(design) != 3 or len(measured) != 3:
        abort(400, "需要恰好 3 个设计坐标与 3 个实测坐标")
    design = [[float(p[0]), float(p[1])] for p in design]
    measured = [[float(p[0]), float(p[1])] for p in measured]
    corr = fit_similarity(design, measured)
    db = get_db()
    row = db.execute("SELECT project_id FROM blocks WHERE id=?", (bid,)).fetchone()
    if not row:
        abort(404)
    cur = db.execute(
        "INSERT INTO trials(block_id,design,measured,correction) VALUES(?,?,?,?)",
        (bid, json.dumps(design), json.dumps(measured), json.dumps(corr)))
    db.commit()
    t = db.execute("SELECT * FROM trials WHERE id=?", (cur.lastrowid,)).fetchone()
    out = dict(t)
    out["design"] = json.loads(out["design"])
    out["measured"] = json.loads(out["measured"])
    out["correction"] = json.loads(out["correction"])
    return jsonify(out), 201


@app.get("/api/projects/<int:pid>/trials")
def list_trials(pid):
    rows = get_db().execute(
        """SELECT t.*, b.name block_name FROM trials t
           JOIN blocks b ON b.id=t.block_id
           WHERE b.project_id=? ORDER BY t.id DESC""", (pid,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["design"] = json.loads(d["design"])
        d["measured"] = json.loads(d["measured"])
        d["correction"] = json.loads(d["correction"])
        out.append(d)
    return jsonify(out)


# ---------------------------------------------------------------- 版序枚举 API

def rasterize_pair_errors(blocks, paper_w, paper_h):
    """栅格化各版区域(含当前偏移/旋转),返回 pair_err[top][bottom]:
    在两版重叠的像素上,top 版油墨叠到 bottom 版之上的混合色与
    top 版*该区域目标色*(区域级,缺省回落到版级)的距离 × 面积。"""
    n = len(blocks)
    W = 140
    H = max(1, round(W * paper_h / paper_w))
    cw, ch = paper_w / W, paper_h / H
    cell_area = cw * ch
    cx, cy = paper_w / 2, paper_h / 2
    inks = [hex_to_rgb(b["ink_color"]) for b in blocks]
    alphas = [b["opacity"] for b in blocks]
    # 每版:变换后的 [(多边形, 该区域目标色rgb)]
    polys = []
    for b in blocks:
        lst = []
        for r in b["regions"]:
            tgt = hex_to_rgb(r["target_color"] or b["target_color"])
            pts = [transform_point(p[0], p[1], cx, cy,
                                   b["offset_x"], b["offset_y"], b["rotation"])
                   for p in r["points"]]
            lst.append((pts, tgt))
        polys.append(lst)
    pair_err = [[0.0] * n for _ in range(n)]
    for gy in range(H):
        y = (gy + 0.5) * ch
        for gx in range(W):
            x = (gx + 0.5) * cw
            covering = []  # [(版序号, 该区域目标色rgb)]
            for i in range(n):
                for pts, tgt in polys[i]:
                    if point_in_poly(x, y, pts):
                        covering.append((i, tgt))
                        break
            for t in range(len(covering)):
                j, tgt_j = covering[t]
                aj = alphas[j]
                ink_j = inks[j]
                for u in range(len(covering)):
                    if u == t:
                        continue
                    i = covering[u][0]
                    ink_i = inks[i]
                    mixed = tuple(aj * ink_j[k] + (1 - aj) * ink_i[k] for k in range(3))
                    pair_err[j][i] += math.dist(mixed, tgt_j) * cell_area
    return pair_err


def order_metrics(order, pair_err, blocks):
    """order: block 下标序列。返回 (混色误差, 换色次数, 干燥等待次数)。"""
    color_err = 0.0
    for later in range(1, len(order)):
        for earlier in range(later):
            color_err += pair_err[order[later]][order[earlier]]
    ink_changes = sum(
        1 for k in range(1, len(order))
        if blocks[order[k]]["ink_color"].lower() != blocks[order[k - 1]]["ink_color"].lower())
    dry_waits = sum(
        1 for k in range(1, len(order))
        if blocks[order[k - 1]]["drying_rule"] in ("before_overprint", "slow"))
    return round(color_err, 1), ink_changes, dry_waits


@app.post("/api/projects/<int:pid>/enumerate")
def enumerate_orders(pid):
    proj = load_project_full(pid)
    blocks = proj["blocks"]
    n = len(blocks)
    if n < MIN_BLOCKS:
        abort(400, f"至少需要 {MIN_BLOCKS} 块色版")
    pw, ph = proj["paper_w"], proj["paper_h"]
    if proj["orientation"] == "landscape":
        pw, ph = ph, pw
    pair_err = rasterize_pair_errors(blocks, pw, ph)

    # blocks 已按 seq 排序;锁定的版固定在当前的印次位置,其余版排列其余位置
    locked = {i: i for i, b in enumerate(blocks) if b["locked_position"]}
    free_pos = [p for p in range(n) if p not in locked]
    free_blocks = [i for i in range(n) if i not in locked.values()]

    results = []
    for perm in itertools.permutations(free_blocks):
        order = [None] * n
        for pos, bi in locked.items():
            if 0 <= pos < n:
                order[pos] = bi
        for pos, bi in zip(free_pos, perm):
            order[pos] = bi
        if any(v is None for v in order):
            continue
        ce, ic, dw = order_metrics(order, pair_err, blocks)
        results.append({
            "order": [blocks[i]["id"] for i in order],
            "names": [blocks[i]["name"] for i in order],
            "color_error": ce, "ink_changes": ic, "dry_waits": dw,
        })
    results.sort(key=lambda r: (r["color_error"], r["ink_changes"], r["dry_waits"]))
    return jsonify({"total": len(results), "candidates": results[:50]})


# ---------------------------------------------------------------- 方案 API

@app.post("/api/projects/<int:pid>/plans")
def save_plan(pid):
    data = request.get_json(force=True)
    order = data.get("order") or []
    metrics = data.get("metrics") or {}
    db = get_db()
    cur = db.execute("INSERT INTO plans(project_id,block_order,metrics) VALUES(?,?,?)",
                     (pid, json.dumps(order), json.dumps(metrics)))
    db.commit()
    row = db.execute("SELECT * FROM plans WHERE id=?", (cur.lastrowid,)).fetchone()
    d = dict(row)
    d["block_order"] = json.loads(d["block_order"])
    d["metrics"] = json.loads(d["metrics"])
    return jsonify(d), 201


@app.get("/api/projects/<int:pid>/plans")
def list_plans(pid):
    rows = get_db().execute(
        "SELECT * FROM plans WHERE project_id=? ORDER BY id DESC", (pid,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["block_order"] = json.loads(d["block_order"])
        d["metrics"] = json.loads(d["metrics"])
        out.append(d)
    return jsonify(out)


@app.delete("/api/plans/<int:plan_id>")
def delete_plan(plan_id):
    db = get_db()
    db.execute("DELETE FROM plans WHERE id=?", (plan_id,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- 减版木刻流程 API

def get_flow_or_404(fid):
    r = get_db().execute("SELECT * FROM reduction_flows WHERE id=?", (fid,)).fetchone()
    if not r:
        abort(404, "流程不存在")
    return r


def flow_stage_rows(fid):
    return get_db().execute(
        "SELECT * FROM reduction_stages WHERE flow_id=? ORDER BY seq, id", (fid,)).fetchall()


def stage_to_dict(r, masks=True):
    d = {
        "id": r["id"], "flow_id": r["flow_id"], "seq": r["seq"], "name": r["name"],
        "status": r["status"], "carve_polys": json.loads(r["carve_polys"] or "[]"),
        "zone_ids": json.loads(r["zone_ids"] or "[]"),
        "ink_color": r["ink_color"], "opacity": r["opacity"],
        "plan_prints": r["plan_prints"], "printed_count": r["printed_count"],
        "waste_count": r["waste_count"], "invalid": bool(r["invalid"]),
        "outside_area": r["outside_area"], "issues": json.loads(r["issues"] or "[]"),
        "log": json.loads(r["log"] or "[]"),
        "confirmed_at": r["confirmed_at"], "created_at": r["created_at"],
    }
    if masks:
        d.update({
            "base_png": mask_b64(r["base_mask"]),
            "relief_png": mask_b64(r["relief_mask"]),
            "carve_png": mask_b64(r["carve_mask"]),
            "ink_png": mask_b64(r["ink_mask"]),
            "narrow_png": mask_b64(r["narrow_mask"]),
        })
    return d


def flow_to_dict(r, stages=None, masks=True):
    d = {
        "id": r["id"], "project_id": r["project_id"],
        "source_block_id": r["source_block_id"], "name": r["name"],
        "paper_w": r["paper_w"], "paper_h": r["paper_h"],
        "grid_w": r["grid_w"], "grid_h": r["grid_h"], "scale": r["scale"],
        "reg_marks": json.loads(r["reg_marks"] or "[]"),
        "snapshot": json.loads(r["snapshot"] or "{}"),
        "created_at": r["created_at"],
    }
    d["stages"] = [stage_to_dict(s, masks) for s in (stages or flow_stage_rows(r["id"]))]
    return d


def recompute_flow(fid):
    """重算**草稿**阶段的差分掩码并写库,返回 (flow_row, stage_rows)。

    已确认阶段(pending/printed/locked)的几何在确认时刻冻结:
    直接读取库存 base/relief 掩码作为后续阶段基准,绝不重新栅格化,
    因此修改较早草稿不会改变已确认阶段的历史回放与导出。

    减版顺序:在剩余凸面(base)上着墨印刷 → 刻掉本轮刻除区 → 得到下一阶段的凸面。
    """
    db = get_db()
    flow = get_flow_or_404(fid)
    W, H, scale = flow["grid_w"], flow["grid_h"], flow["scale"]
    snap = json.loads(flow["snapshot"] or "{}")
    n = W * H
    cell_area = (1.0 / scale) ** 2
    min_w = float(snap.get("min_line_width", 1.5))
    r = max(1, round(min_w / 2 * scale))

    zones = snap.get("zones", [])
    zone_cache = {z["id"]: rasterize_polys([z["pts"]], W, H, scale) for z in zones}
    base_bits = 0
    for z in zones:
        base_bits |= rasterize_polys([z["pts"]], W, H, scale)
    init_bits = base_bits

    rows = flow_stage_rows(fid)
    prev = None
    for st in rows:
        if st["status"] != "draft":
            # 冻结阶段:掩码以库中确认为准,只解码、不重算、不覆写
            frozen_base, _, _ = decode_mask_png(st["base_mask"])
            frozen_relief, _, _ = decode_mask_png(st["relief_mask"])
            base_bits = frozen_relief
            prev = st
            continue

        zone_ids = json.loads(st["zone_ids"] or "[]")
        ink_bits = 0
        ink_want = 0
        for zid in zone_ids:
            zb = zone_cache.get(zid)
            if zb is not None:
                ink_want |= zb
        ink_bits = ink_want & base_bits
        carve_bits = rasterize_polys(json.loads(st["carve_polys"] or "[]"), W, H, scale) & base_bits
        relief_bits = base_bits & ~carve_bits
        # 检查刻版之后的剩余凸面/连接桥:细于最小线宽处开运算后消失
        opened_bits = morph_open_bits(relief_bits, W, H, r)
        narrow_bits = relief_bits & ~opened_bits

        issues = []
        # 着墨意图覆盖了当前凸面之外(此前已刻掉)的区域
        overflow_bits = ink_want & ~base_bits
        if overflow_bits:
            area = overflow_bits.bit_count() * cell_area
            issues.append({
                "type": "overflow", "blocking": True,
                "text": f"着墨区约 {area:.1f} mm² 超出剩余凸面(此前已刻掉,无法着墨)",
            })
        narrow_area = narrow_bits.bit_count() * cell_area
        if narrow_area:
            issues.append({
                "type": "narrow", "blocking": True,
                "text": f"凸面或连接桥约 {narrow_area:.1f} mm² 窄于该版最小线宽 {min_w:g} mm,易断",
            })
        # 刻除多边形伸出原始木面的面积(提示用;刻在当轮凸面外但仍在木面内=刻已刻区,自动忽略)
        raw_out = rasterize_polys(json.loads(st["carve_polys"] or "[]"), W, H, scale) & ~init_bits
        outside_area = raw_out.bit_count() * cell_area
        if outside_area > 0.5:
            issues.append({
                "type": "outside", "blocking": False,
                "text": f"刻除区约 {outside_area:.1f} mm² 落在木面之外,已忽略",
            })
        if prev is not None and prev["status"] in ("draft", "pending"):
            issues.append({
                "type": "prev_unprinted", "blocking": True,
                "text": f"前一印次「{prev['name']}」尚未印完(状态:"
                        f"{'草稿' if prev['status'] == 'draft' else '待印'}),不应继续刻版",
            })

        db.execute(
            """UPDATE reduction_stages SET base_mask=?,relief_mask=?,carve_mask=?,
               ink_mask=?,narrow_mask=?,outside_area=?,issues=? WHERE id=?""",
            (encode_mask_png(base_bits, W, H),
             encode_mask_png(relief_bits, W, H),
             encode_mask_png(carve_bits, W, H),
             encode_mask_png(ink_bits, W, H),
             encode_mask_png(narrow_bits, W, H),
             outside_area, json.dumps(issues, ensure_ascii=False), st["id"]))
        base_bits = relief_bits
        prev = st
    db.commit()
    return flow, flow_stage_rows(fid)


@app.get("/api/projects/<int:pid>/flows")
def list_flows(pid):
    rows = get_db().execute(
        "SELECT * FROM reduction_flows WHERE project_id=? ORDER BY id", (pid,)).fetchall()
    return jsonify([flow_to_dict(r, masks=False) for r in rows])


@app.get("/api/flows/<int:fid>")
def get_flow(fid):
    flow, rows = recompute_flow(fid)
    return jsonify(flow_to_dict(flow, rows))


@app.post("/api/projects/<int:pid>/flows")
def create_flow(pid):
    proj = load_project_full(pid)
    data = request.get_json(force=True) or {}
    bid = data.get("source_block_id")
    block = next((b for b in proj["blocks"] if b["id"] == bid), None)
    if not block:
        abort(400, "请选择一块来源色版(色版区域决定初始凸面)")
    if not block["regions"]:
        abort(400, "来源色版尚无封闭区域,请先在「区域勾勒」中勾勒色版区域")
    pw, ph = proj["paper_w"], proj["paper_h"]
    if proj["orientation"] == "landscape":
        pw, ph = ph, pw
    valid_ids = {r["id"] for r in block["regions"]}
    raw_sel = data.get("zone_ids")
    if raw_sel is None:
        chosen = valid_ids                       # 未显式给出:默认全部
    else:
        chosen = set(raw_sel)
        bad = chosen - valid_ids
        if bad:
            abort(400, f"区域 {sorted(bad)} 不属于来源色版「{block['name']}」")
    zones = [{"id": r["id"], "pts": r["points"],
              "target_color": r["target_color"] or block["target_color"]}
             for r in block["regions"] if r["id"] in chosen]
    if not zones:
        abort(400, "至少选取一个色版区域建立流程")
    W = max(1, round(pw * FLOW_SCALE))
    H = max(1, round(ph * FLOW_SCALE))
    snapshot = {
        "source_block_name": block["name"], "ink_color": block["ink_color"],
        "opacity": block["opacity"], "target_color": block["target_color"],
        "min_line_width": block["min_line_width"],
        "base_region_ids": [z["id"] for z in zones], "zones": zones,
        "paper_w": pw, "paper_h": ph,
        "project_name": proj["name"], "frozen_at": now_ts(),
    }
    db = get_db()
    cur = db.execute(
        """INSERT INTO reduction_flows(project_id,source_block_id,name,paper_w,paper_h,
                                      grid_w,grid_h,scale,reg_marks,snapshot)
           VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (pid, bid, (data.get("name") or f"{block['name']}·减版流程").strip(),
         pw, ph, W, H, FLOW_SCALE, json.dumps(block["reg_marks"]),
         json.dumps(snapshot, ensure_ascii=False)))
    db.commit()
    flow, rows = recompute_flow(cur.lastrowid)
    return jsonify(flow_to_dict(flow, rows)), 201


@app.put("/api/flows/<int:fid>")
def update_flow(fid):
    data = request.get_json(force=True) or {}
    db = get_db()
    if "name" in data:
        db.execute("UPDATE reduction_flows SET name=? WHERE id=?",
                   ((data["name"] or "未命名流程").strip(), fid))
        db.commit()
    flow, rows = recompute_flow(fid)
    return jsonify(flow_to_dict(flow, rows))


@app.delete("/api/flows/<int:fid>")
def delete_flow(fid):
    get_flow_or_404(fid)
    db = get_db()
    db.execute("DELETE FROM reduction_flows WHERE id=?", (fid,))
    db.commit()
    return jsonify({"ok": True})


@app.post("/api/flows/<int:fid>/stages")
def add_stage(fid):
    flow = get_flow_or_404(fid)
    data = request.get_json(force=True) or {}
    db = get_db()
    nxt = db.execute("SELECT COALESCE(MAX(seq)+1,0) s FROM reduction_stages WHERE flow_id=?",
                     (fid,)).fetchone()["s"]
    snap = json.loads(flow["snapshot"] or "{}")
    if "zone_ids" in data:
        zone_ids = data["zone_ids"]
    elif nxt == 0:
        zone_ids = snap.get("base_region_ids", [])  # 首遍通常满版着墨
    else:
        zone_ids = []                                # 后续遍:从剩余凸面区域中勾选
    cur = db.execute(
        """INSERT INTO reduction_stages(flow_id,seq,name,carve_polys,zone_ids,ink_color,
                                        opacity,plan_prints,log)
           VALUES(?,?,?,?,?,?,?,?,?)""",
        (fid, nxt, (data.get("name") or f"第{nxt + 1}阶段").strip(),
         json.dumps(data.get("carve_polys") or []),
         json.dumps(zone_ids),
         data.get("ink_color") or snap.get("ink_color", "#1a1a1a"),
         float(data.get("opacity", snap.get("opacity", 1.0))),
         int(data.get("plan_prints", 0)),
         json.dumps([{"at": now_ts(), "text": "建立草稿阶段"}], ensure_ascii=False)))
    db.commit()
    flow2, rows = recompute_flow(fid)
    return jsonify(flow_to_dict(flow2, rows)), 201


def _editable_draft_stage(sid):
    db = get_db()
    st = db.execute("SELECT * FROM reduction_stages WHERE id=?", (sid,)).fetchone()
    if not st:
        abort(404, "阶段不存在")
    if st["status"] == "locked":
        abort(409, "该阶段已锁定,不可修改")
    if st["status"] != "draft":
        abort(409, "阶段已确认,刻除区与快照不可修改(如需重刻请新建阶段)")
    later = db.execute(
        "SELECT COUNT(*) c FROM reduction_stages WHERE flow_id=? AND seq>? AND status IN ('printed','locked')",
        (st["flow_id"], st["seq"])).fetchone()["c"]
    if later:
        abort(409, "后续已有已印/锁定阶段,木版上的刻除不可恢复,不能再改本阶段刻除区")
    return st


@app.put("/api/stages/<int:sid>")
def update_stage(sid):
    st = _editable_draft_stage(sid)
    data = request.get_json(force=True) or {}
    db = get_db()
    fields, vals = [], []
    for k in ("name", "ink_color", "opacity", "plan_prints"):
        if k in data:
            fields.append(f"{k}=?")
            vals.append(data[k])
    if "carve_polys" in data:
        fields.append("carve_polys=?")
        vals.append(json.dumps(data["carve_polys"]))
    if "zone_ids" in data:
        fields.append("zone_ids=?")
        vals.append(json.dumps(data["zone_ids"]))
    if fields:
        vals.append(sid)
        db.execute(f"UPDATE reduction_stages SET {', '.join(fields)} WHERE id=?", vals)
        # 仅几何改动(刻除区/着墨区)改变后续凸面容差,其后的全部阶段立即失效;
        # 改名/油墨/计划印数不影响几何
        geom_changed = "carve_polys=?" in fields or "zone_ids=?" in fields
        if geom_changed:
            db.execute(
                "UPDATE reduction_stages SET invalid=1 WHERE flow_id=? AND seq>?",
                (st["flow_id"], st["seq"]))
            log = add_stage_log(st, "草稿几何已修改,后续阶段标记为失效待复核")
        else:
            log = add_stage_log(st, "草稿信息已更新")
        db.execute("UPDATE reduction_stages SET log=? WHERE id=?",
                   (json.dumps(log, ensure_ascii=False), sid))
        db.commit()
    flow, rows = recompute_flow(st["flow_id"])
    return jsonify(flow_to_dict(flow, rows))


@app.post("/api/stages/<int:sid>/confirm")
def confirm_stage(sid):
    db = get_db()
    st = db.execute("SELECT * FROM reduction_stages WHERE id=?", (sid,)).fetchone()
    if not st:
        abort(404, "阶段不存在")
    if st["status"] != "draft":
        abort(409, "仅草稿阶段可以确认")
    flow, rows = recompute_flow(st["flow_id"])
    cur = next((x for x in rows if x["id"] == sid), None)
    issues = json.loads(cur["issues"] or "[]")
    blocking = [i for i in issues if i.get("blocking")]
    force = bool((request.get_json(silent=True) or {}).get("force"))
    if blocking and not force:
        abort(409, "存在阻断性检查:" + "；".join(i["text"] for i in blocking))
    if len(json.loads(cur["carve_polys"] or "[]")) == 0:
        abort(400, "请先在上一阶段副本中勾画本轮刻除区")
    # 冻结来源色版与几何快照(阶段级:复制流程快照并记录确认时刻)
    snap = json.loads(flow["snapshot"] or "{}")
    stage_snap = dict(snap)
    stage_snap["confirmed_at"] = now_ts()
    stage_snap["grid"] = [flow["grid_w"], flow["grid_h"], flow["scale"]]
    log = json.loads(cur["log"] or "[]")
    log.append({"at": now_ts(),
                "text": "确认阶段:冻结来源色版与几何快照,输出镜像刻除图/保留面图/操作记录"
                        + ("(强制确认:存在未解决检查项)" if blocking else "")})
    db.execute(
        "UPDATE reduction_stages SET status='pending',invalid=0,confirmed_at=?,log=? WHERE id=?",
        (now_ts(), json.dumps(log, ensure_ascii=False), sid))
    db.commit()
    flow2, rows2 = recompute_flow(st["flow_id"])
    return jsonify(flow_to_dict(flow2, rows2))


@app.post("/api/stages/<int:sid>/withdraw")
def withdraw_stage(sid):
    db = get_db()
    st = db.execute("SELECT * FROM reduction_stages WHERE id=?", (sid,)).fetchone()
    if not st:
        abort(404, "阶段不存在")
    if st["status"] != "pending":
        abort(409, "仅待印阶段可撤回到草稿")
    log = add_stage_log(st, "待印阶段撤回为草稿,按最新上游几何重新参与差分计算")
    db.execute("UPDATE reduction_stages SET status='draft',invalid=0,log=? WHERE id=?",
               (json.dumps(log, ensure_ascii=False), sid))
    db.commit()
    flow, rows = recompute_flow(st["flow_id"])
    return jsonify(flow_to_dict(flow, rows))


@app.post("/api/stages/<int:sid>/print")
def print_stage(sid):
    data = request.get_json(force=True) or {}
    db = get_db()
    st = db.execute("SELECT * FROM reduction_stages WHERE id=?", (sid,)).fetchone()
    if not st:
        abort(404, "阶段不存在")
    if st["status"] != "pending":
        abort(409, "仅待印阶段可以记录印刷完成")
    if st["invalid"]:
        abort(409, "该待印阶段已因上游草稿改动而失效:请先「撤回为草稿」复核并重新确认后,才能登记已印")
    printed = int(data.get("printed_count", st["printed_count"]))
    waste = int(data.get("waste_count", st["waste_count"]))
    if printed < 0 or waste < 0:
        abort(400, "印数与废张不能为负")
    log = add_stage_log(st, f"印刷完成:合格 {printed} 张,废张 {waste} 张")
    db.execute(
        "UPDATE reduction_stages SET status='printed',printed_count=?,waste_count=?,log=? WHERE id=?",
        (printed, waste, json.dumps(log, ensure_ascii=False), sid))
    db.commit()
    flow, rows = recompute_flow(st["flow_id"])
    return jsonify(flow_to_dict(flow, rows))


@app.post("/api/stages/<int:sid>/lock")
def lock_stage(sid):
    db = get_db()
    st = db.execute("SELECT * FROM reduction_stages WHERE id=?", (sid,)).fetchone()
    if not st:
        abort(404, "阶段不存在")
    if st["status"] != "printed":
        abort(409, "仅已印阶段可以锁定完成")
    log = add_stage_log(st, "阶段锁定完成,刻除区/凸面/印数全部归档")
    db.execute("UPDATE reduction_stages SET status='locked',log=? WHERE id=?",
               (json.dumps(log, ensure_ascii=False), sid))
    db.commit()
    flow, rows = recompute_flow(st["flow_id"])
    return jsonify(flow_to_dict(flow, rows))


@app.post("/api/stages/<int:sid>/unlock")
def unlock_stage(sid):
    db = get_db()
    st = db.execute("SELECT * FROM reduction_stages WHERE id=?", (sid,)).fetchone()
    if not st:
        abort(404, "阶段不存在")
    if st["status"] != "locked":
        abort(409, "仅锁定阶段可以解锁")
    log = add_stage_log(st, "解锁(回到已印状态,几何与印数不变)")
    db.execute("UPDATE reduction_stages SET status='printed',log=? WHERE id=?",
               (json.dumps(log, ensure_ascii=False), sid))
    db.commit()
    flow, rows = recompute_flow(st["flow_id"])
    return jsonify(flow_to_dict(flow, rows))


@app.delete("/api/stages/<int:sid>")
def delete_stage(sid):
    db = get_db()
    st = db.execute("SELECT * FROM reduction_stages WHERE id=?", (sid,)).fetchone()
    if not st:
        abort(404, "阶段不存在")
    if st["status"] != "draft":
        abort(409, "仅草稿阶段可以删除(已印阶段及刻掉的区域不能恢复)")
    fid = st["flow_id"]
    db.execute("DELETE FROM reduction_stages WHERE id=?", (sid,))
    db.execute("UPDATE reduction_stages SET seq=seq-1 WHERE flow_id=? AND seq>?",
               (fid, st["seq"]))
    db.commit()
    flow, rows = recompute_flow(fid)
    return jsonify(flow_to_dict(flow, rows))


# ---------------------------------------------------------------- 定位板 API

JIG_SCALE = 2.0          # 槽口/图形重叠栅格化分辨率 px/mm
DEFAULT_MARK_INSET = 8.0  # 同步套准标记距裁切纸边的内缩 mm
DEFAULT_SEARCH_STEP = 5.0

# 角定位槽可选的靠边方向 → (角点偏移, 两条邻边定义)
# 每条邻边: 外法向 n(指向纸外)、自角点沿边的切向 t
JIG_CORNERS = {
    "bottom-left": {
        "point": (0.0, 1.0),
        "edges": {
            "left":   {"n": (-1, 0), "t": (0, -1), "len": "h"},
            "bottom": {"n": (0, 1),  "t": (1, 0),  "len": "w"},
        },
    },
    "bottom-right": {
        "point": (1.0, 1.0),
        "edges": {
            "right":  {"n": (1, 0),  "t": (0, -1), "len": "h"},
            "bottom": {"n": (0, 1),  "t": (-1, 0), "len": "w"},
        },
    },
    "top-left": {
        "point": (0.0, 0.0),
        "edges": {
            "left": {"n": (-1, 0), "t": (0, 1), "len": "h"},
            "top":  {"n": (0, -1), "t": (1, 0), "len": "w"},
        },
    },
    "top-right": {
        "point": (1.0, 0.0),
        "edges": {
            "right": {"n": (1, 0), "t": (0, 1),  "len": "h"},
            "top":   {"n": (0, -1), "t": (-1, 0), "len": "w"},
        },
    },
}

CORNER_LABELS = {"bottom-left": "左下角", "bottom-right": "右下角",
                 "top-left": "左上角", "top-right": "右上角"}
EDGE_LABELS = {"left": "左边", "right": "右边", "top": "上边", "bottom": "下边"}
LOAD_LABELS = {"diag": "双向靠紧", "push_x": "横向推入", "push_y": "纵向推入"}


def default_jig_config(proj):
    """按项目成品纸尺寸给出可直接评估的定位板初值:
    裁切纸每边大 15mm,台面再大一圈,木版比成品区每边大 10mm。"""
    pw, ph = proj["paper_w"], proj["paper_h"]
    if proj["orientation"] == "landscape":
        pw, ph = ph, pw
    m = 15.0
    cut_w, cut_h = pw + 2 * m, ph + 2 * m
    px, py = 30.0, 30.0
    return {
        "table_w": cut_w + 60, "table_h": cut_h + 60,
        "paper_x": px, "paper_y": py, "paper_w": cut_w, "paper_h": cut_h,
        "fin_x": px + m, "fin_y": py + m, "fin_w": pw, "fin_h": ph,
        "block_x": px + m - 10, "block_y": py + m - 10,
        "block_w": pw + 20, "block_h": ph + 20,
        "corner": {"edge": "bottom-left", "width": 40, "depth": 8,
                   "gap": 1.0, "locked": 0},
        # 默认侧槽放在长边、尽量靠远端,以获得最长力臂
        "side": {"edge": "left", "pos": round(ph + 2 * m - 22, 1),
                 "width": 30, "depth": 8, "gap": 1.0},
        "cut_error": 1.0, "max_skew_deg": 0.6, "lever_min_ratio": 0.4,
        "mark_inset": DEFAULT_MARK_INSET,
        "load_mode": "diag",
    }


def _merge_config(base, over):
    """用前端提交值覆盖默认/已存配置(仅取白名单字段,子表合并)。"""
    cfg = json.loads(json.dumps(base))
    over = over or {}
    for k, v in over.items():
        if k in ("corner", "side") and isinstance(v, dict):
            cfg[k].update(v)
        elif k in cfg:
            cfg[k] = v
    return cfg


def jig_rects(cfg):
    """返回定位板几何要素:(纸, 成品区, 木版, 角点, 邻边表, 角槽矩形[2], 侧槽矩形)。
    槽口矩形:槽口从纸边向外(外法向)先留装纸间隙 gap,再取 depth 深、沿切向 width 宽。"""
    px, py, pw, ph = cfg["paper_x"], cfg["paper_y"], cfg["paper_w"], cfg["paper_h"]
    paper = (px, py, pw, ph)
    fin = (cfg["fin_x"], cfg["fin_y"], cfg["fin_w"], cfg["fin_h"])
    block = (cfg["block_x"], cfg["block_y"], cfg["block_w"], cfg["block_h"])
    cspec = JIG_CORNERS[cfg["corner"]["edge"]]
    pcx = px + cspec["point"][0] * pw
    pcy = py + cspec["point"][1] * ph

    def slot_rect(edge_name, s0, s1, gap, depth):
        e = cspec["edges"][edge_name]
        nx, ny, tx, ty = e["n"][0], e["n"][1], e["t"][0], e["t"][1]
        xa = min(pcx + gap * nx + s0 * tx, pcx + (gap + depth) * nx + s1 * tx)
        xb = max(pcx + gap * nx + s0 * tx, pcx + (gap + depth) * nx + s1 * tx)
        ya = min(pcy + gap * ny + s0 * ty, pcy + (gap + depth) * ny + s1 * ty)
        yb = max(pcy + gap * ny + s0 * ty, pcy + (gap + depth) * ny + s1 * ty)
        return (xa, ya, xb - xa, yb - ya)

    co = cfg["corner"]
    corner_rects = [slot_rect(en, 0.0, float(co["width"]),
                              float(co["gap"]), float(co["depth"]))
                    for en in cspec["edges"]]
    so = cfg["side"]
    side_rect = None
    if so.get("edge") in cspec["edges"]:
        half = float(so["width"]) / 2
        side_rect = slot_rect(so["edge"], float(so["pos"]) - half,
                              float(so["pos"]) + half, float(so["gap"]), float(so["depth"]))
    edge_len = (pw if cspec["edges"][so["edge"]]["len"] == "w" else ph) \
        if side_rect else 0.0
    return {"paper": paper, "fin": fin, "block": block,
            "corner_point": (pcx, pcy), "corner_def": cspec,
            "corner_rects": corner_rects, "side_rect": side_rect,
            "side_edge_len": edge_len}


def rect_inter(a, b):
    x = max(a[0], b[0]); y = max(a[1], b[1])
    r = min(a[0] + a[2], b[0] + b[2]); t = min(a[1] + a[3], b[1] + b[3])
    if r <= x or t <= y:
        return 0.0
    return (r - x) * (t - y)


def rect_in_table(r, tw, th, eps=0.01):
    return r[0] >= -eps and r[1] >= -eps and r[0] + r[2] <= tw + eps and r[1] + r[3] <= th + eps


def jig_envelope(cfg, geom, load_mode=None):
    """最坏套准包络参数:平移预算 t(mm)、偏斜角 θ(rad)、角点枢轴。
    t 由 裁纸误差 + 未靠紧方向上的角槽/侧槽间隙 合成(按 x/y 分量取模);
    偏斜直接取设定的装纸偏斜上限,另由力臂算出几何可达偏斜供力臂检查。"""
    mode = load_mode or cfg.get("load_mode", "diag")
    seat_x = mode in ("diag", "push_x")
    seat_y = mode in ("diag", "push_y")
    co, so = cfg["corner"], cfg["side"]
    side_normal_axis = None
    if geom["side_rect"]:
        n = geom["corner_def"]["edges"][so["edge"]]["n"]
        side_normal_axis = "x" if n[0] != 0 else "y"
    cut = float(cfg["cut_error"])
    gx = 0.0 if seat_x else float(co["gap"])
    gy = 0.0 if seat_y else float(co["gap"])
    if not seat_x and side_normal_axis == "x":
        gx += float(so["gap"])
    if not seat_y and side_normal_axis == "y":
        gy += float(so["gap"])
    t = math.hypot(cut + gx, cut + gy)
    theta_cfg = math.radians(float(cfg["max_skew_deg"]))
    L = float(so["pos"]) if geom["side_rect"] else 0.0
    clear = float(co["gap"]) + float(so["gap"]) + cut
    theta_geom = math.atan(clear / L) if L > 1e-6 else math.pi / 2
    # 力臂越长,间隙能转化出的偏斜越小;实际最坏偏斜取设定上限与几何可达值的小者
    theta = min(theta_cfg, theta_geom)
    return {"t": t, "theta": theta, "pivot": geom["corner_point"],
            "theta_geom": theta_geom, "lever": L}


def evaluate_jig(proj, cfg, tolerance=None):
    """把 裁纸误差/槽口间隙/装纸偏斜 换算为各区域最坏错位,并汇总全部检查项。"""
    cfg = _merge_config(default_jig_config(proj), cfg)
    geom = jig_rects(cfg)
    env = jig_envelope(cfg, geom)
    theta, (pcx, pcy), t = env["theta"], env["pivot"], env["t"]
    skew_k = 2 * math.sin(theta / 2)

    # 区域最坏错位:设计坐标(成品区系)→ 板坐标,绕角槽角点偏斜 + 整体平移
    region_disps = []
    max_disp = 0.0
    over_count = 0
    art_polys = []
    for b in proj["blocks"]:
        for ri, r in enumerate(b["regions"]):
            d = 0.0
            bpts = []
            for p in r["points"]:
                bx = cfg["fin_x"] + p[0]
                by = cfg["fin_y"] + p[1]
                bpts.append((bx, by))
                dist = math.hypot(bx - pcx, by - pcy)
                d = max(d, t + skew_k * dist)
            art_polys.append(bpts)
            region_disps.append({"block_id": b["id"], "block_name": b["name"],
                                 "region": ri + 1, "disp": round(d, 3)})
            max_disp = max(max_disp, d)
            if tolerance is not None and d > tolerance:
                over_count += 1
    region_disps.sort(key=lambda z: -z["disp"])

    # 栅格化域:纸/木版/槽口的总外接框
    allrects = [geom["paper"], geom["block"]] + geom["corner_rects"]
    if geom["side_rect"]:
        allrects.append(geom["side_rect"])
    bx0 = min(r[0] for r in allrects)
    by0 = min(r[1] for r in allrects)
    bx1 = max(r[0] + r[2] for r in allrects)
    by1 = max(r[1] + r[3] for r in allrects)
    W = max(1, round((bx1 - bx0) * JIG_SCALE))
    H = max(1, round((by1 - by0) * JIG_SCALE))

    def shifted(polys):
        return [[(p[0] - bx0, p[1] - by0) for p in pts] for pts in polys]

    art_bits = rasterize_polys(shifted(art_polys), W, H, JIG_SCALE)
    cell = (1.0 / JIG_SCALE) ** 2

    def rect_bits(r):
        return rasterize_polys([[(r[0], r[1]), (r[0] + r[2], r[1]),
                                 (r[0] + r[2], r[1] + r[3]), (r[0], r[1] + r[3])]],
                               W, H, JIG_SCALE)

    issues = []
    slot_rects = geom["corner_rects"] + ([geom["side_rect"]] if geom["side_rect"] else [])
    # ① 槽口压图形 / 压纸张 / 压木版
    names = ["角槽·" + EDGE_LABELS.get(en, en) for en in geom["corner_def"]["edges"]]
    if geom["side_rect"]:
        names.append("侧槽·" + EDGE_LABELS.get(cfg["side"]["edge"], cfg["side"]["edge"]))
    for name, r in zip(names, slot_rects):
        a_art = (art_bits & rect_bits(r)).bit_count() * cell
        if a_art > 0.5:
            issues.append({"type": "slot_art", "blocking": True,
                           "text": f"{name}槽口压住印刷图形约 {a_art:.1f} mm²,会蹭脏画面或挡版"})
        if rect_inter(r, geom["paper"]) > 1e-6:
            issues.append({"type": "slot_paper", "blocking": True,
                           "text": f"{name}槽口伸入裁切纸边缘(装纸间隙为负),纸张无法落位"})
        if rect_inter(r, geom["block"]) > 1e-6:
            issues.append({"type": "slot_block", "blocking": True,
                           "text": f"{name}槽口与木版投影重叠,木版无法平整落台"})
        if not rect_in_table(r, cfg["table_w"], cfg["table_h"]):
            issues.append({"type": "slot_table", "blocking": True,
                           "text": f"{name}槽口越出台面"})

    # ② 纸张 / 木版越出台面
    if not rect_in_table(geom["paper"], cfg["table_w"], cfg["table_h"]):
        issues.append({"type": "paper_table", "blocking": True,
                       "text": "裁切纸越出台面范围,无法平放"})
    if not rect_in_table(geom["block"], cfg["table_w"], cfg["table_h"]):
        issues.append({"type": "block_table", "blocking": True,
                       "text": "木版越出台面范围"})
    # 成品区不在裁切纸内(警告)
    if rect_inter(geom["fin"], geom["paper"]) + 0.01 < geom["fin"][2] * geom["fin"][3]:
        issues.append({"type": "fin_paper", "blocking": False,
                       "text": "成品区未完全落在裁切纸内,裁切余量不足"})

    # ③ 侧槽力臂 / 位置
    so = cfg["side"]
    if not geom["side_rect"]:
        issues.append({"type": "side_edge", "blocking": True,
                       "text": f"侧槽靠边「{so['edge']}」不经过角槽{CORNER_LABELS[cfg['corner']['edge']]}"})
    else:
        elen = geom["side_edge_len"]
        L = env["lever"]
        half = float(so["width"]) / 2
        if L - half < 0 or L + half > elen + 0.01:
            issues.append({"type": "side_range", "blocking": True,
                           "text": f"侧槽超出纸边(位置 {L:.0f} ± {half:.0f} mm,边长 {elen:.0f} mm)"})
        ratio = float(cfg["lever_min_ratio"])
        if L < ratio * elen:
            issues.append({"type": "lever_short", "blocking": False,
                           "text": f"侧槽力臂过短:距角点 {L:.0f} mm < 边长 {elen:.0f} mm 的 {ratio:.0%}"
                                   f"(建议 ≥ {ratio * elen:.0f} mm)"})
        if env["theta_geom"] > theta:
            issues.append({"type": "lever_skew", "blocking": False,
                           "text": f"按当前间隙与力臂,装纸偏斜最坏可达 {math.degrees(env['theta_geom']):.2f}°"
                                   f",超过设定的 {cfg['max_skew_deg']:.2f}°(力臂 {L:.0f} mm 偏短)"})

    blocking = sum(1 for i in issues if i["blocking"])
    warnings = len(issues) - blocking
    return {
        "issues": issues, "blocking_count": blocking, "warning_count": warnings,
        "over_count": over_count, "max_disp": round(max_disp, 3),
        "region_disps": region_disps[:20],
        "envelope": {"t": round(t, 3), "theta_deg": cfg["max_skew_deg"],
                     "theta_geom_deg": round(math.degrees(env["theta_geom"]), 3),
                     "lever": round(env["lever"], 1)},
        "footprint": {"x": round(bx0, 1), "y": round(by0, 1),
                      "w": round(bx1 - bx0, 1), "h": round(by1 - by0, 1),
                      "area": round((bx1 - bx0) * (by1 - by0), 0)},
    }


def jig_search(proj, cfg, tolerance, step=DEFAULT_SEARCH_STEP):
    """锁定角槽,枚举侧槽位置 × 邻边 × 装纸方向,按
    超限区域数 → 阻断问题数 → 最大错位 → 占板面积 排序。"""
    cfg = _merge_config(default_jig_config(proj), cfg)
    cands = []
    edges = list(JIG_CORNERS[cfg["corner"]["edge"]]["edges"].keys())
    for edge in edges:
        elen = (cfg["paper_w"] if JIG_CORNERS[cfg["corner"]["edge"]]["edges"][edge]["len"] == "w"
                else cfg["paper_h"])
        half = float(cfg["side"]["width"]) / 2
        ratio = float(cfg["lever_min_ratio"])
        lo = max(half + 1, ratio * elen)
        hi = elen - half - 1
        pos = lo
        while pos <= hi + 1e-6:
            for mode in ("diag", "push_x", "push_y"):
                trial = json.loads(json.dumps(cfg))
                trial["side"]["edge"] = edge
                trial["side"]["pos"] = round(pos, 1)
                trial["load_mode"] = mode
                m = evaluate_jig(proj, trial, tolerance)
                if m["blocking_count"]:
                    pos += step
                    continue
                cands.append({
                    "side_edge": edge, "side_pos": round(pos, 1),
                    "load_mode": mode,
                    "over_count": m["over_count"],
                    "blocking_count": m["blocking_count"],
                    "warning_count": m["warning_count"],
                    "max_disp": m["max_disp"],
                    "footprint_area": m["footprint"]["area"],
                    "footprint": m["footprint"],
                    "theta_geom_deg": m["envelope"]["theta_geom_deg"],
                    "config": trial, "metrics": m,
                })
            pos += step
    cands.sort(key=lambda c: (c["over_count"], c["blocking_count"],
                              c["max_disp"], c["footprint_area"]))
    return cands[:30]


def jig_to_dict(r):
    d = {"id": r["id"], "project_id": r["project_id"], "name": r["name"],
         "config": json.loads(r["config"]), "metrics": json.loads(r["metrics"] or "{}"),
         "adopted": bool(r["adopted"]), "created_at": r["created_at"]}
    return d


def jig_sync_marks(cfg):
    """采纳方案 → 三块版统一的 3 个套准标记(裁切纸局部坐标):
    角点内缩、侧槽接触点内缩、对角点内缩。返回 (成品区设计坐标, 裁切纸坐标)。"""
    px, py, pw, ph = cfg["paper_x"], cfg["paper_y"], cfg["paper_w"], cfg["paper_h"]
    inset = float(cfg.get("mark_inset", DEFAULT_MARK_INSET))
    cspec = JIG_CORNERS[cfg["corner"]["edge"]]
    qx, qy = cspec["point"]
    corner_cut = [px + (inset if qx == 0 else pw - inset),
                  py + (inset if qy == 0 else ph - inset)]
    # 对角
    opp_cut = [px + (inset if qx == 1 else pw - inset),
               py + (inset if qy == 1 else ph - inset)]
    # 侧槽:沿边距角点 pos,再内缩 inset
    e = cspec["edges"][cfg["side"]["edge"]]
    L = float(cfg["side"]["pos"])
    sx = px + qx * pw + e["t"][0] * L - e["n"][0] * inset
    sy = py + qy * ph + e["t"][1] * L - e["n"][1] * inset
    side_cut = [sx, sy]
    cut_pts = [corner_cut, side_cut, opp_cut]
    # 转成品区设计坐标
    design_pts = [[round(x - (cfg["fin_x"] - px), 2), round(y - (cfg["fin_y"] - py), 2)]
                  for x, y in cut_pts]
    return design_pts


@app.get("/api/projects/<int:pid>/jigs")
def list_jigs(pid):
    rows = get_db().execute(
        "SELECT * FROM jig_boards WHERE project_id=? ORDER BY id DESC", (pid,)).fetchall()
    return jsonify([jig_to_dict(r) for r in rows])


@app.post("/api/projects/<int:pid>/jig-evaluate")
def jig_evaluate_api(pid):
    proj = load_project_full(pid)
    data = request.get_json(force=True) or {}
    tol = data.get("tolerance")
    return jsonify(evaluate_jig(proj, data.get("config") or {},
                                float(tol) if tol is not None else None))


@app.post("/api/projects/<int:pid>/jig-search")
def jig_search_api(pid):
    proj = load_project_full(pid)
    data = request.get_json(force=True) or {}
    tol = data.get("tolerance")
    if tol is None:
        abort(400, "请先给定允许错位 (mm)")
    cands = jig_search(proj, data.get("config") or {}, float(tol),
                       float(data.get("step") or DEFAULT_SEARCH_STEP))
    return jsonify({"total": len(cands), "candidates": cands})


@app.post("/api/projects/<int:pid>/jigs")
def create_jig(pid):
    proj = load_project_full(pid)
    data = request.get_json(force=True) or {}
    cfg = _merge_config(default_jig_config(proj), data.get("config") or {})
    tol = data.get("tolerance")
    metrics = evaluate_jig(proj, cfg, float(tol) if tol is not None else None)
    db = get_db()
    cur = db.execute(
        "INSERT INTO jig_boards(project_id,name,config,metrics) VALUES(?,?,?,?)",
        (pid, (data.get("name") or f"定位板方案").strip(),
         json.dumps(cfg, ensure_ascii=False),
         json.dumps(metrics, ensure_ascii=False)))
    db.commit()
    row = db.execute("SELECT * FROM jig_boards WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(jig_to_dict(row)), 201


@app.get("/api/jigs/<int:jid>")
def get_jig(jid):
    r = get_db().execute("SELECT * FROM jig_boards WHERE id=?", (jid,)).fetchone()
    if not r:
        abort(404, "定位板版本不存在")
    return jsonify(jig_to_dict(r))


@app.put("/api/jigs/<int:jid>")
def update_jig(jid):
    db = get_db()
    row = db.execute("SELECT * FROM jig_boards WHERE id=?", (jid,)).fetchone()
    if not row:
        abort(404, "定位板版本不存在")
    data = request.get_json(force=True) or {}
    proj = load_project_full(row["project_id"])
    cfg = json.loads(row["config"])
    if "config" in data:
        cfg = _merge_config(cfg, data["config"])
    name = (data.get("name") or row["name"]).strip()
    metrics = evaluate_jig(proj, cfg)
    db.execute("UPDATE jig_boards SET name=?,config=?,metrics=? WHERE id=?",
               (name, json.dumps(cfg, ensure_ascii=False),
                json.dumps(metrics, ensure_ascii=False), jid))
    db.commit()
    return jsonify(jig_to_dict(db.execute(
        "SELECT * FROM jig_boards WHERE id=?", (jid,)).fetchone()))


@app.delete("/api/jigs/<int:jid>")
def delete_jig(jid):
    get_db().execute("DELETE FROM jig_boards WHERE id=?", (jid,))
    get_db().commit()
    return jsonify({"ok": True})


@app.post("/api/jigs/<int:jid>/adopt")
def adopt_jig(jid):
    """采纳定位板方案:版本置为当前,并把统一的三点套准标记写回各版
    (历史试印记录 trials 不动)。"""
    db = get_db()
    row = db.execute("SELECT * FROM jig_boards WHERE id=?", (jid,)).fetchone()
    if not row:
        abort(404, "定位板版本不存在")
    cfg = json.loads(row["config"])
    proj = load_project_full(row["project_id"])
    metrics = evaluate_jig(proj, cfg)
    marks = jig_sync_marks(cfg)
    db.execute("UPDATE jig_boards SET adopted=0 WHERE project_id=?", (row["project_id"],))
    db.execute("UPDATE jig_boards SET adopted=1,metrics=? WHERE id=?",
               (json.dumps(metrics, ensure_ascii=False), jid))
    for b in proj["blocks"]:
        db.execute("UPDATE blocks SET reg_marks=? WHERE id=?",
                   (json.dumps(marks), b["id"]))
    db.commit()
    return jsonify({"jig": jig_to_dict(db.execute(
        "SELECT * FROM jig_boards WHERE id=?", (jid,)).fetchone()),
        "synced_marks": marks})


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=False)
