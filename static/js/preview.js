/* ③ 合成预览与检测 + ④ 套准模拟 */
"use strict";

let previewView = null;
let issueLayer = null;   // 问题高亮小画布(分析分辨率)

function redrawPreview() {
  const canvas = $("#preview-canvas");
  const wrap = canvas.parentElement;
  previewView = setupCanvas(canvas, wrap.clientWidth - 24, window.innerHeight - 180);
  drawPaper(previewView);
  if ($("#pv-show-sketch").checked) drawSketch(previewView);
  // 按版序合成
  blocksSorted().forEach(b => {
    const ctx = previewView.ctx;
    ctx.save();
    ctx.globalAlpha = b.opacity;
    b.regions.forEach(r => drawPoly(previewView, transformedPoints(r, b), b.ink_color, null));
    ctx.restore();
  });
  // 套准标记
  blocksSorted().forEach(b => b.reg_marks.forEach((m, i) => {
    if (m.x !== undefined) drawCross(previewView, m.x, m.y, 2.5, "#0057b8", null);
  }));
  if ($("#pv-show-issues").checked && issueLayer) {
    const { ctx } = previewView;
    const [x0, y0] = mmToPx(previewView, 0, 0);
    const [x1, y1] = mmToPx(previewView, paperSize().w, paperSize().h);
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(issueLayer, x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }
}
Redraw.preview = redrawPreview;

/* ---------------- 检测 ---------------- */

const ANALYSIS_SCALE = 1.2; // px/mm

function runDetection() {
  const { w: PW, h: PH } = paperSize();
  const W = Math.round(PW * ANALYSIS_SCALE), H = Math.round(PH * ANALYSIS_SCALE);
  const N = W * H;
  const blocks = blocksSorted();
  const issues = [];

  // 每版栅格化掩码(含当前偏移/旋转)
  const masks = blocks.map(b => {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    c.fillStyle = "#000";
    b.regions.forEach(r => {
      c.beginPath();
      transformedPoints(r, b).forEach((p, i) => {
        const px = p[0] * ANALYSIS_SCALE, py = p[1] * ANALYSIS_SCALE;
        i ? c.lineTo(px, py) : c.moveTo(px, py);
      });
      c.closePath(); c.fill();
    });
    const d = c.getImageData(0, 0, W, H).data;
    const m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = d[i * 4 + 3] > 0 ? 1 : 0;
    return m;
  });

  // 期望覆盖(设计坐标、无偏移)
  const expected = new Uint8Array(N);
  blocks.forEach(b => b.regions.forEach(r => {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    c.fillStyle = "#000";
    c.beginPath();
    r.points.forEach((p, i) => {
      const px = p[0] * ANALYSIS_SCALE, py = p[1] * ANALYSIS_SCALE;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    });
    c.closePath(); c.fill();
    const d = c.getImageData(0, 0, W, H).data;
    for (let i = 0; i < N; i++) if (d[i * 4 + 3] > 0) expected[i] = 1;
  }));

  // 合成颜色 + 覆盖计数
  const comp = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { comp[i*3] = comp[i*3+1] = comp[i*3+2] = 255; }
  const coverCount = new Uint8Array(N);
  const actual = new Uint8Array(N);
  blocks.forEach((b, bi) => {
    const ink = hexToRgb(b.ink_color), a = b.opacity;
    const m = masks[bi];
    for (let i = 0; i < N; i++) {
      if (!m[i]) continue;
      coverCount[i]++; actual[i] = 1;
      comp[i*3]   = a * ink[0] + (1 - a) * comp[i*3];
      comp[i*3+1] = a * ink[1] + (1 - a) * comp[i*3+1];
      comp[i*3+2] = a * ink[2] + (1 - a) * comp[i*3+2];
    }
  });

  // 高亮层
  const hl = document.createElement("canvas");
  hl.width = W; hl.height = H;
  const hctx = hl.getContext("2d");
  const himg = hctx.createImageData(W, H);
  const hp = himg.data;
  const mark = (i, r, g, b) => { hp[i*4] = r; hp[i*4+1] = g; hp[i*4+2] = b; hp[i*4+3] = 230; };

  // ① 露白:期望有墨但实际无墨
  let gapCount = 0;
  for (let i = 0; i < N; i++) {
    if (expected[i] && !actual[i]) { gapCount++; mark(i, 255, 90, 0); }
  }
  const mm2 = 1 / (ANALYSIS_SCALE * ANALYSIS_SCALE);
  if (gapCount) issues.push({
    type: "gap", text: `露白:约 ${(gapCount * mm2).toFixed(1)} mm² 应有墨色处露出纸面(色版偏移或区域缺失)`,
  });

  // ② 非预期叠色:≥2 版覆盖且混合色与所有相关目标色都偏差过大
  let overCount = 0;
  const TH = 60;
  for (let i = 0; i < N; i++) {
    if (coverCount[i] < 2) continue;
    const finalHex = rgbToHex(comp[i*3], comp[i*3+1], comp[i*3+2]);
    let minD = Infinity;
    blocks.forEach((b, bi) => {
      if (!masks[bi][i]) return;
      minD = Math.min(minD, colorDist(finalHex, b.target_color));
      b.regions.forEach(r => { if (r.target_color) minD = Math.min(minD, colorDist(finalHex, r.target_color)); });
    });
    if (minD > TH) { overCount++; mark(i, 150, 40, 200); }
  }
  if (overCount) issues.push({
    type: "overprint", text: `非预期叠色:约 ${(overCount * mm2).toFixed(1)} mm² 叠印结果与任一目标色均不符`,
  });

  // ③ 过窄线条:开运算后消失的部分
  blocks.forEach((b, bi) => {
    const r = Math.max(1, Math.round(b.min_line_width / 2 * ANALYSIS_SCALE));
    const opened = morphOpen(masks[bi], W, H, r);
    let cnt = 0;
    for (let i = 0; i < N; i++) {
      if (masks[bi][i] && !opened[i]) { cnt++; mark(i, 220, 0, 40); }
    }
    if (cnt) issues.push({
      type: "narrow",
      text: `过窄线条:「${b.name}」约 ${(cnt * mm2).toFixed(1)} mm² 细于最小可刻线宽 ${b.min_line_width} mm`,
    });
  });

  // ④ 越出纸面
  blocks.forEach(b => b.regions.forEach((r, ri) => {
    const pts = transformedPoints(r, b);
    const out = pts.filter(p => p[0] < 0 || p[1] < 0 || p[0] > PW || p[1] > PH);
    if (out.length) issues.push({
      type: "outside",
      text: `越出纸面:「${b.name}」区域${ri + 1} 有 ${out.length}/${pts.length} 个顶点在纸面外`,
    });
  }));

  hctx.putImageData(himg, 0, 0);
  issueLayer = hl;
  App.issues = issues;
  renderIssues();
  redrawPreview();
  if (!issues.length) toast("未发现问题");
}

function morphOpen(mask, W, H, r) {
  let cur = mask;
  for (let k = 0; k < r; k++) cur = morphStep(cur, W, H, false);
  for (let k = 0; k < r; k++) cur = morphStep(cur, W, H, true);
  return cur;
}
function morphStep(src, W, H, dilate) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (dilate) {
        out[i] = (src[i] ||
          (x > 0 && src[i-1]) || (x < W-1 && src[i+1]) ||
          (y > 0 && src[i-W]) || (y < H-1 && src[i+W])) ? 1 : 0;
      } else {
        out[i] = (src[i] &&
          (x > 0 && src[i-1]) && (x < W-1 && src[i+1]) &&
          (y > 0 && src[i-W]) && (y < H-1 && src[i+W])) ? 1 : 0;
      }
    }
  }
  return out;
}

