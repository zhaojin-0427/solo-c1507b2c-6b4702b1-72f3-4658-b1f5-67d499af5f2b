/* ① 项目与色版设置 + ② 区域勾勒 */
"use strict";

/* ---------------- ① 设置页 ---------------- */

function fillSetupForm() {
  const p = App.project;
  $("#proj-name").value = p.name;
  $("#proj-pw").value = p.paper_w;
  $("#proj-ph").value = p.paper_h;
  $("#proj-orient").value = p.orientation;
  renderBlockCards();
}

async function saveProjectSettings() {
  try {
    App.project = await api(`/api/projects/${App.project.id}`, "PUT", {
      name: $("#proj-name").value.trim() || "未命名画稿",
      paper_w: parseFloat($("#proj-pw").value) || 210,
      paper_h: parseFloat($("#proj-ph").value) || 297,
      orientation: $("#proj-orient").value,
    });
    toast("项目设置已保存");
    refreshAllPanels();
  } catch (e) { toast(e.message, true); }
}

function renderBlockCards() {
  const box = $("#block-list");
  box.innerHTML = "";
  blocksSorted().forEach((b, i) => {
    const card = document.createElement("div");
    card.className = "block-card";
    card.innerHTML = `
      <div class="head">
        <span class="swatch" style="background:${b.ink_color}"></span>
        <b>印次 ${i + 1} · ${b.name}</b>
        <button class="danger" data-del="${b.id}">删除</button>
      </div>
      <div class="grid">
        <label>版名 <input data-bid="${b.id}" data-f="name" value="${b.name}"></label>
        <label>油墨颜色 <input type="color" data-bid="${b.id}" data-f="ink_color" value="${b.ink_color}"></label>
        <label>透明度 <input type="number" min="0.05" max="1" step="0.05" data-bid="${b.id}" data-f="opacity" value="${b.opacity}"></label>
        <label>区域目标色 <input type="color" data-bid="${b.id}" data-f="target_color" value="${b.target_color}"></label>
        <label>最小可刻线宽 (mm) <input type="number" min="0.2" step="0.1" data-bid="${b.id}" data-f="min_line_width" value="${b.min_line_width}"></label>
        <label>干燥规则
          <select data-bid="${b.id}" data-f="drying_rule">
            <option value="none" ${b.drying_rule === "none" ? "selected" : ""}>无需等待</option>
            <option value="before_overprint" ${b.drying_rule === "before_overprint" ? "selected" : ""}>叠印前需干燥</option>
            <option value="slow" ${b.drying_rule === "slow" ? "selected" : ""}>慢干(印后必等)</option>
          </select>
        </label>
      </div>
      <div class="grid"><label>套准标记(3 个, mm)</label></div>
      <div class="marks" data-marks="${b.id}"></div>
      <div class="locks">
        <label><input type="checkbox" data-bid="${b.id}" data-f="locked_position" ${b.locked_position ? "checked" : ""}> 锁定印次</label>
        <label><input type="checkbox" data-bid="${b.id}" data-f="locked_correction" ${b.locked_correction ? "checked" : ""}> 锁定修正</label>
      </div>`;
    box.appendChild(card);
    renderMarksEditor(card, b);
  });

  box.querySelectorAll("input[data-f], select[data-f]").forEach(el => {
    el.addEventListener("change", async () => {
      const bid = +el.dataset.bid, f = el.dataset.f;
      let v = el.type === "checkbox" ? el.checked
            : el.type === "number" ? parseFloat(el.value) : el.value;
      try {
        App.project = await api(`/api/blocks/${bid}`, "PUT", { [f]: v });
        refreshAllPanels();
      } catch (e) { toast(e.message, true); }
    });
  });
  box.querySelectorAll("button[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("删除该色版及其全部区域?")) return;
      try {
        App.project = await api(`/api/blocks/${btn.dataset.del}`, "DELETE");
        refreshAllPanels();
      } catch (e) { toast(e.message, true); }
    });
  });
}

