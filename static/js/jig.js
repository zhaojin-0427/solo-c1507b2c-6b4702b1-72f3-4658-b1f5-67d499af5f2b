/* ⑧ 定位板:角槽 + 侧槽、最坏套准包络、搜索采纳、1:1 出图 */
"use strict";

const JG = {
  config: null,          // 定位板配置(台面系,mm)
  jigs: [],              // 已保存版本
  currentJigId: null,
  metrics: null,         // 最近一次评估结果
  candidates: [],
  tolerance: 1.5,        // 允许错位 mm
  trial: null,           // 试放纸张 {dx,dy,drot}(相对名义纸位)
  dragging: null,
};

/* 与后端 app.py JIG_CORNERS 保持一致 */
const JG_CORNERS = {
  "bottom-left": {
    point: [0, 1],
    edges: {
      left:   { n: [-1, 0], t: [0, -1], len: "h" },
      bottom: { n: [0, 1],  t: [1, 0],  len: "w" },
    },
  },
  "bottom-right": {
    point: [1, 1],
    edges: {
      right:  { n: [1, 0],  t: [0, -1], len: "h" },
      bottom: { n: [0, 1],  t: [-1, 0], len: "w" },
    },
  },
  "top-left": {
    point: [0, 0],
    edges: {
      left: { n: [-1, 0], t: [0, 1], len: "h" },
      top:  { n: [0, -1], t: [1, 0], len: "w" },
    },
  },
  "top-right": {
    point: [1, 0],
    edges: {
      right: { n: [1, 0], t: [0, 1],  len: "h" },
      top:   { n: [0, -1], t: [-1, 0], len: "w" },
    },
  },
};
const JG_EDGE_CN = { left: "左边", right: "右边", top: "上边", bottom: "下边" };
const JG_CORNER_CN = { "bottom-left": "左下角", "bottom-right": "右下角", "top-left": "左上角", "top-right": "右上角" };
const JG_LOAD_CN = { diag: "双向靠紧", push_x: "横向推入", push_y: "纵向推入" };
const PRINT_DPI = 3.78;   // 96dpi:1mm ≈ 3.78px,打印时须选 100% 比例

/* ---------------- 默认配置与几何(镜像后端) ---------------- */

function defaultJigConfig() {
  const p = App.project;
  let pw = p.paper_w, ph = p.paper_h;
  if (p.orientation === "landscape") [pw, ph] = [ph, pw];
  const m = 15;
  const cutW = pw + 2 * m, cutH = ph + 2 * m;
  return {
    table_w: cutW + 60, table_h: cutH + 60,
    paper_x: 30, paper_y: 30, paper_w: cutW, paper_h: cutH,
    fin_x: 30 + m, fin_y: 30 + m, fin_w: pw, fin_h: ph,
    block_x: 30 + m - 10, block_y: 30 + m - 10,
    block_w: pw + 20, block_h: ph + 20,
    corner: { edge: "bottom-left", width: 40, depth: 8, gap: 1, locked: 0 },
    side: { edge: "left", pos: +(ph + 2 * m - 22).toFixed(1), width: 30, depth: 8, gap: 1 },
    cut_error: 1, max_skew_deg: 0.6, lever_min_ratio: 0.4,
    mark_inset: 8, load_mode: "diag",
  };
}

function jigGeom(cfg) {
  const { paper_x: px, paper_y: py, paper_w: pw, paper_h: ph } = cfg;
  const cspec = JG_CORNERS[cfg.corner.edge];
  const pcx = px + cspec.point[0] * pw;
  const pcy = py + cspec.point[1] * ph;
  function slotRect(en, s0, s1, gap, depth) {
    const e = cspec.edges[en], [nx, ny] = e.n, [tx, ty] = e.t;
    const xa = Math.min(pcx + gap * nx + s0 * tx, pcx + (gap + depth) * nx + s1 * tx);
    const xb = Math.max(pcx + gap * nx + s0 * tx, pcx + (gap + depth) * nx + s1 * tx);
    const ya = Math.min(pcy + gap * ny + s0 * ty, pcy + (gap + depth) * ny + s1 * ty);
    const yb = Math.max(pcy + gap * ny + s0 * ty, pcy + (gap + depth) * ny + s1 * ty);
    return [xa, ya, xb - xa, yb - ya];
  }
  const co = cfg.corner;
  const cornerRects = Object.keys(cspec.edges).map(en =>
    slotRect(en, 0, +co.width, +co.gap, +co.depth));
  const so = cfg.side;
  let sideRect = null, edgeLen = 0;
  if (cspec.edges[so.edge]) {
    const half = +so.width / 2;
    sideRect = slotRect(so.edge, +so.pos - half, +so.pos + half, +so.gap, +so.depth);
    edgeLen = cspec.edges[so.edge].len === "w" ? pw : ph;
  }
  return {
    paper: [px, py, pw, ph], fin: [cfg.fin_x, cfg.fin_y, cfg.fin_w, cfg.fin_h],
    block: [cfg.block_x, cfg.block_y, cfg.block_w, cfg.block_h],
    cornerPoint: [pcx, pcy], cornerDef: cspec,
    cornerRects, sideRect, edgeLen,
  };
}

function jigEnvelope(cfg, geom, loadMode) {
  const mode = loadMode || cfg.load_mode;
  const seatX = mode === "diag" || mode === "push_x";
  const seatY = mode === "diag" || mode === "push_y";
  let sideAxis = null;
  if (geom.sideRect) {
    const n = geom.cornerDef.edges[cfg.side.edge].n;
    sideAxis = n[0] !== 0 ? "x" : "y";
  }
  const cut = +cfg.cut_error;
  let gx = seatX ? 0 : +cfg.corner.gap;
  let gy = seatY ? 0 : +cfg.corner.gap;
  if (!seatX && sideAxis === "x") gx += +cfg.side.gap;
  if (!seatY && sideAxis === "y") gy += +cfg.side.gap;
  const t = Math.hypot(cut + gx, cut + gy);
  const thetaCfg = cfg.max_skew_deg * Math.PI / 180;
  const L = geom.sideRect ? +cfg.side.pos : 0;
  const clear = +cfg.corner.gap + +cfg.side.gap + cut;
  const thetaGeom = L > 1e-6 ? Math.atan(clear / L) : Math.PI / 2;
  return { t, theta: Math.min(thetaCfg, thetaGeom), thetaGeom, lever: L,
    pivot: geom.cornerPoint };
}