function renderIssues() {
  const ul = $("#issue-list");
  ul.innerHTML = "";
  if (!App.issues.length) {
    ul.innerHTML = "<li><span class='tag'>点击「运行检测」分析露白 / 叠色 / 窄线 / 越界</span></li>";
    return;
  }
  App.issues.forEach(it => {
    const li = document.createElement("li");
    li.className = "issue-" + it.type;
    li.innerHTML = `<span>${it.text}</span>`;
    ul.appendChild(li);
  });
}

/* ---------------- ④ 套准模拟 ---------------- */

let regView = null;
let dragState = null;

function redrawRegister() {
  const canvas = $("#register-canvas");
  const wrap = canvas.parentElement;
  regView = setupCanvas(canvas, wrap.clientWidth - 24, window.innerHeight - 180);
  drawPaper(regView);
  drawSketch(regView);
  blocksSorted().forEach(b => {
    const sel = b.id === App.currentBlockId;
    b.regions.forEach(r => {
      drawPoly(regView, transformedPoints(r, b),
        sel ? b.ink_color + "88" : b.ink_color + "33",
        sel ? "#e0007a" : "#888", sel ? 2 : 1);
    });
    b.reg_marks.forEach((m, i) => {
      if (m.x === undefined) return;
      const [tx, ty] = applyBlockTransform(m.x, m.y, b);
      drawCross(regView, tx, ty, 3, sel ? "#e0007a" : "#0057b8", sel ? `${b.name}-${i+1}` : null);
    });
  });
  renderMisregTable();
}
Redraw.register = redrawRegister;

