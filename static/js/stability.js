/* ⑤b 多张试印稳定性分析
 * 批次从项目色版与套准标记建立快照;按印刷顺序采集 3～30 张试纸,
 * 后端分离印张共有缩放/旋转与各版平移,检出漂移/突变/离群/漏测,
 * 中位数建议修正仅在操作者勾选后写入未锁定色版。 */
"use strict";

const SB = {
  mode: "single",
  list: [],
  batchId: null,
  batch: null,            // GET /api/trial-batches/<id> 完整负载
  selectedSeq: null,
  selectedBlockId: null,
  selectedMark: null,
  hoverText: "",
  timelineView: null,
  vectorView: null,
};

const FEED_OPTIONS = [["normal", "正常进纸"], ["turn180", "调头 180°"], ["flip", "翻面进纸"]];
const ISSUE_STYLE = {
  outlier: "bad", jump: "bad", misreg: "warn", drift: "warn",
  missing: "info", unmeasured: "info", absent_block: "info",
  feed_change: "info", sheet_excluded: "info", unfittable: "warn",
  single_block: "info",
};
const ISSUE_ICON = {bad: "⚠", warn: "▸", info: "ℹ"};

function sbSnapBlocks() { return (SB.batch?.snapshot?.blocks) || []; }
function sbSnapBlock(id) { return sbSnapBlocks().find(b => b.id === id); }
function sbLiveBlock(id) { return getBlock(id); }
function sbSheetRows() { return SB.batch?.sheets || []; }
function sbSelectedSheetRow() {
  return sbSheetRows().find(s => s.seq === SB.selectedSeq) || null;
}
function sbResultSheets() { return SB.batch?.results?.sheets || []; }
function sbResultBySeq(seq) { return sbResultSheets().find(s => s.seq === seq); }
function sbMeasuresOf(sheetRow) { return SB.batch.measures[String(sheetRow.id)] || []; }
function sbFrozen() { return SB.batch && SB.batch.status === "confirmed"; }

/* ---------------- 批次列表与生命周期 ---------------- */

async function loadStabilityBatches() {
  if (!App.project) { SB.list = []; renderBatchSelect(); return; }
  SB.list = await api(`/api/projects/${App.project.id}/trial-batches`);
  renderBatchSelect();
}

function renderBatchSelect() {
  const sel = $("#sb-batch-select");
  sel.innerHTML = "";
  SB.list.forEach(b => {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = `#${b.id} ${b.name}(${b.n_sheets} 张·${b.status === "confirmed" ? "已确认" : "采集中"})`;
    sel.appendChild(o);
  });
  if (!SB.list.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "（无批次，点「新建批次」）";
    sel.appendChild(o);
    SB.batch = null; SB.batchId = null;
  } else if (!SB.list.some(b => b.id === SB.batchId)) {
    sel.value = SB.list[0].id;
    if (SB.mode === "batch") selectSBBatch(SB.list[0].id);
  } else {
    sel.value = SB.batchId;
  }
}

async function selectSBBatch(id) {
  SB.batchId = id ? +id : null;
  SB.batch = SB.batchId ? await api(`/api/trial-batches/${SB.batchId}`) : null;
  SB.selectedSeq = SB.batch && SB.batch.sheets.length ? SB.batch.sheets[0].seq : null;
  SB.selectedBlockId = sbSnapBlocks()[0]?.id ?? null;
  SB.selectedMark = null;
  renderSBAll();
}

async function newSBBatch() {
  if (!App.project) return;
  const name = prompt("批次名称:", `${App.project.name}·试印批次`);
  if (name === null) return;
  try {
    SB.batch = await api(`/api/projects/${App.project.id}/trial-batches`, "POST", { name });
    SB.batchId = SB.batch.id;
    SB.selectedSeq = null;
    toast("已从当前色版与套准标记建立快照");
    await loadStabilityBatches();
    $("#sb-batch-select").value = String(SB.batchId);
    renderSBAll();
  } catch (e) { toast(e.message, true); }
}

async function deleteSBBatch() {
  if (!SB.batch) return;
  if (!confirm(`删除批次「${SB.batch.name}」及其全部试纸与测量?`)) return;
  await api(`/api/trial-batches/${SB.batchId}`, "DELETE");
  SB.batch = null; SB.batchId = null;
  await loadStabilityBatches();
  if (SB.list.length) await selectSBBatch(SB.list[0].id);
  else { SB.batch = null; renderSBAll(); }
}

async function renameSBBatch() {
  if (!SB.batch) return;
  const name = prompt("批次名称:", SB.batch.name);
  if (name === null) return;
  await saveSBBatch({ name });
}

async function saveSBBatch(body) {
  SB.batch = await api(`/api/trial-batches/${SB.batchId}`, "PUT", body);
  renderSBAll();
}

async function confirmSBBatch() {
  const n = SB.batch.sheets.length;
  if (n < 3 || n > 30) { toast(`确认需 3～30 张试纸,当前 ${n} 张`, true); return; }
  if (!confirm("确认后将冻结来源标记、全部测量与分析结果;\n建议修正仍须手动勾选才会写入色版。继续?")) return;
  try {
    SB.batch = await api(`/api/trial-batches/${SB.batchId}/confirm`, "POST", {});
    toast("批次已确认并冻结");
    renderSBAll();
  } catch (e) { toast(e.message, true); }
}

async function reopenSBBatch() {
  if (!confirm("重新打开批次继续采集/补测?既有测量与试印记录保持不变。")) return;
  SB.batch = await api(`/api/trial-batches/${SB.batchId}/reopen`, "POST", {});
  toast("批次已重新打开");
  renderSBAll();
}

/* ---------------- 试纸 ---------------- */

