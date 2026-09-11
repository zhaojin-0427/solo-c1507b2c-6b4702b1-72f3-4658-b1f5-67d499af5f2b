/* ⑤ 试印校准 */
"use strict";

let trialView = null;
let picking = false;
let pickIdx = 0;

function trialInputs() {
  // 读出表格中的 3 对坐标;返回 {design, measured} 或 null
  const design = [], measured = [];
  for (let m = 0; m < 3; m++) {
    const dx = parseFloat($(`input[data-m="${m}"][data-k="dx"]`).value);
    const dy = parseFloat($(`input[data-m="${m}"][data-k="dy"]`).value);
    const mx = parseFloat($(`input[data-m="${m}"][data-k="mx"]`).value);
    const my = parseFloat($(`input[data-m="${m}"][data-k="my"]`).value);
    design.push([dx, dy]);
    measured.push([mx, my]);
  }
  if (design.some(p => p.some(isNaN))) return { error: "请先填全 3 个设计坐标(或用画布拾取)" };
  if (measured.some(p => p.some(isNaN))) return { error: "请填全 3 个实测坐标" };
  return { design, measured };
}

function setDesignInput(i, x, y) {
  $(`input[data-m="${i}"][data-k="dx"]`).value = x.toFixed(2);
  $(`input[data-m="${i}"][data-k="dy"]`).value = y.toFixed(2);
}

function redrawTrial() {
  const canvas = $("#trial-canvas");
  const wrap = canvas.parentElement;
  trialView = setupCanvas(canvas, wrap.clientWidth - 24, window.innerHeight - 180);
  drawPaper(trialView);
  drawSketch(trialView);
  const b = getBlock(App.currentBlockId);
  if (b) {
    // 设计轮廓(绿实线)
    b.regions.forEach(r => drawPoly(trialView, r.points, null, "#2e7d32", 1.5));
    // 修正后轮廓(红虚线):应用试印修正
    if (App.trialOverlay && App.trialCorr) {
      const c = App.trialCorr;
      b.regions.forEach(r => {
        const pts = r.points.map(p => applyCorr(p[0], p[1], c));
        drawPoly(trialView, pts, null, "#d32f2f", 1.5, [5, 3]);
      });
    }
    // 该版套准标记(设计位置)
    b.reg_marks.forEach((m, i) => {
      if (m.x !== undefined) drawCross(trialView, m.x, m.y, 3, "#0057b8", `M${i + 1}`);
    });
  }
  // 表格中已填的设计点(蓝)与实测点(红)
  for (let i = 0; i < 3; i++) {
    const dx = parseFloat($(`input[data-m="${i}"][data-k="dx"]`)?.value);
    const dy = parseFloat($(`input[data-m="${i}"][data-k="dy"]`)?.value);
    const mx = parseFloat($(`input[data-m="${i}"][data-k="mx"]`)?.value);
    const my = parseFloat($(`input[data-m="${i}"][data-k="my"]`)?.value);
    if (!isNaN(dx) && !isNaN(dy)) drawCross(trialView, dx, dy, 2.5, "#1565c0", `设${i + 1}`);
    if (!isNaN(mx) && !isNaN(my)) drawCross(trialView, mx, my, 2.5, "#c62828", `测${i + 1}`);
  }
  if (picking) {
    const ctx = trialView.ctx;
    ctx.save();
    ctx.fillStyle = "#c62828";
    ctx.font = "bold 14px sans-serif";
    ctx.fillText(`拾取模式:请点击第 ${pickIdx + 1} 个标记的设计位置`, 12, 20);
    ctx.restore();
  }
  if (App.trialOverlay && App.trialCorr) {
    const ctx = trialView.ctx;
    ctx.save();
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#2e7d32";
    ctx.fillText("—— 设计轮廓(修正后目标)", 12, 20);
    ctx.fillStyle = "#d32f2f";
    ctx.fillText("- - 实测偏差轮廓(修正前)", 12, 36);
    ctx.restore();
  }
}
Redraw.trial = redrawTrial;

/* 与后端一致的相似变换(用于前端叠加显示) */
function applyCorr(x, y, c) {
  const a = c.rot_deg * Math.PI / 180;
  const cs = c.scale * Math.cos(a), sn = c.scale * Math.sin(a);
  return [cs * x - sn * y + c.tx, sn * x + cs * y + c.ty];
}

async function solveTrial() {
  const t = trialInputs();
  if (t.error) { toast(t.error, true); return; }
  try {
    const rec = await api(`/api/blocks/${App.currentBlockId}/trials`, "POST", t);
    App.trialCorr = rec.correction;
    showTrialResult(rec.correction);
    loadTrialList();
    toast("修正已解算并存档");
  } catch (e) { toast(e.message, true); }
}

function showTrialResult(c) {
  const el = $("#trial-result");
  el.style.display = "block";
  el.innerHTML = `<b>实测偏差</b> —— 平移 (${c.tx.toFixed(2)}, ${c.ty.toFixed(2)}) mm ·
    旋转 ${c.rot_deg.toFixed(3)}° · 缩放 ${(c.scale * 100).toFixed(2)}% ·
    残差 RMS ${c.rms_error.toFixed(3)} mm<br>
    <span class="tag">「应用修正」将按<b>逆变换</b>抵消该偏差(缩放仅提示,物理版无法缩放)。</span>` +
    (Math.abs(c.scale - 1) > 0.005
      ? `<br><span style="color:#b00020">⚠ 缩放偏差超过 0.5%,可能是纸张伸缩或测量误差,建议重印试样。</span>` : "");
}