function renderMisregTable() {
  const tb = $("#misreg-table tbody");
  tb.innerHTML = "";
  blocksSorted().forEach(b => {
    b.regions.forEach((r, ri) => {
      const d = regionMaxDisplacement(r, b);
      const tr = document.createElement("tr");
      if (d > 0.5) tr.style.color = "#b00020";
      tr.innerHTML = `<td>区域 ${ri + 1}</td><td>${b.name}</td><td>${d.toFixed(2)}</td>`;
      tb.appendChild(tr);
    });
  });
}

function syncRegInputs() {
  const b = getBlock(App.currentBlockId);
  if (!b) return;
  $("#reg-dx").value = b.offset_x;
  $("#reg-dy").value = b.offset_y;
  $("#reg-rot").value = b.rotation;
}

async function saveBlockTransform(b) {
  try {
    App.project = await api(`/api/blocks/${b.id}`, "PUT", {
      offset_x: +b.offset_x.toFixed(2), offset_y: +b.offset_y.toFixed(2),
      rotation: +b.rotation.toFixed(2),
    });
    refreshAllPanels();
  } catch (e) { toast(e.message, true); }
}

function initRegisterTab() {
  const canvas = $("#register-canvas");
  $("#reg-block-select").addEventListener("change", e => {
    App.currentBlockId = +e.target.value;
    syncRegInputs();
    redrawRegister();
  });
  ["#reg-dx", "#reg-dy", "#reg-rot"].forEach(sel => {
    $(sel).addEventListener("change", () => {
      const b = getBlock(App.currentBlockId);
      if (!b) return;
      b.offset_x = parseFloat($("#reg-dx").value) || 0;
      b.offset_y = parseFloat($("#reg-dy").value) || 0;
      b.rotation = parseFloat($("#reg-rot").value) || 0;
      redrawRegister();
      saveBlockTransform(b);
    });
  });
  $("#btn-reset-offset").addEventListener("click", () => {
    const b = getBlock(App.currentBlockId);
    if (!b) return;
    b.offset_x = b.offset_y = b.rotation = 0;
    syncRegInputs();
    redrawRegister();
    saveBlockTransform(b);
  });

  canvas.addEventListener("mousedown", e => {
    const b = getBlock(App.currentBlockId);
    if (!b) return;
    const [x, y] = canvasMm(canvas, regView, e);
    dragState = { x, y, ox: b.offset_x, oy: b.offset_y, rot: b.rotation, rotate: e.altKey };
  });
  window.addEventListener("mousemove", e => {
    if (!dragState) return;
    const b = getBlock(App.currentBlockId);
    const [x, y] = canvasMm(canvas, regView, e);
    if (dragState.rotate) {
      // Alt+拖动:绕纸面中心旋转,角度 = 拖动弧角差
      const { w, h } = paperSize();
      const cx = w / 2, cy = h / 2;
      const a0 = Math.atan2(dragState.y - cy, dragState.x - cx);
      const a1 = Math.atan2(y - cy, x - cx);
      b.rotation = dragState.rot + (a1 - a0) * 180 / Math.PI;
    } else {
      b.offset_x = dragState.ox + (x - dragState.x);
      b.offset_y = dragState.oy + (y - dragState.y);
    }
    syncRegInputs();
    redrawRegister();
  });
  window.addEventListener("mouseup", () => {
    if (!dragState) return;
    dragState = null;
    const b = getBlock(App.currentBlockId);
    if (b) saveBlockTransform(b);
  });
}

function initPreviewTab() {
  $("#btn-run-detect").addEventListener("click", runDetection);
  $("#pv-show-sketch").addEventListener("change", redrawPreview);
  $("#pv-show-issues").addEventListener("change", redrawPreview);
}
