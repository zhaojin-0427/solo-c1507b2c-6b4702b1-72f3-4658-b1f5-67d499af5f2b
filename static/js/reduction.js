/* ⑦ 减版木刻刻印流程 */
"use strict";

const RF = {
  flows: [],            // 流程摘要列表(不含掩码)
  flow: null,           // 当前完整流程(含各阶段掩码 dataURL)
  currentFlowId: null,
  selectedStageId: null,
  working: [],          // 当前草稿阶段正在勾画的刻除多边形(mm)
  maskImgs: {},         // stageId -> {base,relief,carve,ink,narrow} HTMLImageElement
};

/* ---------------- 掩码图像 ---------------- */

function stageMasks(st) {
  let m = RF.maskImgs[st.id];
  if (m) return m;
  m = {};
  for (const [k, url] of [["base", st.base_png], ["relief", st.relief_png],
                          ["carve", st.carve_png], ["ink", st.ink_png],
                          ["narrow", st.narrow_png]]) {
    if (!url) { m[k] = null; continue; }
    const img = new Image();
    img.src = url;
    m[k] = img;
  }
  RF.maskImgs[st.id] = m;
  return m;
}

function masksReady(st) {
  const m = stageMasks(st);
  return Object.values(m).every(img => !img || img.complete && img.naturalWidth > 0);
}

function drawMask(view, img, color, alpha) {
  if (!img || !img.complete || !img.naturalWidth) return;
  const { ctx } = view;
  const { w, h } = rfPaperSize();
  const [x0, y0] = mmToPx(view, 0, 0);
  const [x1, y1] = mmToPx(view, w, h);
  // 着色结果按 color+alpha 缓存,避免每帧逐像素重算
  const key = `${color}:${alpha}`;
  let oc = img._tint && img._tint[key];
  if (!oc) {
    oc = document.createElement("canvas");
    oc.width = img.naturalWidth; oc.height = img.naturalHeight;
    const octx = oc.getContext("2d");
    octx.drawImage(img, 0, 0);
    const d = octx.getImageData(0, 0, oc.width, oc.height);
    const rgb = hexToRgb(color);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = d.data[i] / 255;
      d.data[i] = rgb[0]; d.data[i + 1] = rgb[1]; d.data[i + 2] = rgb[2];
      d.data[i + 3] = Math.round(v * 255 * alpha);
    }
    octx.putImageData(d, 0, 0);
    img._tint = img._tint || {};
    img._tint[key] = oc;
  }
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(oc, x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}

/* ---------------- 数据加载 ---------------- */

async function loadFlowList(selectId) {
  RF.flows = await api(`/api/projects/${App.project.id}/flows`);
  const sel = $("#rf-flow-select");
  sel.innerHTML = "";
  if (!RF.flows.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "(尚无流程)";
    sel.appendChild(o);
    RF.flow = null; RF.currentFlowId = null; RF.selectedStageId = null;
    renderReductionAll();
    return;
  }
  RF.flows.forEach(f => {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = `${f.name}(${f.stages.length} 阶段)`;
    sel.appendChild(o);
  });
  if (selectId && RF.flows.some(f => f.id === selectId)) sel.value = selectId;
  RF.currentFlowId = +sel.value;
  await openFlow(RF.currentFlowId);
}

async function openFlow(id) {
  RF.currentFlowId = id;
  RF.flow = await api(`/api/flows/${id}`);
  RF.maskImgs = {};
  if (!RF.flow.stages.some(s => s.id === RF.selectedStageId)) {
    RF.selectedStageId = RF.flow.stages.length ? RF.flow.stages[RF.flow.stages.length - 1].id : null;
  }
  const sel = RF.flow.stages.find(s => s.id === RF.selectedStageId);
  RF.working = sel && sel.status === "draft" ? JSON.parse(JSON.stringify(sel.carve_polys || [])) : [];
  renderReductionAll();
  // 掩码图像异步解码完成后再重绘一次
  RF.flow.stages.forEach(st => {
    Object.values(stageMasks(st)).forEach(img => {
      if (img && !img.complete) img.onload = () => redrawReduction();
    });
  });
}

/* 变更后统一回到最新流程数据 */
async function saveFlow(path, method, body) {
  RF.flow = await api(path, method, body);
  RF.maskImgs = {};
  RF.flow.stages.forEach(st => {
    Object.values(stageMasks(st)).forEach(img => {
      if (img && !img.complete) img.onload = () => redrawReduction();
    });
  });
  if (!RF.flow.stages.some(s => s.id === RF.selectedStageId) && RF.flow.stages.length) {
    RF.selectedStageId = RF.flow.stages[RF.flow.stages.length - 1].id;
  }
  const idx = rfIndex();
  if (idx >= 0) $("#rf-slider").value = idx + 1;
  renderReductionAll();
}

