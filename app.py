# -*- coding: utf-8 -*-
"""套色木刻工作台 —— Flask + SQLite 后端。

功能:
  * 项目 / 色版 / 区域 的增删改查
  * 试印校准:由三对(设计坐标, 实测坐标)最小二乘解算 平移+旋转+统一缩放
  * 版序枚举:锁定部分版的位置,枚举剩余排列,按 混色误差 / 清墨换色次数 / 干燥等待次数 排序
  * 方案与试印记录持久化到 SQLite
"""
import json
import math
import os
import sqlite3
import itertools

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

def rasterize_overlaps(blocks, paper_w, paper_h):
    """把各版(含当前偏移/旋转)的区域栅格化,返回版间重叠像素数矩阵与覆盖计数。"""
    n = len(blocks)
    W = 140
    H = max(1, round(W * paper_h / paper_w))
    cw, ch = paper_w / W, paper_h / H
    cx, cy = paper_w / 2, paper_h / 2
    # 每版变换后的多边形列表
    polys = []
    for b in blocks:
        lst = []
        for r in b["regions"]:
            lst.append([transform_point(p[0], p[1], cx, cy,
                                        b["offset_x"], b["offset_y"], b["rotation"])
                        for p in r["points"]])
        polys.append(lst)
    overlap = [[0] * n for _ in range(n)]
    for gy in range(H):
        y = (gy + 0.5) * ch
        for gx in range(W):
            x = (gx + 0.5) * cw
            covering = []
            for i in range(n):
                for poly in polys[i]:
                    if point_in_poly(x, y, poly):
                        covering.append(i)
                        break
            for a, bidx in itertools.combinations(covering, 2):
                overlap[a][bidx] += 1
                overlap[bidx][a] += 1
    cell_area = cw * ch
    return [[overlap[i][j] * cell_area for j in range(n)] for i in range(n)]


def order_metrics(order, overlap, idx):
    """order: block 下标序列。返回 (混色误差, 换色次数, 干燥等待次数)。"""
    blocks = order_metrics.blocks
    color_err = 0.0
    for later in range(1, len(order)):
        bj = blocks[order[later]]
        aj = bj["opacity"]
        ink_j = hex_to_rgb(bj["ink_color"])
        tgt_j = hex_to_rgb(bj["target_color"])
        for earlier in range(later):
            bi = blocks[order[earlier]]
            area = overlap[idx[order[earlier]]][idx[order[later]]]
            if area <= 0:
                continue
            ink_i = hex_to_rgb(bi["ink_color"])
            mixed = tuple(aj * ink_j[k] + (1 - aj) * ink_i[k] for k in range(3))
            err = math.sqrt(sum((mixed[k] - tgt_j[k]) ** 2 for k in range(3)))
            color_err += err * area
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
    overlap = rasterize_overlaps(blocks, pw, ph)
    idx = list(range(n))

    # blocks 已按 seq 排序;锁定的版固定在当前的印次位置,其余版排列其余位置
    locked = {i: i for i, b in enumerate(blocks) if b["locked_position"]}
    free_pos = [p for p in range(n) if p not in locked]
    free_blocks = [i for i in range(n) if i not in locked.values()]

    order_metrics.blocks = blocks
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
        ce, ic, dw = order_metrics(order, overlap, idx)
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


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=False)