function renderMarksEditor(card, b) {
  const holder = card.querySelector(`[data-marks="${b.id}"]`);
  const marks = b.reg_marks.length ? b.reg_marks : [{}, {}, {}];
  for (let i = 0; i < 3; i++) {
    const m = marks[i] || {};
    const row = document.createElement("div");
    row.className = "marks-row";
    row.innerHTML = `标记${i + 1}
      X <input type="number" step="0.1" data-mark-x="${i}" value="${m.x ?? ""}">
      Y <input type="number" step="0.1" data-mark-y="${i}" value="${m.y ?? ""}">`;
    holder.appendChild(row);
  }
  const save = document.createElement("button");
  save.textContent = "保存标记";
  save.className = "secondary";
  save.addEventListener("click", async () => {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const x = parseFloat(holder.querySelector(`[data-mark-x="${i}"]`).value);
      const y = parseFloat(holder.querySelector(`[data-mark-y="${i}"]`).value);
      if (isNaN(x) || isNaN(y)) { toast(`标记${i + 1} 坐标不完整`, true); return; }
      out.push({ x, y });
    }
    try {
      App.project = await api(`/api/blocks/${b.id}`, "PUT", { reg_marks: out });
      toast("套准标记已保存");
      refreshAllPanels();
    } catch (e) { toast(e.message, true); }
  });
  holder.appendChild(save);
}

/* ---------------- ② 勾勒页 ---------------- */

let drawView = null;

function drawBlockOptions(sel) {
  sel.innerHTML = "";
  blocksSorted().forEach((b, i) => {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = `印次${i + 1} · ${b.name}`;
    sel.appendChild(o);
  });
  if (App.currentBlockId && getBlock(App.currentBlockId)) sel.value = App.currentBlockId;
  App.currentBlockId = +sel.value;
}

function redrawDraw() {
  const canvas = $("#draw-canvas");
  const wrap = canvas.parentElement;
  drawView = setupCanvas(canvas, wrap.clientWidth - 24, window.innerHeight - 180);
  drawPaper(drawView);
  drawSketch(drawView);
  // 其它版的区域(淡显)
  blocksSorted().forEach(b => {
    b.regions.forEach(r => {
      const pts = transformedPoints(r, b);
      if (b.id === App.currentBlockId) {
        drawPoly(drawView, pts, b.ink_color + "55", b.ink_color, 1.5);
      } else {
        drawPoly(drawView, pts, null, "#999", 1, [4, 3]);
      }
      if (r.id === App.selectedRegionId) {
        drawPoly(drawView, pts, null, "#e0007a", 2.5);
      }
    });
    // 套准标记
    b.reg_marks.forEach((m, i) => {
      if (m.x !== undefined) drawCross(drawView, m.x, m.y, 3, "#0057b8", `${b.name}-${i + 1}`);
    });
  });
  // 草稿
  if (App.draft.length) {
    const ctx = drawView.ctx;
    ctx.save();
    ctx.strokeStyle = "#e0007a";
    ctx.fillStyle = "#e0007a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    App.draft.forEach((p, i) => {
      const [px, py] = mmToPx(drawView, p[0], p[1]);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      ctx.fillRect(px - 2, py - 2, 4, 4);
    });
    ctx.stroke();
    ctx.restore();
  }
}
Redraw.draw = redrawDraw;

function renderRegionList() {
  const ul = $("#region-list");
  ul.innerHTML = "";
  const b = getBlock(App.currentBlockId);
  if (!b) return;
  b.regions.forEach((r, i) => {
    const li = document.createElement("li");
    if (r.id === App.selectedRegionId) li.classList.add("selected");
    const tc = r.target_color || b.target_color;
    li.innerHTML = `<span><span class="swatch-inline" style="background:${tc}"></span>
      区域 ${i + 1} · ${r.points.length} 点</span>
      <span class="tag">${tc}</span>`;
    li.addEventListener("click", () => {
      App.selectedRegionId = r.id;
      $("#region-target").value = (r.target_color || b.target_color || "#1a1a1a");
      renderRegionList();
      redrawDraw();
    });
    ul.appendChild(li);
  });
}