/* 采纳后同步给各版的 3 点标记(成品区设计坐标),镜像后端 jig_sync_marks */
function jigSyncMarks(cfg) {
  const { paper_x: px, paper_y: py, paper_w: pw, paper_h: ph } = cfg;
  const inset = +cfg.mark_inset;
  const cdef = JG_CORNERS[cfg.corner.edge];
  const [qx, qy] = cdef.point;
  const cut = [
    [px + (qx === 0 ? inset : pw - inset), py + (qy === 0 ? inset : ph - inset)],
    [px + (qx === 1 ? inset : pw - inset), py + (qy === 1 ? inset : ph - inset)],
  ];
  const e = cdef.edges[cfg.side.edge];
  const L = +cfg.side.pos;
  cut.splice(1, 0, [
    px + qx * pw + e.t[0] * L - e.n[0] * inset,
    py + qy * ph + e.t[1] * L - e.n[1] * inset,
  ]);
  const mx = cfg.fin_x - px, my = cfg.fin_y - py;
  return cut.map(([x, y]) => [+((x - mx)).toFixed(2), +((y - my)).toFixed(2)]);
}

function pointInRect(x, y, r, pad = 0) {
  return x >= r[0] - pad && x <= r[0] + r[2] + pad && y >= r[1] - pad && y <= r[1] + r[3] + pad;
}

/* ---------------- 表单 ---------------- */

const DIM_FIELDS = [
  ["table_w", "台面宽"], ["table_h", "台面高"],
  ["paper_x", "裁切纸 X"], ["paper_y", "裁切纸 Y"],
  ["paper_w", "裁切纸宽"], ["paper_h", "裁切纸高"],
  ["fin_x", "成品区 X"], ["fin_y", "成品区 Y"],
  ["fin_w", "成品区宽"], ["fin_h", "成品区高"],
  ["block_x", "木版 X"], ["block_y", "木版 Y"],
  ["block_w", "木版宽"], ["block_h", "木版高"],
];
const TOL_FIELDS = [
  ["cut_error", "裁纸误差 mm", 0.1], ["max_skew_deg", "装纸偏斜上限 °", 0.05],
  ["lever_min_ratio", "最短力臂比", 0.05], ["mark_inset", "标记内缩 mm", 0.5],
];

function numInput(key, val, step, nested) {
  return `<input type="number" step="${step || 0.1}" data-jg="${nested ? nested + "." : ""}${key}" value="${val}">`;
}

function renderForms() {
  const cfg = JG.config;
  if (!cfg) return;
  const dims = $("#jig-dims-form");
  dims.innerHTML = DIM_FIELDS.map(([k, label]) =>
    `<label>${label} ${numInput(k, cfg[k])}</label>`).join("");

  const co = cfg.corner;
  const cornerOpts = Object.keys(JG_CORNERS).map(k =>
    `<option value="${k}" ${co.edge === k ? "selected" : ""}>${JG_CORNER_CN[k]}</option>`).join("");
  $("#jig-corner-form").innerHTML = `
    <label>靠边方向
      <select data-jg="corner.edge" ${co.locked ? "disabled" : ""}>${cornerOpts}</select>
    </label>
    <div class="form-grid">
      <label>槽宽 (mm) ${numInput("width", co.width, 0.5, "corner")}</label>
      <label>槽深 (mm) ${numInput("depth", co.depth, 0.5, "corner")}</label>
      <label>装纸间隙 (mm) ${numInput("gap", co.gap, 0.1, "corner")}</label>
    </div>
    <label><input type="checkbox" data-jg="corner.locked" ${co.locked ? "checked" : ""}>
      锁定角槽(搜索时不动)</label>`;

  const so = cfg.side;
  const edgeOpts = Object.keys(JG_CORNERS[co.edge].edges).map(k =>
    `<option value="${k}" ${so.edge === k ? "selected" : ""}>${JG_EDGE_CN[k]}</option>`).join("");
  $("#jig-side-form").innerHTML = `
    <label>靠边方向 <select data-jg="side.edge">${edgeOpts}</select></label>
    <div class="form-grid">
      <label>距角点 (mm) ${numInput("pos", so.pos, 0.5, "side")}</label>
      <label>槽宽 (mm) ${numInput("width", so.width, 0.5, "side")}</label>
      <label>槽深 (mm) ${numInput("depth", so.depth, 0.5, "side")}</label>
      <label>装纸间隙 (mm) ${numInput("gap", so.gap, 0.1, "side")}</label>
    </div>`;

  $("#jig-tol-form").innerHTML = TOL_FIELDS.map(([k, label, st]) =>
    `<label>${label} ${numInput(k, cfg[k], st)}</label>`).join("") +
    `<label>装纸方向
      <select data-jg="load_mode">
        ${Object.keys(JG_LOAD_CN).map(k =>
          `<option value="${k}" ${cfg.load_mode === k ? "selected" : ""}>${JG_LOAD_CN[k]}</option>`).join("")}
      </select></label>
      <label>允许错位 (mm)
      <input type="number" step="0.1" id="jig-tolerance" value="${JG.tolerance}"></label>`;

  bindFormInputs();
}

function setJgPath(root, path, val) {
  const ks = path.split(".");
  let o = root;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
  o[ks[ks.length - 1]] = val;
}

