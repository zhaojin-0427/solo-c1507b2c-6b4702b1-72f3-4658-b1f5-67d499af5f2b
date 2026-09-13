/* ⑥ 版序优化 + ⑦ 输出 */
"use strict";

/* ---------------- ⑥ 版序优化 ---------------- */

function renderLockTable() {
  const tb = $("#lock-table tbody");
  tb.innerHTML = "";
  blocksSorted().forEach((b, i) => {
    const dryText = { none: "无需等待", before_overprint: "叠印前需干燥", slow: "慢干" }[b.drying_rule];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><span class="swatch-inline" style="background:${b.ink_color}"></span>${b.name}</td>
      <td class="mono">${b.ink_color} · α${b.opacity}</td>
      <td>${dryText}</td>
      <td><input type="checkbox" data-lock-pos="${b.id}" ${b.locked_position ? "checked" : ""}></td>
      <td><input type="checkbox" data-lock-corr="${b.id}" ${b.locked_correction ? "checked" : ""}></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll("[data-lock-pos]").forEach(cb => cb.addEventListener("change", async () => {
    try {
      App.project = await api(`/api/blocks/${cb.dataset.lockPos}`, "PUT", { locked_position: cb.checked });
      renderLockTable();
    } catch (e) { toast(e.message, true); }
  }));
  tb.querySelectorAll("[data-lock-corr]").forEach(cb => cb.addEventListener("change", async () => {
    try {
      App.project = await api(`/api/blocks/${cb.dataset.lockCorr}`, "PUT", { locked_correction: cb.checked });
      renderLockTable();
    } catch (e) { toast(e.message, true); }
  }));
}

async function enumerateOrders() {
  try {
    const res = await api(`/api/projects/${App.project.id}/enumerate`, "POST", {});
    App.candidates = res.candidates;
    renderOrderTable();
    toast(`共枚举 ${res.total} 种版序,按指标排序展示前 ${res.candidates.length} 种`);
  } catch (e) { toast(e.message, true); }
}

function renderOrderTable() {
  const tb = $("#order-table tbody");
  tb.innerHTML = "";
  App.candidates.forEach((c, i) => {
    const tr = document.createElement("tr");
    if (i === 0) tr.className = "best";
    tr.innerHTML = `<td>${i + 1}</td>
      <td>${c.names.join(" → ")}</td>
      <td>${c.color_error}</td><td>${c.ink_changes}</td><td>${c.dry_waits}</td>
      <td><button data-save-plan="${i}">选定并保存</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll("[data-save-plan]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const c = App.candidates[+btn.dataset.savePlan];
      try {
        await api(`/api/projects/${App.project.id}/plans`, "POST", {
          order: c.order,
          metrics: { color_error: c.color_error, ink_changes: c.ink_changes, dry_waits: c.dry_waits },
        });
        // 把选中的版序写回各版 seq
        for (let i = 0; i < c.order.length; i++) {
          App.project = await api(`/api/blocks/${c.order[i]}`, "PUT", { seq: i });
        }
        toast("方案已保存,版序已应用");
        refreshAllPanels();
      } catch (e) { toast(e.message, true); }
    });
  });
}

async function loadPlanList() {
  if (!App.project) return;
  const ul = $("#plan-list");
  ul.innerHTML = "";
  try {
    const rows = await api(`/api/projects/${App.project.id}/plans`);
    rows.forEach(p => {
      const names = p.block_order.map(id => (getBlock(id) || {}).name || `#${id}`).join(" → ");
      const li = document.createElement("li");
      li.innerHTML = `<span>${p.created_at} · ${names}</span>
        <span class="tag">误差${p.metrics.color_error} · 换色${p.metrics.ink_changes} · 待干${p.metrics.dry_waits}
        <button class="danger" data-del-plan="${p.id}">删除</button></span>`;
      ul.appendChild(li);
    });
    if (!rows.length) ul.innerHTML = "<li><span class='tag'>暂无已保存方案</span></li>";
    ul.querySelectorAll("[data-del-plan]").forEach(btn => btn.addEventListener("click", async () => {
      await api(`/api/plans/${btn.dataset.delPlan}`, "DELETE");
      loadPlanList();
    }));
  } catch (e) { toast(e.message, true); }
}

/* ---------------- ⑦ 输出 ---------------- */

const EXPORT_SCALE = 4; // px/mm

function renderTransfer(block) {
  const { w, h } = paperSize();
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(w * EXPORT_SCALE) + 40;
  cv.height = Math.ceil(h * EXPORT_SCALE) + 60;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.save();
  ctx.translate(20, 20);
  // 水平镜像(转印到木版需反向)
  ctx.translate(w * EXPORT_SCALE, 0);
  ctx.scale(-EXPORT_SCALE, EXPORT_SCALE);
  // 纸框
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 0.4;
  ctx.strokeRect(0, 0, w, h);
  // 区域(设计坐标,不含印刷偏移)
  ctx.fillStyle = "#000";
  block.regions.forEach(r => {
    ctx.beginPath();
    r.points.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.closePath();
    ctx.fill();
  });
  // 套准标记
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 0.3;
  block.reg_marks.forEach(m => {
    if (m.x === undefined) return;
    ctx.beginPath();
    ctx.moveTo(m.x - 4, m.y); ctx.lineTo(m.x + 4, m.y);
    ctx.moveTo(m.x, m.y - 4); ctx.lineTo(m.x, m.y + 4);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(m.x, m.y, 2.4, 0, Math.PI * 2); ctx.stroke();
  });
  ctx.restore();
  // 文字标注(不镜像)
  ctx.fillStyle = "#000";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText(`镜像转印图 · ${block.name} · 油墨 ${block.ink_color} · 最小线宽 ${block.min_line_width}mm`, 20, cv.height - 28);
  ctx.font = "12px sans-serif";
  ctx.fillText(`${App.project.name} · 纸面 ${w}×${h}mm · 生成于 ${new Date().toLocaleString()}`, 20, cv.height - 10);
  return cv;
}

function renderTransferList() {
  const box = $("#transfer-list");
  box.innerHTML = "";
  blocksSorted().forEach((b, i) => {
    const row = document.createElement("div");
    row.className = "marks-row";
    row.innerHTML = `<span class="swatch-inline" style="background:${b.ink_color}"></span>
      印次${i + 1} · ${b.name} · ${b.regions.length} 个区域`;
    const btn = document.createElement("button");
    btn.textContent = "下载转印图";
    btn.className = "secondary";
    btn.addEventListener("click", () => downloadCanvas(renderTransfer(b), `转印图_${b.name}.png`));
    row.appendChild(btn);
    box.appendChild(row);
  });
}

function downloadCanvas(cv, filename) {
  const a = document.createElement("a");
  a.download = filename;
  a.href = cv.toDataURL("image/png");
  a.click();
}

function renderCalibrationPage() {
  const { w, h } = paperSize();
  const cv = $("#calib-canvas");
  const S = Math.min(900 / w, 1100 / h);
  cv.width = Math.ceil(w * S) + 40;
  cv.height = Math.ceil(h * S) + 200;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.save();
  ctx.translate(20, 20);
  ctx.scale(S, S);
  // 纸框 + 十字网格(每 50mm)
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 0.4;
  ctx.strokeRect(0, 0, w, h);
  ctx.strokeStyle = "#bbb";
  ctx.lineWidth = 0.15;
  for (let x = 50; x < w; x += 50) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 50; y < h; y += 50) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  // 各版套准标记
  const colors = ["#d32f2f", "#1565c0", "#2e7d32", "#e65100", "#6a1b9a", "#00838f", "#5d4037", "#455a64"];
  blocksSorted().forEach((b, bi) => {
    ctx.strokeStyle = colors[bi % colors.length];
    ctx.lineWidth = 0.35;
    b.reg_marks.forEach((m, i) => {
      if (m.x === undefined) return;
      ctx.beginPath();
      ctx.moveTo(m.x - 5, m.y); ctx.lineTo(m.x + 5, m.y);
      ctx.moveTo(m.x, m.y - 5); ctx.lineTo(m.x, m.y + 5);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(m.x, m.y, 3, 0, Math.PI * 2); ctx.stroke();
    });
  });
  ctx.restore();
  // 文字表
  let y = h * S + 45;
  ctx.fillStyle = "#000";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText(`套准校准页 · ${App.project.name} · 纸面 ${w}×${h}mm (${App.project.orientation === "portrait" ? "竖向" : "横向"})`, 20, y);
  ctx.font = "12px sans-serif";
  y += 20;
  blocksSorted().forEach((b, i) => {
    const mk = b.reg_marks.map((m, k) => `M${k + 1}(${m.x ?? "?"},${m.y ?? "?"})`).join(" ");
    ctx.fillText(
      `印次${i + 1} ${b.name} | 油墨 ${b.ink_color} α${b.opacity} | 偏移 (${b.offset_x},${b.offset_y})mm 旋转 ${b.rotation}° | 标记 ${mk}`,
      20, y);
    y += 16;
  });
  ctx.fillText(`生成时间:${new Date().toLocaleString()} · 打印时请按 100% 比例,勿缩放`, 20, y + 8);
  return cv;
}

function initPlanTab() {
  $("#btn-enumerate").addEventListener("click", enumerateOrders);
}

function initExportTab() {
  $("#btn-all-transfers").addEventListener("click", () => {
    blocksSorted().forEach((b, i) => {
      setTimeout(() => downloadCanvas(renderTransfer(b), `转印图_${i + 1}_${b.name}.png`), i * 300);
    });
  });
  $("#btn-calibration-page").addEventListener("click", () => {
    const cv = renderCalibrationPage();
    const win = window.open("", "_blank");
    if (!win) { toast("请允许弹出窗口以打印", true); return; }
    win.document.write(`<html><head><title>套准校准页</title></head>
      <body style="margin:0;text-align:center">
      <img src="${cv.toDataURL("image/png")}" style="max-width:100%">
      <script>window.onload=()=>window.print()<\/script></body></html>`);
    win.document.close();
  });
}