function rfStage() {
  return RF.flow && RF.flow.stages.find(s => s.id === RF.selectedStageId);
}
function rfIndex() {
  return RF.flow ? RF.flow.stages.findIndex(s => s.id === RF.selectedStageId) : -1;
}

/* ---------------- 渲染:流程信息与阶段列表 ---------------- */

const RF_STATUS = {
  draft: ["草稿", "draft"], pending: ["待印", "pending"],
  printed: ["已印", "printed"], locked: ["锁定", "locked"],
};

function renderFlowMeta() {
  const el = $("#rf-meta");
  if (!RF.flow) { el.innerHTML = ""; return; }
  const snap = RF.flow.snapshot || {};
  const totalPlan = RF.flow.stages.reduce((a, s) => a + s.plan_prints, 0);
  const totalPrint = RF.flow.stages.reduce((a, s) => a + s.printed_count, 0);
  const totalWaste = RF.flow.stages.reduce((a, s) => a + s.waste_count, 0);
  el.innerHTML = `来源色版:<b>${snap.source_block_name || "?"}</b> ·
    纸面 ${RF.flow.paper_w}×${RF.flow.paper_h}mm ·
    初始凸面 ${snap.zones ? snap.zones.length : 0} 个色版区域<br>
    计划 ${totalPlan} 张 · 已印合格 ${totalPrint} 张 · 废张 ${totalWaste}`;
}

function renderStageList() {
  const ul = $("#rf-stage-list");
  ul.innerHTML = "";
  if (!RF.flow) return;
  RF.flow.stages.forEach((s, i) => {
    const [label, cls] = RF_STATUS[s.status];
    const li = document.createElement("li");
    li.className = "rf-stage" + (s.id === RF.selectedStageId ? " selected" : "")
      + (s.invalid ? " invalid" : "");
    li.innerHTML = `
      <div class="rf-row1">
        <span>阶段 ${i + 1} · ${s.name}
          <span class="rf-badge ${cls}">${label}</span>
          ${s.invalid ? '<span class="rf-badge invalid-badge">失效</span>' : ""}
        </span>
        <span class="tag mono"><span class="swatch-inline" style="background:${s.ink_color}"></span>
          ${s.printed_count ? s.printed_count + "印" : (s.plan_prints ? "拟" + s.plan_prints : "")}</span>
      </div>`;
    li.addEventListener("click", () => selectStage(s.id));
    ul.appendChild(li);
  });
  if (!RF.flow.stages.length) {
    ul.innerHTML = "<li><span class='tag'>尚无阶段,点击下方按钮建立第一遍</span></li>";
  }
}

function selectStage(id) {
  const st = RF.flow.stages.find(s => s.id === id);
  if (!st) return;
  RF.selectedStageId = id;
  RF.working = st.status === "draft" ? JSON.parse(JSON.stringify(st.carve_polys || [])) : [];
  const idx = RF.flow.stages.indexOf(st);
  $("#rf-slider").value = idx + 1;
  renderStageList();
  renderEditor();
  syncSliderLabel();
  redrawReduction();
}

/* ---------------- 渲染:阶段编辑面板 ---------------- */