function bindFormInputs() {
  $$("#tab-jig [data-jg]").forEach(el => {
    el.onchange = async () => {
      const path = el.dataset.jg;
      if (el.type === "checkbox") setJgPath(JG.config, path, el.checked ? 1 : 0);
      else if (el.tagName === "SELECT") {
        setJgPath(JG.config, path, el.value);
        if (path === "corner.edge") {
          // 角槽换角后,侧槽必须落在新角的邻边上
          const edges = Object.keys(JG_CORNERS[JG.config.corner.edge].edges);
          if (!edges.includes(JG.config.side.edge)) JG.config.side.edge = edges[0];
        }
      } else setJgPath(JG.config, path, parseFloat(el.value) || 0);
      renderForms();
      redrawJig();
      scheduleEval();
    };
  });
  const tol = $("#jig-tolerance");
  if (tol) tol.onchange = () => { JG.tolerance = parseFloat(tol.value) || 0; scheduleEval(); };
}

/* ---------------- 评估(后端) ---------------- */

let evalTimer = null;
function scheduleEval() {
  clearTimeout(evalTimer);
  evalTimer = setTimeout(doEval, 220);
}

async function doEval() {
  if (!JG.config || !App.project) return;
  try {
    JG.metrics = await api(`/api/projects/${App.project.id}/jig-evaluate`, "POST", {
      config: JG.config, tolerance: JG.tolerance,
    });
    renderMetrics();
  } catch (e) { /* 拖动中参数瞬时非法时静默 */ }
}

function renderMetrics() {
  const m = JG.metrics;
  const box = $("#jig-metrics");
  if (!m) { box.innerHTML = ""; return; }
  const env = m.envelope;
  const thetaEff = Math.min(env.theta_deg, env.theta_geom_deg);
  const bad = m.blocking_count > 0 || m.over_count > 0;
  box.innerHTML = `
    <div style="color:${bad ? "#b00020" : "#31572c"};font-weight:bold;margin-bottom:4px">
      最大错位 ${m.max_disp} mm · 超限区域 ${m.over_count} 个
      (允许 ${JG.tolerance} mm)
    </div>
    <div>阻断问题 <b style="color:${m.blocking_count ? "#b00020" : "#31572c"}">${m.blocking_count}</b>
      · 警告 ${m.warning_count}
      · 占板 ${m.footprint.w} × ${m.footprint.h} mm
      (${(m.footprint.area / 100).toFixed(1)} cm²)</div>
    <div>平移预算 t=${env.t} mm · 最坏偏斜 ${thetaEff.toFixed(2)}°
      (力臂几何 ${env.theta_geom_deg}°/设定 ${env.theta_deg}°) · 侧槽力臂 ${env.lever} mm</div>
    <div style="margin-top:4px">错位最大的区域:
      ${m.region_disps.slice(0, 5).map(d =>
        `${d.block_name}-区${d.region} ${d.disp}mm`).join(" · ") || "—"}</div>`;
  const ul = $("#jig-issues");
  ul.innerHTML = "";
  if (!m.issues.length) {
    ul.innerHTML = "<li><span class='tag'>未发现槽口压图形、越出台面或力臂问题</span></li>";
  }
  m.issues.forEach(it => {
    const li = document.createElement("li");
    li.className = "rf-issue " + (it.blocking ? "block" : "warn");
    li.innerHTML = `<span>${it.blocking ? "⛔" : "⚠"} ${it.text}</span>`;
    ul.appendChild(li);
  });
}

/* ---------------- 画布 ---------------- */

let jigView = null;

function jigBounds() {
  const cfg = JG.config, g = jigGeom(cfg);
  const rs = [g.block, g.paper, [0, 0, cfg.table_w, cfg.table_h], ...g.cornerRects];
  if (g.sideRect) rs.push(g.sideRect);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  rs.forEach(r => {
    x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]);
    x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3]);
  });
  return { x0: x0 - 12, y0: y0 - 12, x1: x1 + 12, y1: y1 + 12 };
}

function setupJigCanvas() {
  const canvas = $("#jig-canvas");
  const wrap = canvas.parentElement;
  const maxW = Math.max(120, wrap.clientWidth - 24);
  const maxH = Math.max(120, window.innerHeight - 200);
  const b = jigBounds();
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const scale = Math.min(maxW / bw, maxH / bh);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.ceil(bw * scale * dpr) + 2;
  canvas.height = Math.ceil(bh * scale * dpr) + 2;
  canvas.style.width = Math.ceil(bw * scale) + "px";
  canvas.style.height = Math.ceil(bh * scale) + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  jigView = { ctx, scale, ox: -b.x0, oy: -b.y0 };
}
function jPx(x, y) { return [jigView.ox + x * jigView.scale, jigView.oy + y * jigView.scale]; }
function jMm(px, py) { return [(px - jigView.ox) / jigView.scale, (py - jigView.oy) / jigView.scale]; }

function jRect(r, fill, stroke, lw, dash) {
  const { ctx } = jigView;
  const [x, y] = jPx(r[0], r[1]);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, r[2] * jigView.scale, r[3] * jigView.scale);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) {
    ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1;
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
  }
  ctx.restore();
}

function jLabel(text, x, y, color, size) {
  const { ctx } = jigView;
  const [px, py] = jPx(x, y);
  ctx.save();
  ctx.fillStyle = color || "#333";
  ctx.font = `${size || 11}px sans-serif`;
  ctx.fillText(text, px + 3, py - 3);
  ctx.restore();
}