async function addSBSheet() {
  try {
    SB.batch = await api(`/api/trial-batches/${SB.batchId}/sheets`, "POST", {});
    SB.selectedSeq = SB.batch.sheets.length - 1;
    renderSBAll();
  } catch (e) { toast(e.message, true); }
}

async function patchSBSheet(sheetId, body, silent) {
  try {
    SB.batch = await api(`/api/trial-sheets/${sheetId}`, "PUT", body);
    renderSBAll();
  } catch (e) {
    if (!silent) toast(e.message, true);
    else throw e;
  }
}

async function deleteSBSheet(row) {
  if (!confirm(`删除${row.name || `第 ${row.seq + 1} 张`}及其全部测量?`)) return;
  SB.batch = await api(`/api/trial-sheets/${row.id}`, "DELETE");
  if (SB.selectedSeq >= SB.batch.sheets.length) {
    SB.selectedSeq = SB.batch.sheets.length ? SB.batch.sheets.length - 1 : null;
  }
  renderSBAll();
}

async function moveSBSheet(row, delta) {
  const n = SB.batch.sheets.length;
  const to = Math.max(0, Math.min(n - 1, row.seq + delta));
  if (to === row.seq) return;
  await patchSBSheet(row.id, { seq: to });
  SB.selectedSeq = to;
}

function selectSBSheet(seq, blockId, mark) {
  SB.selectedSeq = seq;
  if (blockId !== undefined) SB.selectedBlockId = blockId;
  if (mark !== undefined) SB.selectedMark = mark;
  renderSBAll();
}

/* ---------------- 测量录入 ---------------- */

async function saveMeasureInput(row, blockId, mi, mxStr, myStr) {
  const url = `/api/trial-sheets/${row.id}/measures`;
  const x = parseFloat(mxStr), y = parseFloat(myStr);
  const bothEmpty = mxStr.trim() === "" && myStr.trim() === "";
  try {
    if (bothEmpty) {
      const existing = sbMeasuresOf(row).find(
        m => m.block_id === blockId && m.mark_index === mi);
      if (existing) {
        SB.batch = await api(`${url}/${blockId}/${mi}`, "DELETE");
      } else {
        return;
      }
    } else {
      if (isNaN(x) || isNaN(y)) { toast("请填齐 X、Y 实测坐标,或两格都留空表示漏测", true); return; }
      SB.batch = await api(url, "POST", { block_id: blockId, mark_index: mi, mx: x, my: y });
    }
    renderSBAll();
  } catch (e) { toast(e.message, true); }
}

async function toggleMeasureExclude(row, m, exclude) {
  let reason = m.reason || "";
  if (exclude) {
    reason = prompt("注明排除该测点的原因:", reason) || "";
    if (!reason.trim()) { toast("排除测点须注明原因", true); return; }
  }
  try {
    SB.batch = await api(`/api/trial-measures/${m.id}`, "PUT",
      { excluded: exclude, reason });
    renderSBAll();
  } catch (e) { toast(e.message, true); }
}

async function toggleSheetExclude(row, exclude) {
  let reason = row.exclude_reason || "";
  if (exclude) {
    reason = prompt("注明排除整张试纸的原因(该张保留在时间轴上,但不参与统计):", reason) || "";
    if (!reason.trim()) { toast("排除试纸须注明原因", true); return; }
  }
  try {
    await patchSBSheet(row.id, { excluded: exclude, exclude_reason: exclude ? reason : "" });
  } catch (e) { /* toast 已弹;保持视图 */ }
}

/* ---------------- 渲染:批次信息 ---------------- */

function renderSBMeta() {
  const meta = $("#sb-meta");
  const actions = $("#sb-batch-actions");
  const sheetPanel = $("#sb-sheet-panel");
  const editPanel = $("#sb-edit-panel");
  if (!SB.batch) {
    meta.innerHTML = "尚无批次。新建批次会把当前各色版(名称/油墨/三点套准标记)冻结为快照。";
    actions.innerHTML = "";
    sheetPanel.style.display = "none";
    editPanel.style.display = "none";
    $("#sb-issues").innerHTML = "";
    $("#sb-sugg-table").querySelector("tbody").innerHTML = "";
    $("#sb-summary").textContent = "";
    $("#sb-log").innerHTML = "";
    $("#sb-info").textContent = "";
    return;
  }
  sheetPanel.style.display = "";
  editPanel.style.display = "";
  const b = SB.batch;
  const snapNames = b.snapshot.blocks.map(x => x.name).join(" / ");
  meta.innerHTML = `
    <div class="sb-batch-confirmed">
      状态:<b>${b.status === "confirmed" ? "✅ 已确认冻结" : "采集中"}</b>
      ${b.confirmed_at ? ` · ${b.confirmed_at}` : ""}<br>
      快照建立 ${b.snapshot.frozen_at || b.created_at} ·
      纸面 ${b.snapshot.paper_w}×${b.snapshot.paper_h} mm<br>
      色版:${snapNames}
    </div>`;
  actions.innerHTML = "";
  const mkBtn = (id, text, fn, cls) => {
    const el = document.createElement("button");
    el.id = id; el.textContent = text;
    if (cls) el.className = cls;
    el.addEventListener("click", fn);
    actions.appendChild(el);
    return el;
  };
  mkBtn("btn-sb-rename", "改名", renameSBBatch, "secondary");
  if (sbFrozen()) {
    mkBtn("btn-sb-reopen", "重新打开继续采集", reopenSBBatch, "secondary");
  } else {
    const ok = b.sheets.length >= 3 && b.sheets.length <= 30;
    const cb = mkBtn("btn-sb-confirm", `确认批次并冻结(${b.sheets.length} 张)`,
      confirmSBBatch, "secondary");
    cb.disabled = !ok;
    if (!ok) cb.title = "确认需 3～30 张试纸";
  }
}

