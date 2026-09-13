/* 公共:全局状态、API、几何与画布工具 */
"use strict";

const App = {
  project: null,          // 当前项目(含 blocks[].regions[])
  sketchImg: null,        // 底稿 Image
  sketchOpacity: 0.35,
  currentBlockId: null,   // 编辑/模拟/试印当前选中的版
  selectedRegionId: null, // 勾勒页选中的区域
  draft: [],              // 勾勒中的多边形草稿(mm 坐标)
  issues: [],             // 检测结果
  trialCorr: null,        // 最近一次试印解算的修正
  trialOverlay: false,    // 是否叠加修正前后轮廓
  candidates: [],         // 版序枚举结果
};

/* ---------------- 工具 ---------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, method = "GET", body) {
  const opt = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(path, opt);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).description || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

function toast(msg, isErr) {
  let el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText = `position:fixed;top:12px;left:50%;transform:translateX(-50%);
    background:${isErr ? "#b00020" : "#31572c"};color:#fff;padding:8px 18px;
    border-radius:6px;z-index:99;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.3)`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function hexToRgb(h) {
  h = (h || "#000000").replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + c(r) + c(g) + c(b);
}
function colorDist(h1, h2) {
  const a = hexToRgb(h1), b = hexToRgb(h2);
  return Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
}
function mixColor(below, ink, alpha) {
  const a = hexToRgb(below), b = hexToRgb(ink);
  return rgbToHex(alpha*b[0]+(1-alpha)*a[0], alpha*b[1]+(1-alpha)*a[1], alpha*b[2]+(1-alpha)*a[2]);
}

/* ---------------- 几何 ---------------- */

function paperSize() {
  const p = App.project;
  let w = p.paper_w, h = p.paper_h;
  if (p.orientation === "landscape") [w, h] = [h, w];
  return { w, h };
}

/* 色版当前变换:绕纸面中心旋转后平移 */
function applyBlockTransform(x, y, block) {
  const { w, h } = paperSize();
  const cx = w / 2, cy = h / 2;
  const a = block.rotation * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const rx = x - cx, ry = y - cy;
  return [cx + c*rx - s*ry + block.offset_x, cy + s*rx + c*ry + block.offset_y];
}
function transformedPoints(region, block) {
  return region.points.map(p => applyBlockTransform(p[0], p[1], block));
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyCentroid(pts) {
  let x = 0, y = 0;
  pts.forEach(p => { x += p[0]; y += p[1]; });
  return [x / pts.length, y / pts.length];
}

/* 区域在色版当前偏移下,顶点的最大位移(mm) */
function regionMaxDisplacement(region, block) {
  let m = 0;
  for (const [x, y] of region.points) {
    const [tx, ty] = applyBlockTransform(x, y, block);
    m = Math.max(m, Math.hypot(tx - x, ty - y));
  }
  return m;
}

/* ---------------- 画布 ---------------- */

/* 在指定 canvas 上建立 mm→px 的坐标系;返回 {ctx, scale, ox, oy}
   容器不可见(页签隐藏)时 clientWidth 为 0,须给尺寸下限,
   否则负缩放会让 canvas.width 赋负值抛异常、中断全部重绘。 */
function setupCanvas(canvas, maxW, maxH) {
  const { w, h } = paperSize();
  maxW = Math.max(120, maxW || 0);
  maxH = Math.max(120, maxH || 0);
  const scale = Math.min(maxW / w, maxH / h);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.ceil(w * scale * dpr) + 2);
  canvas.height = Math.max(1, Math.ceil(h * scale * dpr) + 2);
  canvas.style.width = Math.ceil(w * scale) + "px";
  canvas.style.height = Math.ceil(h * scale) + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ox = 1, oy = 1;
  return { ctx, scale, ox, oy };
}
function mmToPx(view, x, y) { return [view.ox + x * view.scale, view.oy + y * view.scale]; }
function pxToMm(view, px, py) { return [(px - view.ox) / view.scale, (py - view.oy) / view.scale]; }

function drawPaper(view) {
  const { ctx } = view;
  const { w, h } = paperSize();
  const [x0, y0] = mmToPx(view, 0, 0);
  const [x1, y1] = mmToPx(view, w, h);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.strokeStyle = "#444";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

function drawSketch(view) {
  if (!App.sketchImg) return;
  const { ctx } = view;
  const { w, h } = paperSize();
  const [x0, y0] = mmToPx(view, 0, 0);
  const [x1, y1] = mmToPx(view, w, h);
  ctx.save();
  ctx.globalAlpha = App.sketchOpacity;
  ctx.drawImage(App.sketchImg, x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}

function drawPoly(view, pts, fill, stroke, lineWidth, dash) {
  const { ctx } = view;
  ctx.save();
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [px, py] = mmToPx(view, p[0], p[1]);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth || 1;
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCross(view, x, y, sizeMm, color, label) {
  const { ctx } = view;
  const [px, py] = mmToPx(view, x, y);
  const s = sizeMm * view.scale;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(px - s, py); ctx.lineTo(px + s, py);
  ctx.moveTo(px, py - s); ctx.lineTo(px, py + s);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px, py, s * 0.6, 0, Math.PI * 2);
  ctx.stroke();
  if (label) {
    ctx.fillStyle = color;
    ctx.font = "11px sans-serif";
    ctx.fillText(label, px + s + 2, py - 2);
  }
  ctx.restore();
}

function blocksSorted() {
  return [...App.project.blocks].sort((a, b) => a.seq - b.seq || a.id - b.id);
}
function getBlock(id) {
  return App.project.blocks.find(b => b.id === id);
}

/* 画布鼠标事件 → mm 坐标 */
function canvasMm(canvas, view, evt) {
  const r = canvas.getBoundingClientRect();
  return pxToMm(view, evt.clientX - r.left, evt.clientY - r.top);
}

/* 刷新所有画布;单个画布出错(如隐藏页签尺寸异常)不影响其余 */
const Redraw = {};
function redrawAll() {
  Object.entries(Redraw).forEach(([name, fn]) => {
    try { fn(); } catch (e) { console.error(`重绘 ${name} 失败:`, e); }
  });
}