function initDrawTab() {
  const canvas = $("#draw-canvas");
  canvas.addEventListener("click", (e) => {
    const [x, y] = canvasMm(canvas, drawView, e);
    App.draft.push([+x.toFixed(2), +y.toFixed(2)]);
    redrawDraw();
  });
  // 点击已有区域 → 选中(在空白处加点优先,所以用 dblclick 选中)
  canvas.addEventListener("dblclick", (e) => {
    const [x, y] = canvasMm(canvas, drawView, e);
    const b = getBlock(App.currentBlockId);
    if (!b) return;
    for (const r of b.regions) {
      if (pointInPoly(x, y, transformedPoints(r, b))) {
        App.selectedRegionId = r.id;
        $("#region-target").value = (r.target_color || b.target_color || "#1a1a1a");
        renderRegionList();
        redrawDraw();
        return;
      }
    }
    App.selectedRegionId = null;
    renderRegionList();
    redrawDraw();
  });

  $("#draw-block-select").addEventListener("change", (e) => {
    App.currentBlockId = +e.target.value;
    App.selectedRegionId = null;
    renderRegionList();
    redrawDraw();
  });
  $("#btn-close-region").addEventListener("click", async () => {
    if (App.draft.length < 3) { toast("至少需要 3 个顶点", true); return; }
    try {
      App.project = await api(`/api/blocks/${App.currentBlockId}/regions`, "POST", {
        points: App.draft, target_color: $("#region-target").value,
      });
      App.draft = [];
      toast("区域已保存");
      refreshAllPanels();
    } catch (e) { toast(e.message, true); }
  });
  $("#btn-undo-point").addEventListener("click", () => { App.draft.pop(); redrawDraw(); });
  $("#btn-clear-draft").addEventListener("click", () => { App.draft = []; redrawDraw(); });
  $("#btn-delete-region").addEventListener("click", async () => {
    if (!App.selectedRegionId) { toast("请先双击选中一个区域", true); return; }
    try {
      App.project = await api(`/api/regions/${App.selectedRegionId}`, "DELETE");
      App.selectedRegionId = null;
      refreshAllPanels();
    } catch (e) { toast(e.message, true); }
  });
  $("#btn-set-region-target").addEventListener("click", async () => {
    if (!App.selectedRegionId) { toast("请先双击选中一个区域", true); return; }
    try {
      App.project = await api(`/api/regions/${App.selectedRegionId}`, "PUT", {
        target_color: $("#region-target").value,
      });
      toast("区域目标色已更新");
      refreshAllPanels();
    } catch (e) { toast(e.message, true); }
  });
}

/* ---------------- 设置页事件 ---------------- */

function initSetupTab() {
  $("#btn-save-project").addEventListener("click", saveProjectSettings);
  $("#btn-add-block").addEventListener("click", async () => {
    try {
      App.project = await api(`/api/projects/${App.project.id}/blocks`, "POST", {});
      refreshAllPanels();
    } catch (e) { toast(e.message, true); }
  });
  $("#sketch-file").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = async () => {
      try {
        App.project = await api(`/api/projects/${App.project.id}`, "PUT", { sketch: rd.result });
        loadSketch();
        toast("底稿已导入");
      } catch (err) { toast(err.message, true); }
    };
    rd.readAsDataURL(f);
  });
  $("#sketch-opacity").addEventListener("input", (e) => {
    App.sketchOpacity = parseFloat(e.target.value);
    redrawAll();
  });
}

function loadSketch() {
  if (App.project && App.project.sketch) {
    const img = new Image();
    img.onload = () => { App.sketchImg = img; redrawAll(); };
    img.src = App.project.sketch;
  } else {
    App.sketchImg = null;
  }
}