/* ---------------- 渲染:试纸列表 ---------------- */

function renderSBSheetList() {
  const ul = $("#sb-sheet-list");
  ul.innerHTML = "";
  const rows = sbSheetRows();
  rows.forEach(row => {
    const r = sbResultBySeq(row.seq);
    const li = document.createElement("li");
    li.className = "sb-sheet-item plain-list";
    if (row.seq === SB.selectedSeq) li.classList.add("sel");
    if (row.trusted) li.classList.add("trusted");
    if (row.excluded) li.classList.add("excluded");
    const pills = [];
    pills.push(`<span class="sb-pill ${r?.fittable ? "fit" : "no"}">`
      + `${r?.fittable ? "可解算" : "不可解"}</span>`);
    if (row.trusted) pills.push(`<span class="sb-pill tr">可信</span>`);
    if (row.excluded) pills.push(`<span class="sb-pill ex">排除</span>`);
    const nIssues = (SB.batch.results.issues || []).filter(i =>
      i.ref?.sheet_seq === row.seq && i.type !== "sheet_excluded").length;
    const detail = r?.fittable
      ? `缩放 ${(r.scale * 100).toFixed(2)}% · 旋转 ${r.rot_deg.toFixed(2)}°`
        + ` · 残差≤${r.max_res.toFixed(2)} · 版间≤${(r.misreg.reduce((m, x) => Math.max(m, x.mag), 0)).toFixed(2)} mm`
        + (nIssues ? ` · ⚠${nIssues}` : "")
      : (r?.reason ? `— ${r.reason}` : "");
    li.innerHTML = `
      <div class="s1">
        <span>${row.seq + 1}.</span>
        <b>${row.name || `第${row.seq + 1}张`}</b>
        <span>${pills.join("")}</span>
      </div>
      <div class="s2">
        <span>${row.printed_at || "未填时间"}</span>
        <span>·</span><span>${FEED_OPTIONS.find(f => f[0] === row.feed)?.[1] || row.feed}</span>
        <span>·</span><span>${detail}</span>
      </div>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      selectSBSheet(row.seq);
    });
    ul.appendChild(li);
  });
  if (!rows.length) {
    ul.innerHTML = "<li><span class='tag'>尚无试纸,点击下方按钮追加</span></li>";
  }
  $("#btn-sb-add-sheet").disabled = sbFrozen() || rows.length >= 30;
}

/* ---------------- 渲染:单张编辑(信息 + 测量表) ---------------- */

function renderSBEditPanel() {
  const panel = $("#sb-edit-panel");
  const row = sbSelectedSheetRow();
  if (!SB.batch) { panel.innerHTML = ""; return; }
  if (!row) {
    panel.innerHTML = "<h2>试纸编辑</h2><p class='hint'>先追加一张试纸。</p>";
    return;
  }
  const frozen = sbFrozen();
  const r = sbResultBySeq(row.seq) || {};
  const feedOpts = FEED_OPTIONS.map(([v, t]) =>
    `<option value="${v}" ${row.feed === v ? "selected" : ""}>${t}</option>`).join("");
  let html = `<h2>第 ${row.seq + 1} 张${row.name ? " · " + escapeHtml(row.name) : ""}</h2>`;
  if (frozen) html += `<p class="sb-batch-confirmed">批次已确认冻结,本张信息与测量只读。</p>`;
  html += `
    <div class="form-grid">
      <label>名称 <input id="sb-sh-name" value="${escapeHtml(row.name)}" ${frozen ? "disabled" : ""}></label>
      <label>印刷时间 <input id="sb-sh-time" value="${escapeHtml(row.printed_at)}"
        placeholder="2026-09-14 10:05" ${frozen ? "disabled" : ""}></label>
      <label>进纸方向 <select id="sb-sh-feed" ${frozen ? "disabled" : ""}>${feedOpts}</select></label>
      <label>备注 <input id="sb-sh-note" value="${escapeHtml(row.note || "")}" ${frozen ? "disabled" : ""}></label>
    </div>
    <div class="btn-row">
      <button id="btn-sb-trust" class="secondary">${row.trusted ? "取消可信锁定" : "🔒 锁定为可信印张"}</button>
      <button id="btn-sb-exclude" class="secondary">${row.excluded ? "取消整张拉排除" : "排除本张(注明原因)"}</button>
      <button id="btn-sb-up" class="secondary">上移</button>
      <button id="btn-sb-down" class="secondary">下移</button>
      <button id="btn-sb-del" class="danger">删除</button>
    </div>
    ${row.exclude_reason ? `<p class="hint">排除原因:${escapeHtml(row.exclude_reason)}</p>` : ""}
    <h3>各色版三点实测坐标 (mm,留空 = 漏测)</h3>
    <table class="data-table sb-meas-table">
      <thead><tr><th>色版</th><th>M1 X</th><th>M1 Y</th><th>M2 X</th><th>M2 Y</th>
      <th>M3 X</th><th>M3 Y</th><th></th></tr></thead><tbody></tbody>
    </table>`;
  if (r.fittable) {
    const mis = r.misreg.length
      ? r.misreg.map(m => `${sbSnapBlock(m.block_id)?.name || m.block_id} ${m.mag.toFixed(2)}`).join("; ")
      : "仅测一版";
    html += `<p class="hint">共性:缩放 ${(r.scale * 100).toFixed(3)}% ·
      旋转 ${r.rot_deg.toFixed(3)}° · 残差 RMS ${r.rms_res.toFixed(2)} / 最大 ${r.max_res.toFixed(2)} mm<br>
      版间套准差:${mis}</p>`;
  } else if (r.reason) {
    html += `<p class="hint" style="color:#b00020">${escapeHtml(r.reason)}</p>`;
  }
  panel.innerHTML = html;

  const tbody = panel.querySelector("tbody");
  const measures = sbMeasuresOf(row);
  sbSnapBlocks().forEach(b => {
    const tr = document.createElement("tr");
    const live = sbLiveBlock(b.id);
    const cells = [];
    for (let mi = 0; mi < 3; mi++) {
      const m = measures.find(x => x.block_id === b.id && x.mark_index === mi);
      if (m?.excluded) {
        cells.push(
          `<td class="excluded-cell" colspan="2" title="已排除 M${mi + 1}:${escapeHtml(m.reason)}">✕ M${mi + 1}</td>`);
      } else {
        cells.push(`<td><input data-b="${b.id}" data-mi="${mi}" data-k="x"
          value="${m ? m.mx : ""}" ${frozen ? "disabled" : ""}></td>
          <td><input data-b="${b.id}" data-mi="${mi}" data-k="y"
          value="${m ? m.my : ""}" ${frozen ? "disabled" : ""}></td>`);
      }
    }
    const color = live?.ink_color || "#888";
    tr.innerHTML = `<td><span class="swatch-inline" style="background:${color}"></span>${escapeHtml(b.name)}</td>`
      + cells.join("");
    const tdAct = document.createElement("td");
    for (let mi = 0; mi < 3; mi++) {
      const m = measures.find(x => x.block_id === b.id && x.mark_index === mi);
      if (!m) continue;
      const btn = document.createElement("button");
      btn.className = "secondary";
      btn.style.padding = "1px 6px";
      btn.textContent = m.excluded ? "恢复" : `M${mi + 1} 排除`;
      btn.disabled = frozen || (row.trusted && !m.excluded);
      btn.title = row.trusted && !m.excluded ? "可信印张的测点不可排除" : "";
      btn.addEventListener("click", () => toggleMeasureExclude(row, m, !m.excluded));
      tdAct.appendChild(btn);
    }
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  });

  // 事件
  const bindField = (id, key) => {
    const el = $(id);
    if (!el || frozen) return;
    el.addEventListener("change", () => patchSBSheet(row.id, { [key]: el.value }));
  };
  bindField("#sb-sh-name", "name");
  bindField("#sb-sh-time", "printed_at");
  bindField("#sb-sh-feed", "feed");
  bindField("#sb-sh-note", "note");
  if (!frozen) {
    // 同一标记 X/Y 两个输入,任一变化后取两格一起保存
    panel.querySelectorAll("input[data-b]").forEach(inp => {
      inp.addEventListener("change", () => {
        const bid = +inp.dataset.b, mi = +inp.dataset.mi;
        const x = panel.querySelector(`input[data-b="${bid}"][data-mi="${mi}"][data-k="x"]`).value;
        const y = panel.querySelector(`input[data-b="${bid}"][data-mi="${mi}"][data-k="y"]`).value;
        saveMeasureInput(row, bid, mi, x, y);
      });
      inp.addEventListener("focus", () => {
        SB.selectedBlockId = +inp.dataset.b;
        SB.selectedMark = +inp.dataset.mi;
        drawSBVector();
      });
    });
    $("#btn-sb-trust").addEventListener("click", () =>
      patchSBSheet(row.id, { trusted: !row.trusted }));
    $("#btn-sb-exclude").addEventListener("click", () =>
      toggleSheetExclude(row, !row.excluded));
    $("#btn-sb-up").addEventListener("click", () => moveSBSheet(row, -1));
    $("#btn-sb-down").addEventListener("click", () => moveSBSheet(row, 1));
    $("#btn-sb-del").addEventListener("click", () => deleteSBSheet(row));
  }
}

/* ---------------- 渲染:异常清单 ---------------- */

function renderSBIssues() {
  const ul = $("#sb-issues");
  ul.innerHTML = "";
  if (!SB.batch) return;
  const issues = SB.batch.results.issues || [];
  const metric = $("#sb-metric").value;
  issues.forEach((is_, idx) => {
    const li = document.createElement("li");
    const cls = ISSUE_STYLE[is_.type] || "info";
    li.className = `sb-issue-item ${cls}`;
    li.innerHTML = `<span>${ISSUE_ICON[cls] || "·"} ${escapeHtml(is_.text)}</span>`;
    li.title = "点击定位到印张/色版/标记";
    li.addEventListener("click", () => locateIssue(is_));
    ul.appendChild(li);
  });
  if (!issues.length) {
    ul.innerHTML = "<li><span class='tag'>暂无异常</span></li>";
  }
}

function locateIssue(is_) {
  const ref = is_.ref || {};
  if (ref.sheet_seq !== undefined) SB.selectedSeq = ref.sheet_seq;
  if (ref.block_id !== undefined && ref.block_id !== null) {
    if (typeof ref.block_id === "number") SB.selectedBlockId = ref.block_id;
  }
  if (ref.mark_index !== undefined) SB.selectedMark = ref.mark_index;
  if (ref.start_seq !== undefined && $("#sb-view").value === "vector") {
    // 漂移区间在时间轴上更直观,自动切到对应指标
    if (ref.metric) $("#sb-metric").value = ref.metric;
  }
  renderSBSheetList();
  renderSBEditPanel();
  redrawSB();
}

/* ---------------- 渲染:汇总与建议修正 ---------------- */

function renderSBSummary() {
  const sumEl = $("#sb-summary");
  const tbody = $("#sb-sugg-table").querySelector("tbody");
  const logUl = $("#sb-log");
  tbody.innerHTML = "";
  logUl.innerHTML = "";
  if (!SB.batch) { sumEl.textContent = ""; return; }
  const res = SB.batch.results, s = res.suggestions || {}, sum = res.summary || {};
  sumEl.innerHTML = `有效印张 <b>${sum.n_fittable ?? 0}</b>/${sum.n_sheets ?? 0} ·
    共性缩放中位 ${sum.scale_pct === null ? "—" : sum.scale_pct.toFixed(3) + "%"} ·
    旋转中位 ${sum.rot_median_deg === null ? "—" : sum.rot_median_deg.toFixed(3) + "°"} ·
    最大版间套准差 ${(sum.max_misreg ?? 0).toFixed(2)} mm<br>
    <span class="tag">建议修正为各版平移误差中位数(物理版不缩放/不补偿旋转);
    仅在确认批次后、手动勾选才写入未锁定色版,既有试印记录不变。</span>`;
  sbSnapBlocks().forEach(b => {
    const live = sbLiveBlock(b.id);
    const sg = s[String(b.id)];
    const locked = live?.locked_correction;
    const tr = document.createElement("tr");
    const tdCheck = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.dataset.bid = b.id;
    cb.disabled = !sbFrozen() || locked || !sg;
    cb.title = !sbFrozen() ? "确认批次后才能写入" : (locked ? "该版修正已锁定" : "");
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);
    tr.innerHTML += `<td><span class="swatch-inline" style="background:${live?.ink_color || "#888"}"></span>${escapeHtml(b.name)}</td>`;
    tr.innerHTML += sg
      ? `<td class="mono">${sg.tx.toFixed(2)}</td><td class="mono">${sg.ty.toFixed(2)}</td>
         <td>${sg.n} 张${sg.n_trusted ? `(可信 ${sg.n_trusted})` : ""}</td>
         <td>${locked ? "🔒 已锁" : "—"}</td>
         <td>${sg.warning ? `<span style="color:#d45500">${escapeHtml(sg.warning)}</span>` : "就绪"}</td>`
      : `<td colspan="5" class="tag">无足够测点</td>`;
    if (locked) tr.querySelector("td:nth-child(2)")?.classList.add("locked-cell");
    tbody.appendChild(tr);
  });
  $("#btn-sb-apply").disabled = !sbFrozen();
  $("#btn-sb-apply").title = sbFrozen() ? "" : "请先确认批次";
  (SB.batch.applied_log || []).forEach(l => {
    const li = document.createElement("li");
    li.className = "sb-log-line";
    li.innerHTML = `<span>${l.at} · ${escapeHtml(l.text)}</span>`;
    logUl.appendChild(li);
  });
}