async function applyCorrection() {
  const b = getBlock(App.currentBlockId);
  if (!b) return;
  if (!App.trialCorr) { toast("请先解算修正", true); return; }
  if (b.locked_correction) { toast("该版修正已锁定,请先解除锁定", true); return; }
  // trialCorr 是「设计→实测」的误差变换 T(p)=s·R(θ)p+t;要抵消它,色版新变换
  // 必须是 T⁻¹∘旧变换。色版变换为 绕纸心旋转β后平移d,即 p→R(β)p+u,
  // 其中 u = c − R(β)c + d。精确合成:
  //   β' = β − θ,  u' = (1/s)·R(−θ)·(u − t),  再解回 d'。
  // 物理版无法缩放,旋转部分不带 1/s(缩放偏差已在结果中提示)。
  const c = App.trialCorr;
  const { w, h } = paperSize();
  const cx = w / 2, cy = h / 2;
  const th = c.rot_deg * Math.PI / 180;
  const invS = 1 / (c.scale || 1);
  const b0 = b.rotation * Math.PI / 180;
  const ux = cx - (Math.cos(b0) * cx - Math.sin(b0) * cy) + b.offset_x;
  const uy = cy - (Math.sin(b0) * cx + Math.cos(b0) * cy) + b.offset_y;
  const vx = ux - c.tx, vy = uy - c.ty;
  const unx = invS * (Math.cos(th) * vx + Math.sin(th) * vy);
  const uny = invS * (-Math.sin(th) * vx + Math.cos(th) * vy);
  const bn = (b.rotation - c.rot_deg) * Math.PI / 180;
  b.offset_x = +(unx - cx + (Math.cos(bn) * cx - Math.sin(bn) * cy)).toFixed(2);
  b.offset_y = +(uny - cy + (Math.sin(bn) * cx + Math.cos(bn) * cy)).toFixed(2);
  b.rotation = +(b.rotation - c.rot_deg).toFixed(3);
  try {
    App.project = await api(`/api/blocks/${b.id}`, "PUT", {
      offset_x: b.offset_x, offset_y: b.offset_y, rotation: b.rotation,
    });
    toast(`已按逆变换抵消偏差:偏移 (${b.offset_x}, ${b.offset_y}) mm,旋转 ${b.rotation}°`);
    refreshAllPanels();
  } catch (e) { toast(e.message, true); }
}

async function loadTrialList() {
  if (!App.project) return;
  const ul = $("#trial-list");
  ul.innerHTML = "";
  try {
    const rows = await api(`/api/projects/${App.project.id}/trials`);
    rows.forEach(r => {
      const li = document.createElement("li");
      li.innerHTML = `<span>[${r.block_name}] ${r.created_at}</span>
        <span class="tag mono">Δ(${r.correction.tx.toFixed(2)},${r.correction.ty.toFixed(2)})
        ${r.correction.rot_deg.toFixed(2)}° ×${r.correction.scale.toFixed(3)}</span>`;
      li.addEventListener("click", () => {
        App.trialCorr = r.correction;
        showTrialResult(r.correction);
        for (let i = 0; i < 3; i++) {
          setDesignInput(i, r.design[i][0], r.design[i][1]);
          $(`input[data-m="${i}"][data-k="mx"]`).value = r.measured[i][0].toFixed(2);
          $(`input[data-m="${i}"][data-k="my"]`).value = r.measured[i][1].toFixed(2);
        }
        redrawTrial();
      });
      ul.appendChild(li);
    });
    if (!rows.length) ul.innerHTML = "<li><span class='tag'>暂无试印记录</span></li>";
  } catch (e) { toast(e.message, true); }
}

function initTrialTab() {
  $("#trial-block-select").addEventListener("change", e => {
    App.currentBlockId = +e.target.value;
    const b = getBlock(App.currentBlockId);
    // 预填该版已保存的套准标记作为设计坐标
    if (b && b.reg_marks.length === 3) {
      b.reg_marks.forEach((m, i) => { if (m.x !== undefined) setDesignInput(i, m.x, m.y); });
    }
    redrawTrial();
  });
  $("#btn-pick-design").addEventListener("click", () => {
    picking = true; pickIdx = 0;
    toast("拾取模式:在画布上依次点击 3 个标记的设计位置");
    redrawTrial();
  });
  $("#trial-canvas").addEventListener("click", e => {
    if (!picking) return;
    const [x, y] = canvasMm($("#trial-canvas"), trialView, e);
    setDesignInput(pickIdx, x, y);
    pickIdx++;
    if (pickIdx >= 3) { picking = false; toast("3 个设计坐标已拾取"); }
    redrawTrial();
  });
  // 表格改动即时重绘
  $$("#trial-table input").forEach(inp => inp.addEventListener("input", redrawTrial));
  $("#btn-solve-trial").addEventListener("click", solveTrial);
  $("#btn-apply-corr").addEventListener("click", applyCorrection);
  $("#btn-toggle-overlay").addEventListener("click", () => {
    App.trialOverlay = !App.trialOverlay;
    $("#btn-toggle-overlay").textContent = App.trialOverlay ? "隐藏修正轮廓" : "叠加修正前后轮廓";
    redrawTrial();
  });
}