function jPoly(points, fill, stroke, lw) {
  const { ctx } = jigView;
  ctx.save();
  ctx.beginPath();
  points.forEach(([x, y], i) => {
    const [px, py] = jPx(x, y);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  ctx.restore();
}

function jCross(x, y, sizeMm, color, label) {
  const [px, py] = jPx(x, y);
  const s = sizeMm * jigView.scale;
  const { ctx } = jigView;
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(px - s, py); ctx.lineTo(px + s, py);
  ctx.moveTo(px, py - s); ctx.lineTo(px, py + s);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(px, py, s * 0.55, 0, Math.PI * 2); ctx.stroke();
  if (label) { ctx.fillStyle = color; ctx.font = "11px sans-serif"; ctx.fillText(label, px + s + 2, py - 2); }
  ctx.restore();
}

function drawRectOutlineShifted(r, dx, dy, color) {
  jPoly([[r[0] + dx, r[1] + dy], [r[0] + r[2] + dx, r[1] + dy],
         [r[0] + r[2] + dx, r[1] + r[3] + dy], [r[0] + dx, r[1] + r[3] + dy]],
        null, color, 1);
}

function drawEnvelope(cfg, g) {
  const env = jigEnvelope(cfg, g);
  const [pcx, pcy] = env.pivot, r = g.paper;
  const { ctx } = jigView;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([5, 3]);
  ctx.strokeStyle = "#d32f2f";
  ctx.lineWidth = 1;
  // 偏斜包络:绕角点 ±θ
  [env.theta, -env.theta].forEach(a => {
    const pts = [[r[0], r[1]], [r[0] + r[2], r[1]], [r[0] + r[2], r[1] + r[3]], [r[0], r[1] + r[3]]]
      .map(([x, y]) => {
        const ux = x - pcx, uy = y - pcy, c = Math.cos(a), s = Math.sin(a);
        return [pcx + c * ux - s * uy, pcy + s * ux + c * uy];
      });
    jPoly(pts, null, "#d32f2f", 1);
  });
  ctx.setLineDash([2, 3]);
  // 平移包络:±t(x、y 两个方向)
  drawRectOutlineShifted(r, env.t, 0, "#e67e22");
  drawRectOutlineShifted(r, -env.t, 0, "#e67e22");
  drawRectOutlineShifted(r, 0, env.t, "#e67e22");
  drawRectOutlineShifted(r, 0, -env.t, "#e67e22");
  ctx.restore();
  jCross(pcx, pcy, 2.5, "#b71c1c", null);
}

function drawTrialPaper(cfg, g) {
  const tr = JG.trial;
  if (!tr) return;
  const r = g.paper, [pcx, pcy] = g.cornerPoint;
  const pts = [[r[0], r[1]], [r[0] + r[2], r[1]], [r[0] + r[2], r[1] + r[3]], [r[0], r[1] + r[3]]]
    .map(([x, y]) => {
      const ux = x - pcx, uy = y - pcy, a = tr.drot * Math.PI / 180;
      const c = Math.cos(a), s = Math.sin(a);
      return [pcx + c * ux - s * uy + tr.dx, pcy + s * ux + c * uy + tr.dy];
    });
  jPoly(pts, "rgba(183,28,28,0.07)", "#b71c1c", 2);
  updateTrialInfo(g, pts);
}

function seatPose(cfg, g) {
  // 角槽两面接触时纸位:沿两条邻边外法向各移出 gap
  const edges = Object.values(g.cornerDef.edges);
  const n = edges.reduce((a, e) => [a[0] + e.n[0], a[1] + e.n[1]], [0, 0]);
  return { dx: +cfg.corner.gap * n[0], dy: +cfg.corner.gap * n[1], drot: 0 };
}

function updateTrialInfo(g, trialPts) {
  const cfg = JG.config, tr = JG.trial;
  const [pcx, pcy] = g.cornerPoint;
  // 试放变换后的角点
  const a = tr.drot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const T = (x, y) => {
    const ux = x - pcx, uy = y - pcy;
    return [pcx + c * ux - s * uy + tr.dx, pcy + s * ux + c * uy + tr.dy];
  };
  const P = T(pcx, pcy);
  const parts = [];
  Object.entries(g.cornerDef.edges).forEach(([en, e]) => {
    // 止挡面过 P0 + gap*n;剩余间隙 = (P试 - 止挡面点)·n,负值表示纸压过止挡面
    const remain = (P[0] - (pcx + cfg.corner.gap * e.n[0])) * e.n[0]
                 + (P[1] - (pcy + cfg.corner.gap * e.n[1])) * e.n[1];
    parts.push(`${JG_EDGE_CN[en]}${remain >= 0 ? "离面" : "压入"} ${Math.abs(remain).toFixed(1)}mm`);
  });
  if (g.sideRect) {
    const e = g.cornerDef.edges[cfg.side.edge];
    const Q = T(pcx + e.t[0] * cfg.side.pos, pcy + e.t[1] * cfg.side.pos);
    const remain = (Q[0] - (pcx + cfg.side.gap * e.n[0])) * e.n[0]
                 + (Q[1] - (pcy + cfg.side.gap * e.n[1])) * e.n[1];
    parts.push(`侧槽${remain >= 0 ? "离面" : "压入"} ${Math.abs(remain).toFixed(1)}mm`);
  }
  parts.push(`偏斜 ${tr.drot.toFixed(2)}°`);
  parts.push(`平移 (${tr.dx.toFixed(1)}, ${tr.dy.toFixed(1)})`);
  $("#jig-drag-info").textContent = parts.join(" · ");
}

function redrawJig() {
  if (!JG.config || !App.project) return;
  setupJigCanvas();
  const { ctx } = jigView;
  const cfg = JG.config, g = jigGeom(cfg);

  // 台面
  jRect([0, 0, cfg.table_w, cfg.table_h], "#efe8d6", "#8a7f6a", 1.5);
  jLabel(`印刷台面 ${cfg.table_w} × ${cfg.table_h} mm`, 2, 4, "#8a7f6a");
  // 木版
  jRect(g.block, "#caa472", "#7a5a2e", 1.5);
  jLabel(`木版 ${cfg.block_w} × ${cfg.block_h}`, g.block[0], g.block[1], "#5a4120");
  // 图形(各版区域,设计坐标 → 板坐标)
  blocksSorted().forEach((b, bi) => {
    b.regions.forEach(r => {
      const pts = r.points.map(([x, y]) => [cfg.fin_x + x, cfg.fin_y + y]);
      jPoly(pts, b.ink_color + "aa", b.ink_color, 0.8);
    });
  });
  // 裁切纸 + 成品区
  jRect(g.paper, "rgba(255,255,255,0.45)", "#33691e", 1.5);
  jLabel(`裁切纸 ${cfg.paper_w} × ${cfg.paper_h}`, g.paper[0], g.paper[1], "#33691e");
  jRect(g.fin, null, "#1565c0", 1, [6, 3]);
  jLabel(`成品区 ${cfg.fin_w} × ${cfg.fin_h}`, g.fin[0], g.fin[1] + cfg.fin_h + 4, "#1565c0", 10);

  // 最坏包络
  if ($("#jig-show-envelope").checked && !$("#jig-trial").checked) drawEnvelope(cfg, g);

  // 槽口
  const edgeNames = Object.keys(g.cornerDef.edges);
  g.cornerRects.forEach((r, i) => {
    jRect(r, "rgba(46,125,44,0.55)", "#1b5e20", 1.5);
    jLabel(`角槽·${JG_EDGE_CN[edgeNames[i]]}`,
      r[0] + (r[2] < 12 ? -30 : 0), r[1] + (r[3] < 12 ? r[3] : 0), "#1b5e20", 10);
  });
  if (g.sideRect) {
    jRect(g.sideRect, "rgba(230,81,0,0.5)", "#bf360c", 1.5);
    const r = g.sideRect;
    jLabel(`侧槽·${JG_EDGE_CN[cfg.side.edge]}@${cfg.side.pos}`,
      r[0] + (r[2] < 12 ? -34 : 0), r[1] + (r[3] < 12 ? r[3] : 0), "#bf360c", 10);
  }

  // 同步后的三点标记(板坐标 = 成品区 + 设计坐标)
  if ($("#jig-show-marks").checked) {
    jigSyncMarks(cfg).forEach(([x, y], i) => {
      jCross(cfg.fin_x + x, cfg.fin_y + y, 2.8, "#0057b8", `M${i + 1}`);
    });
  }

  // 试放纸张
  if ($("#jig-trial").checked) drawTrialPaper(cfg, g);
  else $("#jig-drag-info").textContent = "";

  $("#jig-legend").textContent =
    "绿框=角定位槽(两面) 橙框=侧定位槽 蓝虚线=成品区 绿框纸=裁切纸 蓝十字=同步套准标记 红/橙虚线=偏斜与平移最坏包络";
}
Redraw.jig = redrawJig;

/* ---------------- 画布拖动 ---------------- */

function jigMouse(e) {
  const cv = $("#jig-canvas");
  const r = cv.getBoundingClientRect();
  return jMm(e.clientX - r.left, e.clientY - r.top);
}

function hitTarget(x, y) {
  const cfg = JG.config, g = jigGeom(cfg);
  const pad = 2.5;
  if (g.sideRect && pointInRect(x, y, g.sideRect, pad)) return { type: "side" };
  for (let i = 0; i < g.cornerRects.length; i++) {
    if (pointInRect(x, y, g.cornerRects[i], pad)) return { type: "corner" };
  }
  if (pointInRect(x, y, g.block, pad)) return { type: "block" };
  return null;
}

function initJigCanvasDrag() {
  const cv = $("#jig-canvas");
  cv.addEventListener("mousedown", e => {
    const [x, y] = jigMouse(e);
    if ($("#jig-trial").checked) {
      if (!JG.trial) JG.trial = seatPose(JG.config, jigGeom(JG.config));
      JG.dragging = { type: "trial", x, y, rotate: e.altKey,
        dx: JG.trial.dx, dy: JG.trial.dy, drot: JG.trial.drot };
      return;
    }
    const hit = hitTarget(x, y);
    if (!hit) return;
    if (hit.type === "corner" && JG.config.corner.locked) {
      toast("角槽已锁定,请先解除锁定", true);
      return;
    }
    const cfg = JG.config;
    JG.dragging = {
      ...hit, x, y,
      px: cfg.paper_x, py: cfg.paper_y, fx: cfg.fin_x, fy: cfg.fin_y,
      bx: cfg.block_x, by: cfg.block_y,
    };
  });
  window.addEventListener("mousemove", e => {
    const d = JG.dragging;
    if (!d) return;
    const [x, y] = jigMouse(e);
    const cfg = JG.config, g = jigGeom(cfg);
    if (d.type === "trial") {
      if (d.rotate) {
        const [pcx, pcy] = g.cornerPoint;
        const a0 = Math.atan2(d.y - pcy, d.x - pcx);
        const a1 = Math.atan2(y - pcy, x - pcx);
        JG.trial.drot = +(d.drot + (a1 - a0) * 180 / Math.PI).toFixed(2);
      } else {
        JG.trial.dx = +(d.dx + (x - d.x)).toFixed(2);
        JG.trial.dy = +(d.dy + (y - d.y)).toFixed(2);
      }
      redrawJig();
      return;
    }
    if (d.type === "corner") {
      const dx = x - d.x, dy = y - d.y;
      cfg.paper_x = +(d.px + dx).toFixed(1);
      cfg.paper_y = +(d.py + dy).toFixed(1);
      cfg.fin_x = +(d.fx + dx).toFixed(1);
      cfg.fin_y = +(d.fy + dy).toFixed(1);
    } else if (d.type === "block") {
      cfg.block_x = +(d.bx + (x - d.x)).toFixed(1);
      cfg.block_y = +(d.by + (y - d.y)).toFixed(1);
    } else if (d.type === "side") {
      const [pcx, pcy] = g.cornerPoint;
      const tv = g.cornerDef.edges[cfg.side.edge].t;
      let pos = (x - pcx) * tv[0] + (y - pcy) * tv[1];
      const half = +cfg.side.width / 2;
      pos = Math.max(half, Math.min(g.edgeLen - half, pos));
      cfg.side.pos = +pos.toFixed(1);
    }
    redrawJig();
  });
  window.addEventListener("mouseup", () => {
    if (!JG.dragging) return;
    const wasConfigDrag = ["corner", "side", "block"].includes(JG.dragging.type);
    JG.dragging = null;
    if (wasConfigDrag) { renderForms(); scheduleEval(); }
  });
  cv.addEventListener("mousemove", e => {
    if (JG.dragging || $("#jig-trial").checked) return;
    const [x, y] = jigMouse(e);
    cv.style.cursor = hitTarget(x, y) ? "move" : "crosshair";
  });
  $("#jig-trial").addEventListener("change", () => {
    if ($("#jig-trial").checked) JG.trial = seatPose(JG.config, jigGeom(JG.config));
    redrawJig();
  });
  $("#jig-show-envelope").addEventListener("change", redrawJig);
  $("#jig-show-marks").addEventListener("change", redrawJig);
  $("#btn-jig-seat").addEventListener("click", () => {
    JG.trial = seatPose(JG.config, jigGeom(JG.config));
    $("#jig-trial").checked = true;
    redrawJig();
  });
}

/* ---------------- 版本与候选 ---------------- */

async function loadJigList() {
  if (!App.project) return;
  try {
    JG.jigs = await api(`/api/projects/${App.project.id}/jigs`);
  } catch (e) { JG.jigs = []; }
  const sel = $("#jig-select");
  sel.innerHTML = "<option value=''>— 当前草稿(未保存) —</option>" +
    JG.jigs.map(j => `<option value="${j.id}" ${j.id === JG.currentJigId ? "selected" : ""}>
      ${j.adopted ? "★ " : ""}#${j.id} ${j.name} · ${j.created_at}</option>`).join("");
  return JG.jigs;
}

async function saveJigVersion(adoptAfter) {
  if (!JG.config) return;
  const name = prompt("版本名称:", adoptAfter ? `采纳方案 ${new Date().toLocaleString()}` : `定位板 v${JG.jigs.length + 1}`);
  if (name === null) return;
  try {
    let jid = JG.currentJigId;
    if (jid) {
      await api(`/api/jigs/${jid}`, "PUT", { name, config: JG.config });
    } else {
      const j = await api(`/api/projects/${App.project.id}/jigs`, "POST", {
        name, config: JG.config, tolerance: JG.tolerance,
      });
      jid = j.id;
    }
    if (adoptAfter) {
      if (!confirm("采纳后将用本方案的 3 点标记覆盖各色版的套准标记(历史试印记录不变),继续?")) return;
      const res = await api(`/api/jigs/${jid}/adopt`, "POST", {});
      toast(`已采纳并同步 ${res.synced_marks.length} 个标记到各版(试印历史未改)`);
      // openProject 会重新载入各版标记,initJigForProject 自动打开★采纳版本
      await openProject(App.project.id);
      return;
    }
    toast("定位板版本已保存");
    JG.currentJigId = jid;
    JG.metrics = null;
    await loadJigList();
    await doEval();
  } catch (e) { toast(e.message, true); }
}

function renderCandidates() {
  const tb = $("#jig-cand-table tbody");
  tb.innerHTML = "";
  JG.candidates.forEach((c, i) => {
    const tr = document.createElement("tr");
    if (i === 0) tr.className = "best";
    tr.innerHTML = `<td>${i + 1}</td><td>${JG_EDGE_CN[c.side_edge]}</td>
      <td>${c.side_pos}</td><td>${JG_LOAD_CN[c.load_mode]}</td>
      <td style="color:${c.over_count ? "#b00020" : "#31572c"}">${c.over_count}</td>
      <td>${c.max_disp}</td>
      <td><button data-cand="${i}">应用</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll("[data-cand]").forEach(btn => btn.addEventListener("click", () => {
    const c = JG.candidates[+btn.dataset.cand];
    JG.config.side.edge = c.side_edge;
    JG.config.side.pos = c.side_pos;
    JG.config.load_mode = c.load_mode;
    renderForms();
    redrawJig();
    scheduleEval();
    toast(`已应用候选:侧槽${JG_EDGE_CN[c.side_edge]} ${c.side_pos}mm · ${JG_LOAD_CN[c.load_mode]}`);
  }));
}

async function searchJig() {
  try {
    const res = await api(`/api/projects/${App.project.id}/jig-search`, "POST", {
      config: JG.config, tolerance: JG.tolerance,
      step: parseFloat($("#jig-step").value) || 5,
    });
    JG.candidates = res.candidates;
    renderCandidates();
    toast(res.total ? `找到 ${res.total} 个无阻断候选,已按 超限数→最大错位→占板 排序`
                    : "没有无阻断候选,请放宽允许错位或检查槽口问题");
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 1:1 出图 ---------------- */

function pageCanvas(bwMm, bhMm, extraPx) {
  const S = PRINT_DPI;
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(bwMm * S) + 80;
  cv.height = Math.ceil(bhMm * S) + 80 + (extraPx || 0);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.translate(40, 40);
  ctx.scale(S, S);
  return { cv, ctx, S };
}

function drawMmRect(ctx, r, fill, stroke, lw, dash) {
  ctx.beginPath();
  ctx.rect(r[0], r[1], r[2], r[3]);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) {
    ctx.save();
    ctx.strokeStyle = stroke; ctx.lineWidth = lw || 0.3;
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    ctx.restore();
  }
}

function dimH(ctx, x1, x2, y, label) {
  ctx.save();
  ctx.strokeStyle = "#000"; ctx.fillStyle = "#000";
  ctx.lineWidth = 0.15; ctx.font = "3px sans-serif";
  ctx.beginPath();
  ctx.moveTo(x1, y); ctx.lineTo(x2, y);
  ctx.moveTo(x1, y - 1.2); ctx.lineTo(x1, y + 1.2);
  ctx.moveTo(x2, y - 1.2); ctx.lineTo(x2, y + 1.2);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillText(label, (x1 + x2) / 2, y - 1.6);
  ctx.restore();
}
function dimV(ctx, y1, y2, x, label) {
  ctx.save();
  ctx.strokeStyle = "#000"; ctx.fillStyle = "#000";
  ctx.lineWidth = 0.15; ctx.font = "3px sans-serif";
  ctx.beginPath();
  ctx.moveTo(x, y1); ctx.lineTo(x, y2);
  ctx.moveTo(x - 1.2, y1); ctx.lineTo(x + 1.2, y1);
  ctx.moveTo(x - 1.2, y2); ctx.lineTo(x + 1.2, y2);
  ctx.stroke();
  ctx.save();
  ctx.translate(x - 1.8, (y1 + y2) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText(label, 0, 0);
  ctx.restore();
  ctx.restore();
}

function drawScaleBar(ctx, x, y) {
  ctx.save();
  ctx.strokeStyle = "#000"; ctx.fillStyle = "#000";
  ctx.lineWidth = 0.3;
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = i % 2 ? "#fff" : "#000";
    ctx.fillRect(x + i * 10, y, 10, 2);
  }
  ctx.strokeRect(x, y, 100, 2);
  ctx.font = "3px sans-serif";
  ctx.fillStyle = "#000";
  ctx.fillText("100 mm 比例尺(打印后请核对)", x, y + 6);
  ctx.restore();
}

function buildSlotPage() {
  const cfg = JG.config, g = jigGeom(cfg);
  const b = jigBounds();
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const { cv, ctx } = pageCanvas(bw, bh, 0);
  ctx.translate(-b.x0, -b.y0);
  // 台面、木版、成品区
  drawMmRect(ctx, [0, 0, cfg.table_w, cfg.table_h], null, "#8a7f6a", 0.4);
  drawMmRect(ctx, g.block, null, "#7a5a2e", 0.3, [4, 2]);
  drawMmRect(ctx, g.fin, null, "#1565c0", 0.3, [5, 3]);
  // 裁切纸位(实线)
  drawMmRect(ctx, g.paper, null, "#000", 0.5);
  // 槽口:实体黑色
  g.cornerRects.forEach(r => drawMmRect(ctx, r, "#000", "#000", 0.3));
  if (g.sideRect) drawMmRect(ctx, g.sideRect, "#000", "#000", 0.3);
  // 同步标记
  jigSyncMarks(cfg).forEach(([x, y], i) => {
    const bx = cfg.fin_x + x, by = cfg.fin_y + y;
    ctx.save();
    ctx.strokeStyle = "#0057b8"; ctx.lineWidth = 0.25;
    ctx.beginPath();
    ctx.moveTo(bx - 4, by); ctx.lineTo(bx + 4, by);
    ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4);
    ctx.stroke();
    ctx.font = "2.6px sans-serif"; ctx.fillStyle = "#0057b8";
    ctx.fillText(`M${i + 1}`, bx + 4.5, by - 3);
    ctx.restore();
  });
  // 尺寸标注
  const co = cfg.corner, so = cfg.side;
  dimH(ctx, g.paper[0], g.paper[0] + cfg.paper_w, g.paper[1] + cfg.paper_h + 12,
       `裁切纸宽 ${cfg.paper_w}`);
  dimV(ctx, g.paper[1], g.paper[1] + cfg.paper_h, g.paper[0] - 12, `裁切纸高 ${cfg.paper_h}`);
  if (g.sideRect) {
    const [pcx, pcy] = g.cornerPoint;
    const tv = g.cornerDef.edges[so.edge].t;
    const qx = pcx + tv[0] * so.pos, qy = pcy + tv[1] * so.pos;
    ctx.save();
    ctx.strokeStyle = "#bf360c"; ctx.lineWidth = 0.2; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(pcx, pcy); ctx.lineTo(qx, qy); ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = "#bf360c"; ctx.font = "3px sans-serif";
    ctx.fillText(`侧槽距角点 ${so.pos} mm · 槽宽 ${so.width} · 槽深 ${so.depth} · 间隙 ${so.gap}`,
      g.sideRect[0], g.sideRect[1] - 2);
    ctx.restore();
  }
  drawScaleBar(ctx, b.x0 + 4, b.y1 - 6);
  // 标题块(回到像素坐标)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const y0 = cv.height - 34;
  ctx.fillStyle = "#000";
  ctx.font = "bold 15px sans-serif";
  ctx.fillText(`1:1 定位板开槽图 · ${App.project.name} · 角槽${JG_CORNER_CN[co.edge]}(宽${co.width}/深${co.depth}/间隙${co.gap})`,
    40, y0);
  ctx.font = "12px sans-serif";
  const m = JG.metrics;
  const envLine = m
    ? `最大错位 ${m.max_disp}mm · 超限区域 ${m.over_count} · 占板 ${m.footprint.w}×${m.footprint.h}mm · 力臂 ${m.envelope.lever}mm`
    : "";
  ctx.fillText(`侧槽${JG_EDGE_CN[so.edge]} 距角点 ${so.pos}mm(宽${so.width}/深${so.depth}/间隙${so.gap}) · ${envLine}`,
    40, y0 + 18);
  return cv;
}

function buildLoadPage() {
  const cfg = JG.config, g = jigGeom(cfg);
  const b = jigBounds();
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const { cv, ctx } = pageCanvas(bw, bh, 240);
  ctx.translate(-b.x0, -b.y0);
  // 台面与槽口(浅)
  drawMmRect(ctx, [0, 0, cfg.table_w, cfg.table_h], null, "#8a7f6a", 0.4);
  g.cornerRects.forEach(r => drawMmRect(ctx, r, "rgba(46,125,44,0.35)", "#1b5e20", 0.4));
  if (g.sideRect) drawMmRect(ctx, g.sideRect, "rgba(230,81,0,0.3)", "#bf360c", 0.4);
  // 成品区 + 纸张正常位
  drawMmRect(ctx, g.fin, null, "#1565c0", 0.3, [5, 3]);
  drawMmRect(ctx, g.paper, "rgba(51,105,30,0.06)", "#33691e", 0.5);
  // 装纸检查:最坏偏斜包络 + 平移包络
  const env = jigEnvelope(cfg, g);
  const [pcx, pcy] = env.pivot, r = g.paper;
  ctx.save();
  ctx.setLineDash([4, 3]); ctx.lineWidth = 0.3; ctx.strokeStyle = "#d32f2f";
  [env.theta, -env.theta].forEach(a => {
    ctx.beginPath();
    [[r[0], r[1]], [r[0] + r[2], r[1]], [r[0] + r[2], r[1] + r[3]], [r[0], r[1] + r[3]]]
      .forEach(([x, y], i) => {
        const ux = x - pcx, uy = y - pcy, c = Math.cos(a), s = Math.sin(a);
        const qx = pcx + c * ux - s * uy, qy = pcy + s * ux + c * uy;
        i ? ctx.lineTo(qx, qy) : ctx.moveTo(qx, qy);
      });
    ctx.closePath(); ctx.stroke();
  });
  ctx.setLineDash([2, 3]); ctx.strokeStyle = "#e67e22";
  [[env.t, 0], [-env.t, 0], [0, env.t], [0, -env.t]].forEach(([dx, dy]) => {
    drawMmRect(ctx, [r[0] + dx, r[1] + dy, r[2], r[3]], null, "#e67e22", 0.3, [2, 3]);
  });
  ctx.restore();
  // 装纸顺序箭头:从纸外推向角槽
  const edgeNames = Object.keys(g.cornerDef.edges);
  ctx.save();
  ctx.strokeStyle = "#1b5e20"; ctx.fillStyle = "#1b5e20"; ctx.lineWidth = 0.5;
  edgeNames.forEach(en => {
    const e = g.cornerDef.edges[en];
    const ax = pcx + e.n[0] * 26, ay = pcy + e.n[1] * 26;
    const bx2 = pcx + e.n[0] * (cfg.corner.gap + cfg.corner.depth + 3);
    const by2 = pcy + e.n[1] * (cfg.corner.gap + cfg.corner.depth + 3);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx2, by2);
    ctx.lineTo(bx2 + e.t[0] * 2, by2 + e.t[1] * 2);
    ctx.moveTo(bx2, by2); ctx.lineTo(bx2 - e.t[0] * 2, by2 - e.t[1] * 2);
    ctx.stroke();
  });
  ctx.restore();
  drawScaleBar(ctx, b.x0 + 4, b.y1 - 6);
  // 检查清单(像素坐标)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  let y = cv.height - 220;
  ctx.fillStyle = "#000";
  ctx.font = "bold 15px sans-serif";
  ctx.fillText(`装纸检查页 · ${App.project.name} · 角槽${JG_CORNER_CN[cfg.corner.edge]} + 侧槽${JG_EDGE_CN[cfg.side.edge]}@${cfg.side.pos}mm`,
    12, y);
  ctx.font = "12px sans-serif";
  const m = JG.metrics;
  const thetaEff = Math.min(m.envelope.theta_deg, m.envelope.theta_geom_deg);
  const parts = [
    `装纸方向:${JG_LOAD_CN[cfg.load_mode]};先将纸角推到角槽两面同时贴紧,再让纸边靠入侧槽。`,
    `允许错位 ${JG.tolerance} mm;最坏平移 ${m.envelope.t} mm、最坏偏斜 ${thetaEff.toFixed(2)}°(力臂 ${m.envelope.lever} mm)。`,
    `检查①纸面完全覆盖裁切纸框;②两角槽面、侧槽面均贴实无缝隙;③偏斜小于红虚线包络;④四边落在台面内。`,
    `最大错位区域:${m.region_disps.slice(0, 5).map(d => `${d.block_name}-区${d.region} ${d.disp}mm`).join("、") || "—"}。`,
    m.issues.length ? "注意事项:" + m.issues.map(i => i.text).join(";")
                    : "本方案无阻断/警告项。",
    `打印请选 100% 实际大小,勿用「适合页面」;用下方 100mm 比例尺核对。`,
  ];
  ctx.fillStyle = "#000";
  ctx.font = "12px sans-serif";
  parts.forEach(t => { y += 18; ctx.fillText(t, 12, y); });
  return cv;
}


function printCanvas(cv, title) {
  const win = window.open("", "_blank");
  if (!win) { toast("请允许弹出窗口以打印", true); return; }
  win.document.write(`<html><head><title>${title}</title>
    <style>@page{margin:8mm} body{margin:0} img{width:auto;max-width:100%}</style></head>
    <body style="text-align:center"><img src="${cv.toDataURL("image/png")}">
    <script>window.onload=()=>window.print()<\/script></body></html>`);
  win.document.close();
}

/* ---------------- 初始化 ---------------- */

function initJigTab() {
  initJigCanvasDrag();
  $("#jig-select").addEventListener("change", async e => {
    const id = +e.target.value;
    if (!id) return;
    const j = JG.jigs.find(x => x.id === id);
    if (!j) return;
    JG.config = j.config;
    JG.currentJigId = id;
    JG.trial = null;
    renderForms();
    redrawJig();
    scheduleEval();
  });
  $("#btn-jig-save").addEventListener("click", () => saveJigVersion(false));
  $("#btn-jig-adopt").addEventListener("click", () => saveJigVersion(true));
  $("#btn-jig-del").addEventListener("click", async () => {
    if (!JG.currentJigId) { toast("当前是未保存草稿", true); return; }
    if (!confirm("删除该定位板版本?")) return;
    await api(`/api/jigs/${JG.currentJigId}`, "DELETE");
    JG.currentJigId = null;
    JG.config = defaultJigConfig();
    renderForms(); redrawJig(); scheduleEval();
    await loadJigList();
  });
  $("#btn-jig-reset").addEventListener("click", () => {
    JG.config = defaultJigConfig();
    JG.currentJigId = null;
    JG.trial = null;
    renderForms(); redrawJig(); scheduleEval();
  });
  $("#btn-jig-search").addEventListener("click", searchJig);
  $("#btn-jig-slot-page").addEventListener("click", () => {
    if (!JG.config) return;
    printCanvas(buildSlotPage(), "1:1 定位板开槽图");
  });
  $("#btn-jig-load-page").addEventListener("click", () => {
    if (!JG.config) return;
    if (!JG.metrics) { toast("请稍候评估完成", true); return; }
    printCanvas(buildLoadPage(), "装纸检查页");
  });
}

function initJigForProject() {
  JG.currentJigId = null;
  JG.candidates = [];
  JG.trial = null;
  JG.metrics = null;
  JG.tolerance = 1.5;
  $("#jig-cand-table tbody").innerHTML = "";
  if (!App.project) { JG.config = null; return; }
  JG.config = defaultJigConfig();
  renderForms();
  loadJigList().then(() => {
    // 自动打开已采纳版本
    const adopted = JG.jigs.find(j => j.adopted);
    if (adopted) {
      JG.config = adopted.config;
      JG.currentJigId = adopted.id;
      $("#jig-select").value = adopted.id;
      renderForms();
    }
    redrawJig();
    scheduleEval();
  });
}