async function applySBCorrections() {
  const ids = $$("#sb-sugg-table input[type=checkbox]:checked").map(cb => +cb.dataset.bid);
  if (!ids.length) { toast("请先勾选要写入修正的色版", true); return; }
  const names = ids.map(id => sbLiveBlock(id)?.name).join("、");
  if (!confirm(`将把中位数平移修正写入以下未锁定色版:\n${names}\n\n仅抵消平移,缩放/旋转不动;此操作会改变色版偏移,可在套准模拟中再次调整。继续?`)) return;
  try {
    const resp = await api(`/api/trial-batches/${SB.batchId}/apply-corrections`, "POST",
      { block_ids: ids });
    App.project = resp.project;
    refreshAllPanels();
    SB.batch = await api(`/api/trial-batches/${SB.batchId}`);
    renderSBAll();
    toast(`已写入 ${resp.applied.length} 块色版`
      + (resp.skipped.length ? `;跳过 ${resp.skipped.length} 块` : ""));
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 画布:印张时间轴 ---------------- */

function setupPixelCanvas(canvas, cssW, cssH) {
  cssW = Math.max(120, cssW); cssH = Math.max(80, cssH);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}

function sbSeriesValues(metric) {
  /* 返回 {series:[[{seq,v,valid}…]], labels:[], yLabel, perBlock:bool} */
  const sheets = sbResultSheets();
  const perBlock = metric === "tx" || metric === "ty";
  let series;
  if (perBlock) {
    const k = metric === "tx" ? 0 : 1;
    series = sbSnapBlocks().map(b => ({
      blockId: b.id, color: sbLiveBlock(b.id)?.ink_color || "#444",
      pts: sheets.map(r => {
        const t = r.fittable ? r.tx_by_block[String(b.id)] : null;
        return { seq: r.seq, v: t ? t[k] : null, valid: r.fittable && !r.excluded_sheet };
      }),
    }));
  } else {
    series = [{
      blockId: null, color: "#1b5e20",
      pts: sheets.map(r => {
        let v = null;
        if (r.fittable) {
          if (metric === "scale") v = r.scale;
          else if (metric === "rot_deg") v = r.rot_deg;
          else if (metric === "max_res") v = r.max_res ?? 0;
          else if (metric === "misreg") v = (r.misreg || []).reduce((m, x) => Math.max(m, x.mag), 0);
        }
        return { seq: r.seq, v, valid: r.fittable && !r.excluded_sheet };
      }),
    }];
  }
  return { series, n: sheets.length, perBlock };
}

function drawSBTimeline() {
  const canvas = $("#sb-timeline-canvas");
  if (!SB.batch) { canvas.style.display = "none"; return; }
  canvas.style.display = "";
  const cssW = Math.min(980, canvas.parentElement.clientWidth - 24);
  const v = setupPixelCanvas(canvas, cssW, 230);
  SB.timelineView = v;
  const { ctx, w, h } = v;
  const metric = $("#sb-metric").value;
  const blockFilter = +$("#sb-block-filter").value || null;
  const M = { l: 48, r: 16, t: 26, b: 34 };
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  const { series, n } = sbSeriesValues(metric);
  if (n === 0) {
    ctx.fillStyle = "#7a6f5c"; ctx.font = "13px sans-serif";
    ctx.fillText("尚无试纸", 16, 40);
    return;
  }
  const xAt = (seq) => n === 1 ? M.l + 20
    : M.l + seq * (w - M.l - M.r - 20) / (n - 1);
  let allV = [];
  series.forEach(s => s.pts.forEach(p => { if (p.v !== null) allV.push(p.v); }));
  let yLo = Math.min(0, ...allV), yHi = Math.max(0, ...allV);
  if (yHi - yLo < 1e-6) { yHi += 1; yLo -= 1; }
  const pad = (yHi - yLo) * 0.12; yLo -= pad; yHi += pad;
  const yAt = (val) => h - M.b - (val - yLo) / (yHi - yLo) * (h - M.t - M.b);

  // 网格 / 零轴 / 坐标
  ctx.strokeStyle = "#e5dcc7"; ctx.lineWidth = 1; ctx.fillStyle = "#7a6f5c"; ctx.font = "10px sans-serif";
  for (let g = 0; g <= 4; g++) {
    const val = yLo + g * (yHi - yLo) / 4, yy = yAt(val);
    ctx.beginPath(); ctx.moveTo(M.l, yy); ctx.lineTo(w - M.r, yy); ctx.stroke();
    ctx.fillText(val.toFixed(metric === "scale" ? 4 : 2), 4, yy + 3);
  }
  ctx.strokeStyle = "#998"; ctx.beginPath(); ctx.moveTo(M.l, yAt(0)); ctx.lineTo(w - M.r, yAt(0)); ctx.stroke();
  sbResultSheets().forEach(r => {
    const xx = xAt(r.seq);
    ctx.fillStyle = r.seq === SB.selectedSeq ? "#a33b20" : "#7a6f5c";
    ctx.fillText(`${r.seq + 1}`, xx - 3, h - 12);
  });
  ctx.fillStyle = "#333"; ctx.font = "bold 11px sans-serif";
  const yLabel = { scale: "缩放比", rot_deg: "度 °", tx: "mm", ty: "mm",
    max_res: "mm", misreg: "mm" }[metric];
  ctx.fillText($("#sb-metric").selectedOptions[0].textContent, M.l, 16);

  // 漂移/突变标注(仅匹配当前指标与色版筛选)
  const issues = SB.batch.results.issues || [];
  issues.forEach(is_ => {
    if (is_.ref?.metric !== metric) return;
    if (perBlockMetric(metric) && blockFilter && is_.ref?.block_id !== blockFilter) return;
    if (!perBlockMetric(metric) && is_.ref?.block_id !== undefined && is_.ref?.block_id !== null) return;
    if (is_.type === "jump") {
      const xx = xAt(is_.ref.sheet_seq);
      ctx.fillStyle = "#b00020"; ctx.font = "bold 13px sans-serif";
      ctx.fillText("▲", xx - 5, M.t + 12);
    } else if (is_.type === "drift") {
      const x0 = xAt(is_.ref.start_seq), x1 = xAt(is_.ref.end_seq);
      ctx.strokeStyle = "#1565c0"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x0, M.t + 18); ctx.lineTo(x1, M.t + 18);
      ctx.lineTo(x1 - 5, M.t + 14); ctx.moveTo(x1, M.t + 18); ctx.lineTo(x1 - 5, M.t + 22);
      ctx.stroke();
    }
  });

  // 数据线
  SB.timelineHit = [];
  series.forEach((s, si) => {
    if (blockFilter && s.blockId !== blockFilter) return;
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.4;
    let pen = false;
    ctx.beginPath();
    s.pts.forEach(p => {
      if (p.v === null || !p.valid) { pen = false; return; }
      const xx = xAt(p.seq), yy = yAt(p.v);
      pen ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
      pen = true;
    });
    ctx.stroke();
    s.pts.forEach(p => {
      if (p.v === null) return;
      const xx = xAt(p.seq), yy = yAt(p.v);
      ctx.beginPath();
      ctx.arc(xx, yy, p.valid ? 3.5 : 3.5, 0, Math.PI * 2);
      if (p.valid) { ctx.fillStyle = s.color; ctx.fill(); }
      else { ctx.strokeStyle = "#aaa"; ctx.stroke(); }
      if (s.blockId) {
        ctx.fillStyle = s.color; ctx.font = "9px sans-serif";
        ctx.fillText(sbSnapBlock(s.blockId)?.name?.slice(0, 1) || "", xx + 4, yy - 4);
      }
      SB.timelineHit.push({ x: xx, y: yy, seq: p.seq, blockId: s.blockId, v: p.v });
    });
  });
}

function perBlockMetric(metric) { return metric === "tx" || metric === "ty"; }

/* ---------------- 画布:误差矢量图 / 应用前后预览 ---------------- */

function drawSBVector() {
  const canvas = $("#sb-canvas");
  const wrap = canvas.parentElement;
  SB.vectorView = setupCanvas(canvas, wrap.clientWidth - 24, window.innerHeight - 360);
  const view = SB.vectorView;
  drawPaper(view);
  drawSketch(view);
  if (!SB.batch) return;
  const ctx = view.ctx;
  const mode = $("#sb-view").value;
  const row = sbSelectedSheetRow();
  const blockFilter = +$("#sb-block-filter").value || null;

  if (mode === "preview") { drawSBPreview(view); return; }
  if (!row) {
    ctx.fillStyle = "#7a6f5c"; ctx.font = "13px sans-serif";
    ctx.fillText("选择一张试纸查看误差矢量", 12, 24);
    return;
  }
  const r = sbResultBySeq(row.seq) || {};
  const measures = sbMeasuresOf(row);
  const sugg = SB.batch.results.suggestions || {};

  // 各版设计标记 + 实测点 + 残差矢量
  sbSnapBlocks().forEach(b => {
    const live = sbLiveBlock(b.id);
    const ink = live?.ink_color || "#888";
    const dim = blockFilter && blockFilter !== b.id;
    ctx.globalAlpha = dim ? 0.25 : 1;
    // 设计三点(小十字)
    b.marks.forEach((m, mi) => {
      drawCross(view, m[0], m[1], 2, ink, `M${mi + 1}`);
    });
    const t = r.fittable ? r.tx_by_block[String(b.id)] : null;
    if (t) {
      // 版平移:设计质心 → 质心 + t
      const cx = b.marks.reduce((z, m) => z + m[0], 0) / 3;
      const cy = b.marks.reduce((z, m) => z + m[1], 0) / 3;
      drawArrow(view, cx, cy, cx + t[0], cy + t[1], "#1565c0");
    }
    for (let mi = 0; mi < 3; mi++) {
      const m = measures.find(x => x.block_id === b.id && x.mark_index === mi);
      const dp = b.marks[mi];
      const sel = SB.selectedBlockId === b.id && SB.selectedMark === mi;
      if (!m) {
        // 漏测:设计点上画空心三角
        const [px, py] = mmToPx(view, dp[0], dp[1]);
        ctx.save(); ctx.strokeStyle = "#d45500"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(px, py - 7); ctx.lineTo(px + 6, py + 5);
        ctx.lineTo(px - 6, py + 5); ctx.closePath(); ctx.stroke(); ctx.restore();
        continue;
      }
      const [qx, qy] = [m.mx, m.my];
      if (m.excluded) {
        drawDot(view, qx, qy, 2.2, "#999");
        const [px, py] = mmToPx(view, qx, qy);
        ctx.save(); ctx.strokeStyle = "#999"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(px - 5, py - 5); ctx.lineTo(px + 5, py + 5);
        ctx.moveTo(px + 5, py - 5); ctx.lineTo(px - 5, py + 5); ctx.stroke(); ctx.restore();
        continue;
      }
      const res = (r.residuals || []).find(z => z.block_id === b.id && z.mark_index === mi);
      const outlier = res?.outlier;
      drawDot(view, qx, qy, outlier ? 3.2 : 2.2, outlier ? "#b00020" : "#c62828");
      if (res && Math.hypot(res.rx, res.ry) > 0.01) {
        // 残差矢量:实测 q → 预测 q + (rx,ry)
        drawArrow(view, qx, qy, qx + res.rx, qy + res.ry,
          outlier ? "#b00020" : "#e08214");
        if (outlier || sel) {
          const [px, py] = mmToPx(view, qx + res.rx, qy + res.ry);
          ctx.save(); ctx.fillStyle = outlier ? "#b00020" : "#333";
          ctx.font = "11px sans-serif";
          ctx.fillText(`${res.mag.toFixed(2)}mm`, px + 5, py - 5); ctx.restore();
        }
      }
      if (sel) {
        const [px, py] = mmToPx(view, qx, qy);
        ctx.save(); ctx.strokeStyle = "#a33b20"; ctx.lineWidth = 1.6; ctx.setLineDash([3, 2]);
        ctx.beginPath(); ctx.arc(px, py, 11, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  });

  // 图例与标题
  const lines = [
    `${row.name || `第${row.seq + 1}张`} · ${FEED_OPTIONS.find(f => f[0] === row.feed)?.[1]}`
      + (row.trusted ? " · 🔒可信" : "") + (row.excluded ? " · 已排除" : ""),
  ];
  if (r.fittable) lines.push(`共性缩放 ${(r.scale * 100).toFixed(3)}% · 旋转 ${r.rot_deg.toFixed(3)}°`
    + ` · 残差 RMS ${r.rms_res.toFixed(2)} / 最大 ${r.max_res.toFixed(2)} mm`);
  if (r.reason) lines.push(r.reason);
  lines.push("十 设计标记(色版色) · ● 实测点 · → 残差(橙)/ 版平移(蓝) · △ 漏测 · ✕ 已排除");
  ctx.save(); ctx.font = "12px sans-serif";
  lines.forEach((t, i) => {
    ctx.fillStyle = i === lines.length - 1 ? "#7a6f5c" : "#222";
    ctx.fillText(t, 12, 18 + i * 16);
  });
  ctx.restore();
  SB.vectorHit = [];
  sbSnapBlocks().forEach(b => {
    measures.filter(m => !m.excluded).forEach(m => {
      SB.vectorHit.push({ x: m.mx, y: m.my, blockId: b.id, mi: m.mark_index, seq: row.seq });
    });
    b.marks.forEach((dp, mi) =>
      SB.vectorHit.push({ x: dp[0], y: dp[1], blockId: b.id, mi, seq: row.seq, design: true }));
  });
}

function drawSBPreview(view) {
  /* 应用前后位置预览:当前项目区域为应用前(实线),按各版中位数平移误差反向
   * 抵消后为应用后(虚线);套准标记同样显示 设计 / 实测中位 / 修正后。 */
  const ctx = view.ctx;
  const sugg = SB.batch.results.suggestions || {};
  const snapIds = new Set(sbSnapBlocks().map(b => b.id));
  sbSnapBlocks().forEach(b => {
    const live = sbLiveBlock(b.id);
    if (!live) return;
    const sg = sugg[String(b.id)];
    live.regions.forEach(rgn => {
      drawPoly(view, rgn.points, null, live.ink_color, 1.2);
      if (sg) {
        const pts = rgn.points.map(p => [p[0] - sg.tx, p[1] - sg.ty]);
        drawPoly(view, pts, null, live.ink_color, 1.2, [5, 3]);
      }
    });
    b.marks.forEach((m, mi) => {
      drawCross(view, m[0], m[1], 1.8, "#0057b8");
      if (sg) drawCross(view, m[0] - sg.tx, m[1] - sg.ty, 1.8, "#2e7d32");
    });
  });
  ctx.save(); ctx.font = "12px sans-serif";
  ctx.fillStyle = "#333";
  ctx.fillText("应用前位置:各色实线(当前项目偏移下的区域轮廓)", 12, 20);
  ctx.fillText("应用后位置:同色虚线(按各版中位数平移误差反向抵消)", 12, 38);
  ctx.fillStyle = "#0057b8"; ctx.fillText("十 M 设计标记", 12, 56);
  ctx.fillStyle = "#2e7d32"; ctx.fillText("十 M 修正后标记", 110, 56);
  ctx.restore();
}

function drawArrow(view, x1, y1, x2, y2, color) {
  const ctx = view.ctx;
  const [px1, py1] = mmToPx(view, x1, y1);
  const [px2, py2] = mmToPx(view, x2, y2);
  const len = Math.hypot(px2 - px1, py2 - py1);
  if (len < 1.5) return;
  const ang = Math.atan2(py2 - py1, px2 - px1), ah = 5;
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(px1, py1); ctx.lineTo(px2, py2);
  ctx.lineTo(px2 - ah * Math.cos(ang - 0.4), py2 - ah * Math.sin(ang - 0.4));
  ctx.moveTo(px2, py2);
  ctx.lineTo(px2 - ah * Math.cos(ang + 0.4), py2 - ah * Math.sin(ang + 0.4));
  ctx.stroke(); ctx.restore();
}

function drawDot(view, x, y, rMm, color) {
  const ctx = view.ctx;
  const [px, py] = mmToPx(view, x, y);
  ctx.save(); ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(px, py, rMm * view.scale, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- 画布交互 ---------------- */

function initSBCanvasEvents() {
  const tl = $("#sb-timeline-canvas");
  tl.addEventListener("click", e => {
    if (!SB.timelineHit || !SB.timelineView) return;
    const rect = tl.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = 1e9;
    SB.timelineHit.forEach(h => {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bd && d < 14) { bd = d; best = h; }
    });
    if (best) selectSBSheet(best.seq, best.blockId ?? undefined);
  });
  tl.addEventListener("mousemove", e => {
    if (!SB.timelineHit) return;
    const rect = tl.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = 1e9;
    SB.timelineHit.forEach(h => {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bd && d < 14) { bd = d; best = h; }
    });
    $("#sb-info").textContent = best
      ? `第${best.seq + 1}张${best.blockId ? " · " + (sbSnapBlock(best.blockId)?.name || "") : ""}: ${best.v?.toFixed(3)}`
      : "";
  });

  const vc = $("#sb-canvas");
  vc.addEventListener("click", e => {
    if ($("#sb-view").value !== "vector" || !SB.vectorView || !SB.vectorHit) return;
    const [mx, my] = canvasMm(vc, SB.vectorView, e);
    let best = null, bd = 4;  // 4 mm 内拾取
    SB.vectorHit.forEach(h => {
      const d = Math.hypot(h.x - mx, h.y - my);
      if (d < bd) { bd = d; best = h; }
    });
    if (best) selectSBSheet(best.seq, best.blockId, best.mi);
  });
}

/* ---------------- 总装配 ---------------- */

function renderSBAll() {
  if (SB.mode !== "batch") return;
  renderSBMeta();
  renderSBSheetList();
  renderSBEditPanel();
  renderSBIssues();
  renderSBSummary();
  // 色版筛选选项与快照同步
  const bf = $("#sb-block-filter");
  const cur = bf.value;
  bf.innerHTML = '<option value="">全部</option>' + sbSnapBlocks().map(b =>
    `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("");
  bf.value = cur;
  redrawSB();
}

function redrawSB() {
  if (SB.mode !== "batch") return;
  if ($("#trial-mode-batch").hidden) return;
  try { drawSBTimeline(); } catch (e) { console.error("时间轴重绘失败:", e); }
  try { drawSBVector(); } catch (e) { console.error("矢量图重绘失败:", e); }
}

function initStabilityTab() {
  $$(".mode-btn").forEach(btn => btn.addEventListener("click", async () => {
    SB.mode = btn.dataset.trialMode;
    $$(".mode-btn").forEach(b => b.classList.toggle("active", b === btn));
    $("#trial-mode-single").hidden = SB.mode !== "single";
    $("#trial-mode-batch").hidden = SB.mode !== "batch";
    if (SB.mode === "batch") {
      if (!SB.batch && SB.list.length) await selectSBBatch(SB.list[0].id);
      else { renderSBAll(); redrawSB(); }
    }
    redrawTrial();
  }));
  $("#sb-batch-select").addEventListener("change", e => selectSBBatch(+e.target.value));
  $("#btn-sb-new").addEventListener("click", newSBBatch);
  $("#btn-sb-del").addEventListener("click", deleteSBBatch);
  $("#btn-sb-add-sheet").addEventListener("click", addSBSheet);
  $("#btn-sb-apply").addEventListener("click", applySBCorrections);
  $("#sb-view").addEventListener("change", redrawSB);
  $("#sb-metric").addEventListener("change", () => { renderSBIssues(); redrawSB(); });
  $("#sb-block-filter").addEventListener("change", redrawSB);
  initSBCanvasEvents();
  Redraw.stability = redrawSB;
}