function renderEditor() {
  const box = $("#rf-editor");
  box.innerHTML = "";
  const st = rfStage();
  if (!RF.flow) {
    box.innerHTML = "<p class='hint'>请先从项目中的色版建立一个减版流程。</p>";
    return;
  }
  if (!st) {
    box.innerHTML = "<p class='hint'>请选择或新建一个阶段。</p>";
    return;
  }
  const i = rfIndex();
  const editable = st.status === "draft";
  const [slabel] = RF_STATUS[st.status];
  const snap = RF.flow.snapshot || {};

  const head = document.createElement("div");
  head.innerHTML = `<b>阶段 ${i + 1} · ${st.name}</b> <span class="tag">[${slabel}]</span>`;
  box.appendChild(head);

  if (st.confirmed_at) {
    const d = document.createElement("div");
    d.className = "rf-snap";
    d.innerHTML = `确认于 ${st.confirmed_at} · 来源色版「${snap.source_block_name}」
      油墨 ${snap.ink_color} · 最小线宽 ${snap.min_line_width}mm ·
      几何快照 ${RF.flow.grid_w}×${RF.flow.grid_h} @${RF.flow.scale}px/mm`;
    box.appendChild(d);
  }

  function fieldRow(labelText, input) {
    const lab = document.createElement("label");
    lab.textContent = labelText + " ";
    lab.appendChild(input);
    box.appendChild(lab);
    return lab;
  }

  const nameIn = document.createElement("input");
  nameIn.type = "text"; nameIn.value = st.name; nameIn.disabled = !editable;
  nameIn.style.width = "100%"; nameIn.dataset.fld = "name";
  fieldRow("阶段名", nameIn);

  const colorIn = document.createElement("input");
  colorIn.type = "color"; colorIn.value = st.ink_color; colorIn.disabled = !editable;
  colorIn.dataset.fld = "ink_color";
  const opIn = document.createElement("input");
  opIn.type = "number"; opIn.min = 0.05; opIn.max = 1; opIn.step = 0.05;
  opIn.value = st.opacity; opIn.disabled = !editable; opIn.style.width = "60px";
  opIn.dataset.fld = "opacity";
  const opLab = document.createElement("label");
  opLab.textContent = "本遍油墨 ";
  opLab.appendChild(colorIn);
  opLab.appendChild(document.createTextNode(" 透明度 "));
  opLab.appendChild(opIn);
  box.appendChild(opLab);

  const planIn = document.createElement("input");
  planIn.type = "number"; planIn.min = 0; planIn.step = 1;
  planIn.value = st.plan_prints; planIn.disabled = !editable; planIn.style.width = "70px";
  planIn.dataset.fld = "plan_prints";
  fieldRow("计划印数 (张)", planIn);

  // 着墨区:从来源色版区域中勾选(实际着墨 = 勾选区 ∩ 当前剩余凸面)
  const zones = snap.zones || [];
  if (zones.length) {
    box.appendChild(el("h3", {}, "本遍着墨区(色版区域 ∩ 剩余凸面)"));
    const zw = document.createElement("div");
    zw.className = "rf-zones";
    zones.forEach((z, zi) => {
      const lab = document.createElement("label");
      lab.innerHTML = `<input type="checkbox" data-zone="${z.id}"
        ${st.zone_ids.includes(z.id) ? "checked" : ""} ${editable ? "" : "disabled"}>
        区域 ${zi + 1}(${z.pts.length} 点${z.target_color ? " · " + z.target_color : ""})`;
      zw.appendChild(lab);
    });
    box.appendChild(zw);
    zw.querySelectorAll("input[data-zone]").forEach(cb => {
      cb.addEventListener("change", () => {
        const ids = Array.from(zw.querySelectorAll("input:checked")).map(x => +x.dataset.zone);
        persistDraft({ zone_ids: ids });
      });
    });
  }

  if (editable) {
    box.appendChild(el("h3", {}, "本轮刻除区"));
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "在右侧画布上逐点单击勾画刻除多边形,≥3 点后「闭合多边形」;"
      + "在已刻掉处勾画会被自动忽略。已印阶段及刻掉区域不能恢复。";
    box.appendChild(p);
    const br = document.createElement("div");
    br.className = "btn-row";
    br.innerHTML = `
      <button id="btn-rf-close" class="secondary">闭合多边形</button>
      <button id="btn-rf-undo" class="secondary">撤销点</button>
      <button id="btn-rf-drop" class="secondary">删除本多边形</button>`;
    box.appendChild(br);
    const ul = document.createElement("ul");
    ul.className = "plain-list";
    RF.working.forEach((poly, pi) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>刻除多边形 ${pi + 1} · ${poly.length} 点</span>`;
      const del = document.createElement("button");
      del.className = "danger"; del.textContent = "删";
      del.addEventListener("click", () => {
        RF.working.splice(pi, 1);
        persistDraft({ carve_polys: RF.working }, true);
      });
      li.appendChild(del);
      ul.appendChild(li);
    });
    if (!RF.working.length) ul.innerHTML = "<li><span class='tag'>尚无闭合多边形</span></li>";
    box.appendChild(ul);
  }

  // 问题清单(本阶段)
  const issues = st.issues || [];
  if (issues.length) {
    box.appendChild(el("h3", {}, "检查结果"));
    const iw = document.createElement("div");
    issues.forEach(it => {
      const d = document.createElement("div");
      d.className = "rf-issue " + (it.blocking ? "block" : "warn");
      d.textContent = (it.blocking ? "⛔ " : "⚠ ") + it.text;
      iw.appendChild(d);
    });
    box.appendChild(iw);
  }

  // 状态操作
  const actions = document.createElement("div");
  actions.className = "btn-row";
  if (editable) {
    actions.appendChild(actionBtn("确认阶段(冻结快照/出图)", "", async () => {
      const blocking = (st.issues || []).filter(x => x.blocking);
      let force = false;
      if (blocking.length) {
        if (!confirm("存在阻断性检查项:\n\n" + blocking.map(x => "· " + x.text).join("\n")
          + "\n\n仍要强制确认?(物理上可能导致印废)")) return;
        force = true;
      }
      await saveFlow(`/api/stages/${st.id}/confirm`, "POST", { force });
      rfDraft.length = 0;
      toast("阶段已确认:快照已冻结,可下载刻除图/保留面图/操作记录");
    }));
    actions.appendChild(actionBtn("删除草稿阶段", "danger", async () => {
      if (!confirm("删除该草稿阶段?")) return;
      await saveFlow(`/api/stages/${st.id}`, "DELETE");
      toast("草稿已删除");
    }));
  } else if (st.status === "pending") {
    if (st.invalid) {
      const warn = document.createElement("div");
      warn.className = "rf-issue block";
      warn.textContent = "⛔ 该待印阶段已因较早草稿的几何改动而失效,快照与实际凸面不再一致。"
        + "请先「撤回为草稿」复核刻除区/着墨区并重新确认,之后才能登记已印。";
      box.appendChild(warn);
      const pb = printBtn(st);
      pb.disabled = true;
      pb.title = "失效阶段必须重新确认后才能登记已印";
      actions.appendChild(pb);
    } else {
      actions.appendChild(printBtn(st));
    }
    actions.appendChild(actionBtn("撤回为草稿(重新复核)", "secondary", async () => {
      await saveFlow(`/api/stages/${st.id}/withdraw`, "POST");
    }));
  } else if (st.status === "printed") {
    actions.appendChild(actionBtn("锁定完成阶段", "", async () => {
      await saveFlow(`/api/stages/${st.id}/lock`, "POST");
      toast("阶段已锁定归档");
    }));
  } else if (st.status === "locked") {
    actions.appendChild(actionBtn("解锁(回已印)", "secondary", async () => {
      await saveFlow(`/api/stages/${st.id}/unlock`, "POST");
    }));
  }
  box.appendChild(actions);

  if (st.status !== "draft") {
    const ex = document.createElement("div");
    ex.className = "btn-row";
    ex.appendChild(downloadBtn("镜像刻除图", () => downloadStageMap(st, "carve")));
    ex.appendChild(downloadBtn("保留面图", () => downloadStageMap(st, "relief")));
    ex.appendChild(downloadBtn("着墨图", () => downloadStageMap(st, "ink")));
    ex.appendChild(downloadBtn("操作记录", () => downloadStageLog(st), "secondary"));
    box.appendChild(ex);
  }

  // 操作日志
  if (st.log && st.log.length) {
    box.appendChild(el("h3", {}, "操作记录"));
    const lw = document.createElement("div");
    lw.className = "rf-log";
    st.log.slice().reverse().forEach(l => {
      lw.appendChild(el("div", {}, `${l.at} · ${l.text}`));
    });
    box.appendChild(lw);
  }

  // 绑定输入
  box.querySelectorAll("input[data-fld]").forEach(inp => {
    if (inp.disabled) return;
    inp.addEventListener("change", () => {
      const f = inp.dataset.fld;
      let v;
      if (f === "ink_color") v = inp.value;
      else if (f === "opacity") v = parseFloat(inp.value) || 1;
      else if (f === "plan_prints") v = Math.max(0, parseInt(inp.value, 10) || 0);
      else v = inp.value.trim() || st.name;
      persistDraft({ [f]: v });
    });
  });

  // 刻除区按钮
  const btnClose = $("#btn-rf-close");
  if (btnClose) btnClose.addEventListener("click", () => closeWorkingPoly(st));
  const btnUndo = $("#btn-rf-undo");
  if (btnUndo) btnUndo.addEventListener("click", () => { rfDraft.pop(); redrawReduction(); });
  const btnDrop = $("#btn-rf-drop");
  if (btnDrop) btnDrop.addEventListener("click", () => { rfDraft.length = 0; redrawReduction(); });
}

/* 正在点入但尚未闭合的多边形(与已闭合的 RF.working 分离) */
const rfDraft = [];

function el(tag, attrs, text) {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  if (text !== undefined) e.textContent = text;
  return e;
}
function actionBtn(text, cls, fn) {
  const b = document.createElement("button");
  b.textContent = text;
  if (cls) b.className = cls;
  b.addEventListener("click", () => Promise.resolve(fn()).catch(e => toast(e.message, true)));
  return b;
}
function downloadBtn(text, fn, cls) {
  const b = document.createElement("button");
  b.textContent = text;
  if (cls) b.className = cls;
  b.addEventListener("click", fn);
  return b;
}
function printBtn(st) {
  const b = document.createElement("button");
  b.textContent = "记录印刷完成";
  b.addEventListener("click", async () => {
    const printed = parseInt(prompt(`阶段「${st.name}」实际合格印数:`, String(st.plan_prints)), 10);
    if (isNaN(printed) || printed < 0) return;
    const waste = parseInt(prompt("废张数:", String(st.waste_count || 0)), 10);
    if (isNaN(waste) || waste < 0) return;
    await saveFlow(`/api/stages/${st.id}/print`, "POST", { printed_count: printed, waste_count: waste });
    toast(`已记录:合格 ${printed} 张,废张 ${waste} 张`);
  });
  return b;
}

/* 草稿阶段的字段写回(name/color/opacity/plan/carve/zone),后端即时重算并使后续失效。
   防抖保存,避免编辑面板被重建时打断输入。 */
let persistTimer = null;
function persistDraft(payload) {
  const st = rfStage();
  if (!st || st.status !== "draft") return;
  const geom = ("carve_polys" in payload) || ("zone_ids" in payload);
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      RF.flow = await api(`/api/stages/${st.id}`, "PUT", payload);
      RF.maskImgs = {};
      RF.flow.stages.forEach(s2 => Object.values(stageMasks(s2)).forEach(img => {
        if (img && !img.complete) img.onload = () => redrawReduction();
      }));
      renderStageList();
      renderEditor();
      redrawReduction();
      if (geom) toast("草稿几何已保存,后续阶段标记为失效待复核");
    } catch (e) { toast(e.message, true); }
  }, 300);
}

async function closeWorkingPoly(st) {
  if (rfDraft.length < 3) { toast("至少需要 3 个顶点", true); return; }
  RF.working.push(rfDraft.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]));
  rfDraft.length = 0;
  RF.flow = await api(`/api/stages/${st.id}`, "PUT", { carve_polys: RF.working });
  RF.maskImgs = {};
  RF.flow.stages.forEach(s2 => Object.values(stageMasks(s2)).forEach(img => {
    if (img && !img.complete) img.onload = () => redrawReduction();
  }));
  renderReductionAll();
  toast("刻除多边形已保存,后续阶段标记为失效");
}

/* ---------------- 画布 ---------------- */

let rfView = null;

/* 减版流程的纸面以后端冻结快照为准(项目设置事后改动不影响流程) */
function rfPaperSize() {
  if (RF.flow) return { w: RF.flow.paper_w, h: RF.flow.paper_h };
  return paperSize();
}

function setupRfCanvas(canvas, maxW, maxH) {
  const { w, h } = rfPaperSize();
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
  return { ctx, scale, ox: 1, oy: 1 };
}

function drawRfPaper(view) {
  const { ctx } = view;
  const { w, h } = rfPaperSize();
  const [x0, y0] = mmToPx(view, 0, 0);
  const [x1, y1] = mmToPx(view, w, h);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.strokeStyle = "#444";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

function drawRfSketch(view) {
  if (!App.sketchImg || !RF.flow) return;
  const { ctx } = view;
  const { w, h } = rfPaperSize();
  const [x0, y0] = mmToPx(view, 0, 0);
  const [x1, y1] = mmToPx(view, w, h);
  ctx.save();
  ctx.globalAlpha = App.sketchOpacity;
  ctx.drawImage(App.sketchImg, x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}

function redrawReduction() {
  const canvas = $("#reduction-canvas");
  if (!canvas || !App.project) return;
  const wrap = canvas.parentElement;
  rfView = setupRfCanvas(canvas, wrap.clientWidth - 40, window.innerHeight - 240);
  const mirror = $("#rf-mirror").checked;
  if (mirror) {
    // 纸面内水平镜像(与木面方向一致);纸框先按非镜像画底
    const { w } = rfPaperSize();
    rfView.ctx.translate(rfView.ox * 2 + w * rfView.scale, 0);
    rfView.ctx.scale(-1, 1);
  }
  drawRfPaper(rfView);
  if ($("#rf-show-sketch").checked) drawRfSketch(rfView);
  if (!RF.flow) return;

  const sliderVal = parseInt($("#rf-slider").value, 10);
  const upto = Math.max(0, Math.min(RF.flow.stages.length, Number.isFinite(sliderVal) ? sliderVal : 0));
  const stages = RF.flow.stages.slice(0, upto);

  // 叠印:每遍先铺该遍着墨(在当时凸面上),再展示刻除结果
  stages.forEach((s, i) => {
    const m = stageMasks(s);
    const ctx = rfView.ctx;
    ctx.save();
    ctx.globalAlpha = s.opacity;
    drawMask(rfView, m.ink, s.ink_color, 0.85);
    ctx.restore();
  });
  // 最后一阶段的剩余凸面轮廓
  const last = stages[stages.length - 1];
  if (last && $("#rf-show-relief").checked) {
    drawMask(rfView, stageMasks(last).relief, "#333333", 0.12);
  }
  if (last && $("#rf-show-inkzones").checked) {
    drawMask(rfView, stageMasks(last).ink, "#0057b8", 0.35);
  }
  if (last && $("#rf-show-narrow").checked) {
    drawMask(rfView, stageMasks(last).narrow, "#ff003c", 0.75);
  }

  // 套准标记
  (RF.flow.reg_marks || []).forEach(m => {
    if (m.x !== undefined) drawCross(rfView, m.x, m.y, 2.5, "#0057b8", null);
  });

  // 刻除多边形:滑杆所处阶段若是草稿,画其刻除区轮廓 + 正在勾画的点
  const focusIdx = upto - 1;
  const focus = focusIdx >= 0 ? RF.flow.stages[focusIdx] : null;
  if (focus && $("#rf-show-poly").checked) {
    (focus.carve_polys || []).forEach(pts => drawPoly(rfView, pts, null, "#e0007a", 1.5, [5, 3]));
  }
  const st = rfStage();
  const editingVisible = st && st.status === "draft" && sliderVal === rfIndex() + 1;
  if (editingVisible) {
    RF.working.forEach(pts => drawPoly(rfView, pts, null, "#e0007a", 1.2, [5, 3]));
  }
  if (editingVisible && rfDraft.length) {
    const ctx = rfView.ctx;
    ctx.save();
    ctx.strokeStyle = "#e0007a"; ctx.fillStyle = "#e0007a"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    rfDraft.forEach((p, i) => {
      const [px, py] = mmToPx(rfView, p[0], p[1]);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      ctx.fillRect(px - 2, py - 2, 4, 4);
    });
    ctx.stroke();
    ctx.restore();
  }

  // 高亮新刻区域(滑杆最后一遍的刻除掩码)
  if (last && $("#rf-highlight").checked) {
    drawMask(rfView, stageMasks(last).carve, "#ff8a00", 0.85);
  }
  renderIssuesBar();
}
Redraw.reduction = redrawReduction;

function renderIssuesBar() {
  const box = $("#rf-issues");
  if (!box) return;
  box.innerHTML = "";
  const sliderVal = parseInt($("#rf-slider")?.value || "0", 10);
  const s = RF.flow && sliderVal > 0 ? RF.flow.stages[sliderVal - 1] : rfStage();
  if (!s) {
    box.innerHTML = "<span class='tag'>拖动滑杆按顺序叠印预览,逐步查看每遍的新刻区域。</span>";
    return;
  }
  const issues = s.issues || [];
  if (s.invalid) {
    const d = document.createElement("div");
    d.className = "rf-issue block";
    d.textContent = "⛔ 该阶段已失效:上游草稿改动改变了凸面,请复核刻除区与着墨区后重新确认。";
    box.appendChild(d);
  }
  issues.forEach(it => {
    const d = document.createElement("div");
    d.className = "rf-issue " + (it.blocking ? "block" : "warn");
    d.textContent = (it.blocking ? "⛔ " : "⚠ ") + it.text;
    box.appendChild(d);
  });
  if (!issues.length && !s.invalid) {
    box.innerHTML = `<span class="tag">阶段「${s.name}」检查通过。实际着墨面积/窄线等以后端栅格化结果为准。</span>`;
  }
}

function syncSliderLabel() {
  const v = parseInt($("#rf-slider").value, 10) || 0;
  $("#rf-slider-label").textContent = (!RF.flow || v === 0)
    ? "空白纸面"
    : `阶段 ${v} · ${RF.flow.stages[v - 1].name}`;
}

/* ---------------- 出图:镜像刻除图 / 保留面图 / 操作记录 ---------------- */

const RF_EXPORT_SCALE = 4;

function stageMaskCanvas(st, kind) {
  // kind: base/carve/relief/ink,返回该阶段纸面大小的黑白画布(以冻结纸面为准)
  const w = RF.flow.paper_w, h = RF.flow.paper_h;
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(w * RF_EXPORT_SCALE);
  cv.height = Math.ceil(h * RF_EXPORT_SCALE);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  const img = stageMasks(st)[kind];
  if (img && img.complete) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
  }
  return cv;
}

function mirrorExport(st, kind, title) {
  const w = RF.flow.paper_w, h = RF.flow.paper_h;
  const inner = stageMaskCanvas(st, kind);
  const cv = document.createElement("canvas");
  cv.width = inner.width + 40;
  cv.height = inner.height + 80;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  // 水平镜像(反贴木版转印用)
  ctx.save();
  ctx.translate(20, 20);
  ctx.translate(inner.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(inner, 0, 0);
  ctx.restore();
  ctx.strokeStyle = "#000"; ctx.lineWidth = 0.4;
  ctx.strokeRect(20.5, 20.5, inner.width - 1, inner.height - 1);
  ctx.fillStyle = "#000";
  ctx.font = "bold 15px sans-serif";
  ctx.fillText(title, 20, cv.height - 42);
  ctx.font = "12px sans-serif";
  ctx.fillText(`${RF.flow.name} · 阶段 ${st.seq + 1} ${st.name} · ${st.ink_color} · `
    + `纸面 ${w}×${h}mm · ${new Date().toLocaleString()}`, 20, cv.height - 22);
  return cv;
}

function downloadStageMap(st, kind) {
  const titles = { carve: "镜像刻除图(黑=本轮刻除)", relief: "保留面图(黑=剩余凸面)", ink: "着墨图(黑=本遍着墨)" };
  const cv = mirrorExport(st, kind, titles[kind]);
  downloadCanvas(cv, `${kind}_${RF.flow.name}_阶段${st.seq + 1}_${st.name}.png`);
}

function downloadStageLog(st) {
  const snap = RF.flow.snapshot || {};
  const lines = [];
  lines.push(`减版木刻阶段操作记录`);
  lines.push(`流程:${RF.flow.name}    项目:${snap.project_name || ""}`);
  lines.push(`来源色版:${snap.source_block_name}    初始油墨:${snap.ink_color}    最小线宽:${snap.min_line_width}mm`);
  lines.push(`纸面:${RF.flow.paper_w}×${RF.flow.paper_h}mm    栅格:${RF.flow.grid_w}×${RF.flow.grid_h}@${RF.flow.scale}px/mm`);
  lines.push(`阶段序号:${st.seq + 1}    名称:${st.name}    状态:${RF_STATUS[st.status][0]}`);
  lines.push(`油墨:${st.ink_color} α${st.opacity}    计划印数:${st.plan_prints}`
    + `    实际合格:${st.printed_count}    废张:${st.waste_count}`);
  lines.push(`确认时间:${st.confirmed_at || "(草稿)"}`);
  lines.push(`刻除多边形:${(st.carve_polys || []).length} 个,着墨区域:${(st.zone_ids || []).length} 个`);
  lines.push(``);
  lines.push(`检查项:`);
  (st.issues.length ? st.issues : [{ text: "无", blocking: false }])
    .forEach(i => lines.push(`  ${i.blocking ? "[阻断] " : "[提示] "}${i.text}`));
  lines.push(``);
  lines.push(`操作日志:`);
  (st.log || []).forEach(l => lines.push(`  ${l.at}  ${l.text}`));
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.download = `操作记录_${RF.flow.name}_阶段${st.seq + 1}.txt`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------- 初始化 ---------------- */

function openCreateBox() {
  if (!App.project || !App.project.blocks.length) {
    toast("请先在「项目与色版」建立色版,并在「区域勾勒」中勾勒区域", true);
    return;
  }
  const sel = $("#rf-new-block");
  sel.innerHTML = "";
  blocksSorted().forEach((b, i) => {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = `${b.name}(${b.regions.length} 区域, ${b.ink_color}, 最小线宽 ${b.min_line_width}mm)`;
    sel.appendChild(o);
  });
  fillCreateZones();
  $("#rf-create-box").style.display = "block";
}

function fillCreateZones() {
  const box = $("#rf-new-zones");
  box.innerHTML = "";
  const b = getBlock(+$("#rf-new-block").value);
  if (!b) return;
  if (!b.regions.length) {
    box.innerHTML = "<div class='hint' style='color:#b00020'>该色版尚无封闭区域,请先到「区域勾勒」中勾勒。</div>";
  }
  b.regions.forEach((r, i) => {
    const lab = document.createElement("label");
    const tc = r.target_color || b.target_color;
    lab.innerHTML = `<input type="checkbox" value="${r.id}" checked>
      <span class="swatch-inline" style="background:${tc}"></span>
      区域 ${i + 1}(${r.points.length} 点 · ${tc})`;
    box.appendChild(lab);
  });
  $("#rf-new-name").value = b ? `${b.name}·减版流程` : "";
}

function renderReductionAll() {
  if (!RF.flow) {
    $("#rf-slider").max = 0; $("#rf-slider").value = 0;
  } else {
    $("#rf-slider").max = RF.flow.stages.length;
    const selIdx = RF.flow.stages.findIndex(s => s.id === RF.selectedStageId);
    $("#rf-slider").value = selIdx >= 0 ? selIdx + 1 : RF.flow.stages.length;
  }
  renderFlowMeta();
  renderStageList();
  renderEditor();
  syncSliderLabel();
  redrawReduction();
}

function initReductionTab() {
  $("#btn-rf-new").addEventListener("click", openCreateBox);

  $("#rf-new-block").addEventListener("change", fillCreateZones);
  $("#btn-rf-zones-all").addEventListener("click", () => {
    $$("#rf-new-zones input[type=checkbox]").forEach(cb => { cb.checked = true; });
  });
  $("#btn-rf-zones-none").addEventListener("click", () => {
    $$("#rf-new-zones input[type=checkbox]").forEach(cb => { cb.checked = false; });
  });
  $("#btn-rf-create-cancel").addEventListener("click", () => {
    $("#rf-create-box").style.display = "none";
  });
  $("#btn-rf-create-ok").addEventListener("click", async () => {
    const sel = $("#rf-new-block");
    const b = getBlock(+sel.value);
    if (!b) { toast("请选择来源色版", true); return; }
    const ids = $$("#rf-new-zones input[type=checkbox]:checked").map(cb => +cb.value);
    if (!ids.length) { toast("请至少勾选一个色版区域作为初始凸面", true); return; }
    const name = $("#rf-new-name").value.trim() || `${b.name}·减版流程`;
    try {
      RF.flow = await api(`/api/projects/${App.project.id}/flows`, "POST", {
        source_block_id: b.id, zone_ids: ids, name,
      });
      RF.currentFlowId = RF.flow.id;
      $("#rf-create-box").style.display = "none";
      await loadFlowList(RF.flow.id);
      toast(`流程已建立,初始凸面为选中的 ${ids.length} 个区域快照`);
    } catch (e) { toast(e.message, true); }
  });

  $("#btn-rf-del").addEventListener("click", async () => {
    if (!RF.flow) return;
    if (!confirm(`删除流程「${RF.flow.name}」及其全部阶段?此操作不可恢复。`)) return;
    await api(`/api/flows/${RF.flow.id}`, "DELETE");
    RF.flow = null; RF.selectedStageId = null;
    await loadFlowList();
  });

  $("#rf-flow-select").addEventListener("change", async e => {
    if (!e.target.value) return;
    await openFlow(+e.target.value);
  });

  $("#btn-rf-add-stage").addEventListener("click", async () => {
    if (!RF.flow) { toast("请先建立流程", true); return; }
    const n = RF.flow.stages.length;
    try {
      const f = await api(`/api/flows/${RF.flow.id}/stages`, "POST", { name: `第${n + 1}阶段` });
      RF.flow = f;
      RF.maskImgs = {};
      RF.selectedStageId = f.stages[f.stages.length - 1].id;
      RF.working = []; rfDraft.length = 0;
      f.stages.forEach(s2 => Object.values(stageMasks(s2)).forEach(img => {
        if (img && !img.complete) img.onload = () => redrawReduction();
      }));
      $("#rf-slider").value = f.stages.length;
      renderReductionAll();
      toast("已在上一阶段副本中建立草稿,请勾画本轮刻除区");
    } catch (e) { toast(e.message, true); }
  });

  $("#rf-slider").addEventListener("input", () => {
    syncSliderLabel();
    redrawReduction();
  });
  ["#rf-show-sketch", "#rf-show-relief", "#rf-show-narrow", "#rf-show-inkzones",
   "#rf-highlight", "#rf-show-poly", "#rf-mirror"].forEach(s => $(s).addEventListener("change", redrawReduction));

  $("#reduction-canvas").addEventListener("click", e => {
    const st = rfStage();
    if (!st || st.status !== "draft") return;
    // 仅在滑杆定位到该草稿阶段时允许加点
    const sliderVal = parseInt($("#rf-slider").value, 10);
    if (sliderVal !== rfIndex() + 1) {
      toast("请先把滑杆定位到该草稿阶段再勾画刻除区", true);
      return;
    }
    const [cx, cy] = canvasMm($("#reduction-canvas"), rfView, e);
    const x = $("#rf-mirror").checked ? rfPaperSize().w - cx : cx;
    rfDraft.push([+x.toFixed(2), +cy.toFixed(2)]);
    redrawReduction();
  });
}
