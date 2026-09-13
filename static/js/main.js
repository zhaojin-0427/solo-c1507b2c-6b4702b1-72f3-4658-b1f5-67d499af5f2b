/* 初始化与全局装配 */
"use strict";

function refreshAllPanels() {
  if (!App.project) return;
  fillSetupForm();
  drawBlockOptions($("#draw-block-select"));
  drawBlockOptions($("#reg-block-select"));
  drawBlockOptions($("#trial-block-select"));
  $("#trial-block-select").dispatchEvent(new Event("change")); // 预填该版套准标记
  syncRegInputs();
  renderRegionList();
  renderLockTable();
  loadTrialList();
  loadPlanList();
  loadFlowList();
  renderTransferList();
  App.issues = [];
  issueLayer = null;
  renderIssues();
  redrawAll();
}

async function loadProjectList(selectId) {
  const rows = await api("/api/projects");
  const sel = $("#project-select");
  sel.innerHTML = "";
  rows.forEach(r => {
    const o = document.createElement("option");
    o.value = r.id;
    o.textContent = `#${r.id} ${r.name}`;
    sel.appendChild(o);
  });
  if (selectId) sel.value = selectId;
  return rows;
}

async function openProject(id) {
  App.project = await api(`/api/projects/${id}`);
  App.currentBlockId = App.project.blocks.length ? blocksSorted()[0].id : null;
  App.selectedRegionId = null;
  App.draft = [];
  App.trialCorr = null;
  App.trialOverlay = false;
  RF.flows = []; RF.flow = null; RF.currentFlowId = null;
  RF.selectedStageId = null; RF.working = []; RF.maskImgs = {};
  loadSketch();
  refreshAllPanels();
  initJigForProject();
}

function initTabs() {
  $$("#tabs .tab").forEach(btn => {
    btn.addEventListener("click", () => {
      $$("#tabs .tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      $$(".tab-pane").forEach(p => p.classList.remove("active"));
      $(`#tab-${btn.dataset.tab}`).classList.add("active");
      redrawAll();
      if (btn.dataset.tab === "export") renderCalibrationPage();
      if (btn.dataset.tab === "jig") redrawJig();
    });
  });
}

function initProjectBar() {
  $("#project-select").addEventListener("change", e => openProject(+e.target.value));
  $("#btn-new-project").addEventListener("click", async () => {
    const name = prompt("新项目名称:", "未命名画稿");
    if (name === null) return;
    try {
      const p = await api("/api/projects", "POST", {
        name, paper_w: 210, paper_h: 297, orientation: "portrait",
      });
      // 新项目默认给两块版,方便直接开始
      await api(`/api/projects/${p.id}/blocks`, "POST", { name: "主版", ink_color: "#1a1a1a" });
      await api(`/api/projects/${p.id}/blocks`, "POST", { name: "套色版", ink_color: "#a33b20" });
      await loadProjectList(p.id);
      await openProject(p.id);
      toast("项目已创建(已预置 2 块色版)");
    } catch (e) { toast(e.message, true); }
  });
  $("#btn-del-project").addEventListener("click", async () => {
    if (!App.project) return;
    if (!confirm(`删除项目「${App.project.name}」及其全部数据?`)) return;
    await api(`/api/projects/${App.project.id}`, "DELETE");
    const rows = await loadProjectList();
    if (rows.length) await openProject(rows[0].id);
    else location.reload();
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  initTabs();
  initProjectBar();
  initSetupTab();
  initDrawTab();
  initPreviewTab();
  initRegisterTab();
  initTrialTab();
  initPlanTab();
  initReductionTab();
  initJigTab();
  initExportTab();
  window.addEventListener("resize", redrawAll);
  const rows = await loadProjectList();
  if (rows.length) {
    await openProject(rows[0].id);
  } else {
    // 首次使用:自动建一个示例项目
    const p = await api("/api/projects", "POST", { name: "示例画稿" });
    await api(`/api/projects/${p.id}/blocks`, "POST", { name: "主版", ink_color: "#1a1a1a" });
    await api(`/api/projects/${p.id}/blocks`, "POST", { name: "套色版", ink_color: "#a33b20" });
    await loadProjectList(p.id);
    await openProject(p.id);
  }
});
