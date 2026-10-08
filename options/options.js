// options.js - 管理中心完整逻辑

// ====== 页面路由 ======
const pages = document.querySelectorAll(".page");
const navItems = document.querySelectorAll(".nav-item");

navItems.forEach(item => {
  item.addEventListener("click", () => {
    const target = item.dataset.page;
    navItems.forEach(n => n.classList.remove("active"));
    pages.forEach(p => p.classList.remove("active"));
    item.classList.add("active");
    const targetPage = document.getElementById("page-" + target);
    if (targetPage) targetPage.classList.add("active");
    if (target === "hosts") loadHosts();
    if (target === "danmaku") loadDanmakuLog();
    if (target === "history") loadHistory();
    if (target === "stats") loadStats();
    if (target === "settings") loadSettings();
  });
});

// ====== Toast ======
function showToast(msg, duration = 2500) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), duration);
}

// ====== 规则管理 ======
let editingRuleId = null;
let currentReplies = [];

const RULE_TEMPLATES = [
  { name: "购买下单", keywords: ["怎么买", "购买", "下单", "在哪买", "链接"], replies: ["亲，直接点左下角小黄车下单哦~", "左下角购物车一键下单，今日特惠！"] },
  { name: "价格询问", keywords: ["价格", "多少钱", "报价", "多少"], replies: ["亲，今天直播间有专属优惠，点左下角看看~"] },
  { name: "发货物流", keywords: ["发货", "快递", "几天到", "物流"], replies: ["拍下后48小时内发货，3~5天到哦"] },
  { name: "尺码型号", keywords: ["尺码", "型号", "规格", "尺寸"], replies: ["详细尺码表在商品详情页，拿不准私信小助手~"] },
  { name: "优惠活动", keywords: ["优惠", "打折", "活动", "折扣", "便宜"], replies: ["今天直播间专享价，全场都有优惠哦！"] },
  { name: "欢迎新人", keywords: ["第一次", "新来的", "刚进来", "新粉"], replies: ["欢迎新朋友！记得点关注哦，每天好货不断~"] },
  { name: "感谢互动", keywords: ["谢谢", "感谢", "太好了", "棒棒"], replies: ["谢谢你的支持，继续给我们动力！"] },
  { name: "质量询问", keywords: ["质量怎么样", "好不好", "正品吗", "真的吗"], replies: ["放心哦，我们都是正品，品质有保障！"] },
];

async function loadRules() {
  const { profiles } = await chrome.storage.local.get("profiles");
  // 找到当前活跃主播的规则（默认第一个启用的）
  const activeProfile = (profiles || []).find(p => p.enabled) || (profiles || [])[0];
  if (activeProfile) {
    renderRuleTable(activeProfile.rules || [], activeProfile.id);
    document.getElementById("ruleCount").textContent = `主播「${activeProfile.name}」· 共 ${(activeProfile.rules || []).length} 条规则`;
    // 存储当前选中的主播ID
    window._currentProfileId = activeProfile.id;
  } else {
    renderRuleTable([], "");
    document.getElementById("ruleCount").textContent = "暂无主播";
  }
  renderTemplates();
}

function renderRuleTable(rules, profileId) {
  const tbody = document.getElementById("ruleTableBody");
  document.getElementById("ruleCount").textContent = `主播「${window._currentProfileName || ''}」· 共 ${rules.length} 条规则`;

  if (!rules.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:30px;color:#bbb">暂无规则，点击「新增规则」或从下方模板快速添加</td></tr>`;
    return;
  }

  tbody.innerHTML = rules.map(r => `
    <tr data-id="${r.id}">
      <td>
        <label class="toggle">
          <input type="checkbox" class="rule-enable-toggle" data-id="${r.id}" ${r.enabled ? "checked" : ""}>
          <span class="slider"></span>
        </label>
      </td>
      <td>
        <div style="font-weight:500;font-size:13px">${esc(r.name)}</div>
        <div style="font-size:11px;color:#bbb;margin-top:2px">${new Date(r.createdAt || 0).toLocaleDateString()}</div>
      </td>
      <td>
        <div class="kw-chips">
          ${r.keywords.slice(0, 5).map(k => `<span class="kw-chip">${esc(k)}</span>`).join("")}
          ${r.keywords.length > 5 ? `<span style="font-size:11px;color:#bbb">+${r.keywords.length - 5}</span>` : ""}
        </div>
      </td>
      <td>
        <div class="reply-preview">${esc(r.replies[0] || "")}</div>
        ${r.replies.length > 1 ? `<div style="font-size:11px;color:#bbb">共 ${r.replies.length} 条备选</div>` : ""}
      </td>
      <td><span style="font-size:12px;color:#888">${r.matchMode === "exact" ? "精确" : "模糊"}</span></td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm edit-rule" data-id="${r.id}">编辑</button>
          <button class="btn btn-danger btn-sm del-rule" data-id="${r.id}">删除</button>
        </div>
      </td>
    </tr>
  `).join("");

  // 绑定事件
  tbody.querySelectorAll(".rule-enable-toggle").forEach(cb => {
    cb.addEventListener("change", async () => {
      await toggleRule(cb.dataset.id, cb.checked);
    });
  });
  tbody.querySelectorAll(".edit-rule").forEach(btn => {
    btn.addEventListener("click", () => openEditModal(btn.dataset.id));
  });
  tbody.querySelectorAll(".del-rule").forEach(btn => {
    btn.addEventListener("click", () => deleteRule(btn.dataset.id));
  });
}

function renderTemplates() {
  const container = document.getElementById("templateList");
  container.innerHTML = RULE_TEMPLATES.map((t, i) => `
    <button class="btn btn-ghost" data-tpl="${i}" style="text-align:left;justify-content:flex-start;gap:6px;font-size:12px">
      <span>＋</span>${esc(t.name)}
    </button>
  `).join("");
  container.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", async () => {
      const tpl = RULE_TEMPLATES[parseInt(btn.dataset.tpl)];
      await addRuleFromTemplate(tpl);
    });
  });
}

async function addRuleFromTemplate(tpl) {
  const { profiles } = await chrome.storage.local.get("profiles");
  const pid = window._currentProfileId;
  const updated = (profiles || []).map(p => {
    if (p.id !== pid) return p;
    const existing = (p.rules || []).find(r => r.name === tpl.name);
    if (existing) return p;
    return { ...p, rules: [...(p.rules || []), {
      id: "rule_" + Date.now(), name: tpl.name, enabled: true,
      keywords: tpl.keywords, matchMode: "fuzzy", replies: tpl.replies,
      replyMode: "random", createdAt: Date.now()
    }]};
  });
  await chrome.storage.local.set({ profiles: updated });
  const profile = updated.find(p => p.id === pid);
  renderRuleTable(profile?.rules || [], pid);
  showToast(`已添加规则：${tpl.name}`);
}

async function toggleRule(id, enabled) {
  const { profiles } = await chrome.storage.local.get("profiles");
  const pid = window._currentProfileId;
  const updated = (profiles || []).map(p => {
    if (p.id !== pid) return p;
    return { ...p, rules: (p.rules || []).map(r => r.id === id ? { ...r, enabled } : r) };
  });
  await chrome.storage.local.set({ profiles: updated });
}

async function deleteRule(id) {
  if (!confirm("确定删除这条规则吗？")) return;
  const { profiles } = await chrome.storage.local.get("profiles");
  const pid = window._currentProfileId;
  const updated = (profiles || []).map(p => {
    if (p.id !== pid) return p;
    return { ...p, rules: (p.rules || []).filter(r => r.id !== id) };
  });
  await chrome.storage.local.set({ profiles: updated });
  const profile = updated.find(p => p.id === pid);
  renderRuleTable(profile?.rules || [], pid);
  showToast("规则已删除");
}

// ====== 规则编辑模态框 ======
function openAddModal() {
  editingRuleId = null;
  currentReplies = [""];
  document.getElementById("modalTitle").textContent = "新增规则";
  document.getElementById("f-name").value = "";
  document.getElementById("f-keywords").value = "";
  document.getElementById("f-matchmode").value = "fuzzy";
  document.getElementById("f-replymode").value = "random";
  document.getElementById("f-enabled").checked = true;
  renderReplyItems();
  document.getElementById("ruleModal").classList.add("show");
}

async function openEditModal(id) {
  const { profiles } = await chrome.storage.local.get("profiles");
  const pid = window._currentProfileId;
  const profile = (profiles || []).find(p => p.id === pid);
  const rule = (profile?.rules || []).find(r => r.id === id);
  if (!rule) return;
  editingRuleId = id;
  currentReplies = [...rule.replies];
  document.getElementById("modalTitle").textContent = "编辑规则";
  document.getElementById("f-name").value = rule.name;
  document.getElementById("f-keywords").value = rule.keywords.join("，");
  document.getElementById("f-matchmode").value = rule.matchMode || "fuzzy";
  document.getElementById("f-replymode").value = rule.replyMode || "random";
  document.getElementById("f-enabled").checked = rule.enabled;
  renderReplyItems();
  document.getElementById("ruleModal").classList.add("show");
}

function renderReplyItems() {
  const container = document.getElementById("replyItems");
  container.innerHTML = currentReplies.map((r, i) => `
    <div class="reply-item">
      <input type="text" class="reply-text" data-idx="${i}" value="${esc(r)}" placeholder="输入回复内容..." style="flex:1;border:none;background:transparent;outline:none;font-size:13px">
      <span class="del-reply" data-idx="${i}">×</span>
    </div>
  `).join("");

  container.querySelectorAll(".reply-text").forEach(inp => {
    inp.addEventListener("input", () => {
      currentReplies[parseInt(inp.dataset.idx)] = inp.value;
    });
  });
  container.querySelectorAll(".del-reply").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      if (currentReplies.length <= 1) { showToast("至少保留一条回复内容"); return; }
      currentReplies.splice(idx, 1);
      renderReplyItems();
    });
  });
}

document.getElementById("addReplyBtn").addEventListener("click", () => {
  currentReplies.push("");
  renderReplyItems();
  // 聚焦到最后一个
  const inputs = document.querySelectorAll(".reply-text");
  if (inputs.length > 0) inputs[inputs.length - 1].focus();
});

document.getElementById("btnAddRule").addEventListener("click", openAddModal);
document.getElementById("closeModal").addEventListener("click", () => document.getElementById("ruleModal").classList.remove("show"));
document.getElementById("cancelModal").addEventListener("click", () => document.getElementById("ruleModal").classList.remove("show"));

document.getElementById("saveModal").addEventListener("click", async () => {
  const name = document.getElementById("f-name").value.trim();
  const keywordsRaw = document.getElementById("f-keywords").value.trim();
  const matchMode = document.getElementById("f-matchmode").value;
  const replyMode = document.getElementById("f-replymode").value;
  const enabled = document.getElementById("f-enabled").checked;
  const replies = currentReplies.map(r => r.trim()).filter(Boolean);

  if (!name) { showToast("请输入规则名称"); return; }
  if (!keywordsRaw) { showToast("请输入至少一个关键词"); return; }
  if (!replies.length) { showToast("请输入至少一条回复内容"); return; }

  const keywords = keywordsRaw.split(/[,，]+/).map(k => k.trim()).filter(Boolean);
  const { profiles } = await chrome.storage.local.get("profiles");
  const pid = window._currentProfileId;

  const updated = (profiles || []).map(p => {
    if (p.id !== pid) return p;
    let newRules;
    if (editingRuleId) {
      newRules = (p.rules || []).map(r => r.id === editingRuleId
        ? { ...r, name, keywords, matchMode, replies, replyMode, enabled } : r);
      showToast("规则已更新");
    } else {
      newRules = [...(p.rules || []), {
        id: "rule_" + Date.now(), name, keywords, matchMode, replies, replyMode, enabled, createdAt: Date.now()
      }];
      showToast("规则已添加");
    }
    return { ...p, rules: newRules };
  });

  await chrome.storage.local.set({ profiles: updated });
  const profile = updated.find(p => p.id === pid);
  renderRuleTable(profile?.rules || [], pid);
  document.getElementById("ruleModal").classList.remove("show");
});

// 点击遮罩关闭
document.getElementById("ruleModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove("show");
});

// ====== 历史记录 ======
let historyPage = 1;
const PAGE_SIZE = 20;
let allHistory = [];
let filteredHistory = [];

async function loadHistory() {
  const { history } = await chrome.storage.local.get("history");
  allHistory = history || [];
  filterHistory();
}

function filterHistory() {
  const q = document.getElementById("historySearch").value.trim().toLowerCase();
  filteredHistory = q
    ? allHistory.filter(h =>
        h.userName?.toLowerCase().includes(q) ||
        h.danmaku?.toLowerCase().includes(q) ||
        h.matchedKeyword?.toLowerCase().includes(q) ||
        h.reply?.toLowerCase().includes(q)
      )
    : allHistory;
  historyPage = 1;
  renderHistoryTable();
}

function renderHistoryTable() {
  const tbody = document.getElementById("historyTableBody");
  const start = (historyPage - 1) * PAGE_SIZE;
  const pageData = filteredHistory.slice(start, start + PAGE_SIZE);

  if (!filteredHistory.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:30px;color:#bbb">暂无回复记录</td></tr>`;
    document.getElementById("historyPagination").innerHTML = "";
    return;
  }

  tbody.innerHTML = pageData.map(h => {
    const time = new Date(h.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return `
      <tr>
        <td style="color:#bbb;font-size:11px">${time}</td>
        <td><span class="user-badge">${esc(h.userName)}</span></td>
        <td style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(h.danmaku)}</td>
        <td><span class="kw-badge">${esc(h.matchedKeyword)}</span></td>
        <td style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#4CAF50">${esc(h.reply)}</td>
        <td style="font-size:11px;color:#888">${esc(h.ruleName)}</td>
      </tr>
    `;
  }).join("");

  // 分页
  const totalPages = Math.ceil(filteredHistory.length / PAGE_SIZE);
  const pg = document.getElementById("historyPagination");
  if (totalPages <= 1) { pg.innerHTML = ""; return; }

  let paginationHtml = `<button class="page-btn" onclick="goPage(${historyPage - 1})" ${historyPage === 1 ? "disabled" : ""}>‹</button>`;
  for (let i = 1; i <= Math.min(totalPages, 7); i++) {
    paginationHtml += `<button class="page-btn ${i === historyPage ? "active" : ""}" onclick="goPage(${i})">${i}</button>`;
  }
  if (totalPages > 7) paginationHtml += `<span style="font-size:12px;color:#bbb">...${totalPages}</span>`;
  paginationHtml += `<button class="page-btn" onclick="goPage(${historyPage + 1})" ${historyPage === totalPages ? "disabled" : ""}>›</button>`;
  pg.innerHTML = paginationHtml;
}

window.goPage = function (page) {
  const totalPages = Math.ceil(filteredHistory.length / PAGE_SIZE);
  if (page < 1 || page > totalPages) return;
  historyPage = page;
  renderHistoryTable();
};

document.getElementById("historySearch").addEventListener("input", filterHistory);

document.getElementById("btnClearHistory").addEventListener("click", async () => {
  if (!confirm("确定清空所有回复历史记录吗？")) return;
  await chrome.storage.local.set({ history: [] });
  allHistory = [];
  filterHistory();
  showToast("历史记录已清空");
});

document.getElementById("btnExportHistory").addEventListener("click", () => {
  if (!allHistory.length) { showToast("暂无历史记录"); return; }
  const headers = "时间,用户名,弹幕内容,触发关键词,自动回复,规则名称";
  const rows = allHistory.map(h => [
    new Date(h.time).toLocaleString("zh-CN"),
    h.userName, h.danmaku, h.matchedKeyword, h.reply, h.ruleName
  ].map(v => `"${String(v || "").replace(/"/g, '""')}"`).join(","));
  const csv = "\uFEFF" + headers + "\n" + rows.join("\n");
  downloadFile("reply_history.csv", csv, "text/csv");
});

// ====== 数据统计 ======
async function loadStats() {
  const { stats, profiles, history } = await chrome.storage.local.get(["stats", "profiles", "history"]);
  const s = stats || {};
  document.getElementById("s-total").textContent = s.total || 0;
  document.getElementById("s-matched").textContent = s.matched || 0;
  document.getElementById("s-replied").textContent = s.replied || 0;
  const rate = s.total > 0 ? Math.round((s.replied / s.total) * 100) : 0;
  document.getElementById("s-rate").textContent = rate + "%";

  // 各规则触发次数（从历史记录中统计）
  const ruleCounts = {};
  (history || []).forEach(h => {
    ruleCounts[h.ruleName] = (ruleCounts[h.ruleName] || 0) + 1;
  });

  const ruleStatsBody = document.getElementById("ruleStatsBody");
  const sortedRules = Object.entries(ruleCounts).sort((a, b) => b[1] - a[1]);
  if (!sortedRules.length) {
    ruleStatsBody.innerHTML = '<div style="text-align:center;color:#bbb;padding:20px">暂无数据</div>';
  } else {
    const maxCount = sortedRules[0][1];
    ruleStatsBody.innerHTML = sortedRules.map(([name, count]) => `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <span style="width:100px;font-size:12px;color:#444;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</span>
        <div style="flex:1;background:#f5f5f5;border-radius:4px;height:16px;overflow:hidden">
          <div style="width:${Math.round((count/maxCount)*100)}%;height:100%;background:#FE2C55;border-radius:4px;transition:width .3s"></div>
        </div>
        <span style="width:40px;text-align:right;font-size:12px;color:#888">${count}</span>
      </div>
    `).join("");
  }

  // 词云（高频弹幕词）
  const wordFreq = {};
  (history || []).forEach(h => {
    if (h.matchedKeyword) {
      wordFreq[h.matchedKeyword] = (wordFreq[h.matchedKeyword] || 0) + 1;
    }
  });
  const topWords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const wc = document.getElementById("wordCloud");
  if (!topWords.length) {
    wc.innerHTML = '<div style="text-align:center;color:#bbb;padding:20px">暂无数据</div>';
  } else {
    const maxFreq = topWords[0][1];
    wc.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;padding:4px">` +
      topWords.map(([word, freq]) => {
        const size = 11 + Math.round((freq / maxFreq) * 10);
        const opacity = 0.5 + (freq / maxFreq) * 0.5;
        return `<span style="font-size:${size}px;color:rgba(254,44,85,${opacity.toFixed(2)});padding:3px 8px;background:rgba(254,44,85,0.06);border-radius:12px">${esc(word)} <span style="font-size:10px;color:#bbb">${freq}</span></span>`;
      }).join("") + `</div>`;
  }
}

document.getElementById("btnResetStatsOptions").addEventListener("click", async () => {
  if (!confirm("确定重置所有统计数据吗？")) return;
  await chrome.runtime.sendMessage({ type: "RESET_STATS" });
  await loadStats();
  showToast("统计数据已重置");
});

// ====== 设置 ======
async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = settings || {};

  document.getElementById("set-enabled").checked = s.enabled ?? true;
  document.getElementById("set-atMention").checked = s.atMention ?? true;

  const delayMin = s.replyDelay?.min ?? 500;
  const delayMax = s.replyDelay?.max ?? 2000;
  const dedup = s.dedupWindow ?? 60;
  const contentDedup = s.contentDedupWindow ?? 30;
  const maxRpm = s.maxRepliesPerMinute ?? 10;
  const logHistory = s.logHistory ?? true;
  const historyLimit = s.historyLimit ?? 500;

  setRange("set-delay-min", delayMin, "set-delay-min-val", v => `${v}ms`);
  setRange("set-delay-max", delayMax, "set-delay-max-val", v => `${v}ms`);
  setRange("set-dedup", dedup, "set-dedup-val", v => `${v}s`);
  setRange("set-contentdedup", contentDedup, "set-contentdedup-val", v => `${v}s`);
  setRange("set-maxrpm", maxRpm, "set-maxrpm-val", v => `${v}条`);
  setRange("set-historylimit", historyLimit, "set-historylimit-val", v => `${v}条`);
  document.getElementById("set-log").checked = logHistory;

  // 绑定实时更新
  bindRange("set-delay-min", "set-delay-min-val", v => `${v}ms`);
  bindRange("set-delay-max", "set-delay-max-val", v => `${v}ms`);
  bindRange("set-dedup", "set-dedup-val", v => `${v}s`);
  bindRange("set-contentdedup", "set-contentdedup-val", v => `${v}s`);
  bindRange("set-maxrpm", "set-maxrpm-val", v => `${v}条`);
  bindRange("set-historylimit", "set-historylimit-val", v => `${v}条`);
}

function setRange(id, val, labelId, fmt) {
  const el = document.getElementById(id);
  if (el) el.value = val;
  const label = document.getElementById(labelId);
  if (label) label.textContent = fmt(val);
}

function bindRange(id, labelId, fmt) {
  const el = document.getElementById(id);
  const label = document.getElementById(labelId);
  if (!el || !label) return;
  // 防止重复绑定
  const newEl = el.cloneNode(true);
  el.parentNode.replaceChild(newEl, el);
  newEl.value = el.value;
  newEl.addEventListener("input", () => { label.textContent = fmt(newEl.value); });
}

document.getElementById("btnSaveSettings").addEventListener("click", async () => {
  const settings = {
    enabled: document.getElementById("set-enabled").checked,
    replyDelay: {
      min: parseInt(document.getElementById("set-delay-min").value),
      max: parseInt(document.getElementById("set-delay-max").value)
    },
    dedupWindow: parseInt(document.getElementById("set-dedup").value),
    contentDedupWindow: parseInt(document.getElementById("set-contentdedup").value),
    maxRepliesPerMinute: parseInt(document.getElementById("set-maxrpm").value),
    logHistory: document.getElementById("set-log").checked,
    historyLimit: parseInt(document.getElementById("set-historylimit").value),
    atMention: document.getElementById("set-atMention").checked
  };
  await chrome.storage.local.set({ settings });
  // 同步到所有直播标签
  const enabled = settings.enabled;
  const tabs = await chrome.tabs.query({ url: "*://live.douyin.com/*" });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "STATUS_CHANGED", enabled }).catch(() => {});
  }
  showToast("设置已保存");
});

// ====== 数据导入/导出 ======
document.getElementById("btnExportRules").addEventListener("click", async () => {
  const { profiles } = await chrome.storage.local.get("profiles");
  downloadFile("douyin_profiles.json", JSON.stringify(profiles || [], null, 2), "application/json");
  showToast("所有主播规则已导出");
});

document.getElementById("btnImportRules").addEventListener("click", () => {
  document.getElementById("importFile").click();
});

document.getElementById("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) { showToast("文件格式错误"); return; }
    // 检查是否是 profiles 格式
    const isProfiles = imported[0] && imported[0].rules !== undefined;
    if (isProfiles) {
      const { profiles } = await chrome.storage.local.get("profiles");
      const existingNames = new Set((profiles || []).map(p => p.name));
      const toAdd = imported.filter(p => !existingNames.has(p.name));
      if (toAdd.length === 0) { showToast("所有主播已存在"); return; }
      await chrome.storage.local.set({ profiles: [...(profiles || []), ...toAdd] });
      showToast(`已导入 ${toAdd.length} 个主播`);
    } else {
      // 旧格式：规则数组，添加到当前主播
      const { profiles } = await chrome.storage.local.get("profiles");
      const pid = window._currentProfileId;
      const updated = (profiles || []).map(p => {
        if (p.id !== pid) return p;
        const existingNames = new Set((p.rules || []).map(r => r.name));
        const toAdd = imported.filter(r => !existingNames.has(r.name));
        return { ...p, rules: [...(p.rules || []), ...toAdd] };
      });
      await chrome.storage.local.set({ profiles: updated });
      const profile = updated.find(p => p.id === pid);
      renderRuleTable(profile?.rules || [], pid);
      showToast(`已导入规则`);
    }
  } catch (err) {
    showToast("导入失败：" + err.message);
  }
  e.target.value = "";
});

document.getElementById("btnClearAll").addEventListener("click", async () => {
  if (!confirm("⚠️ 确定清除所有数据（规则、历史、统计）吗？此操作不可恢复！")) return;
  if (!confirm("再次确认：所有规则和历史记录将被永久删除。")) return;
  await chrome.storage.local.clear();
  showToast("数据已清除，页面即将刷新");
  setTimeout(() => location.reload(), 1500);
});

// ====== 工具函数 ======
function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ====== 主播管理 ======
let editingHostId = null;

async function loadHosts() {
  const { profiles } = await chrome.storage.local.get("profiles");
  renderHostList(profiles || []);
}

function renderHostList(profiles) {
  const container = document.getElementById("hostListBody");
  document.getElementById("hostCount").textContent = `共 ${profiles.length} 个主播（最多4个）`;

  if (!profiles.length) {
    container.innerHTML = '<div style="text-align:center;color:#bbb;padding:20px">暂无主播，点击「添加主播」创建</div>';
    return;
  }

  container.innerHTML = profiles.map(p => `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);">
      <label class="toggle">
        <input type="checkbox" class="host-enable-toggle" data-id="${p.id}" ${p.enabled ? "checked" : ""}>
        <span class="slider"></span>
      </label>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:500;font-size:14px;">${esc(p.name)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${(p.rules || []).length} 条规则 · ${p.enabled ? '<span style="color:#4CAF50">已启用</span>' : '<span style="color:#999">已禁用</span>'}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="btn btn-ghost btn-sm select-host-btn" data-id="${p.id}">选择</button>
        <button class="btn btn-ghost btn-sm edit-host-btn" data-id="${p.id}">改名</button>
        <button class="btn btn-danger btn-sm del-host-btn" data-id="${p.id}">删除</button>
      </div>
    </div>
  `).join("");

  // 绑定事件
  container.querySelectorAll(".host-enable-toggle").forEach(cb => {
    cb.addEventListener("change", async () => {
      await toggleHost(cb.dataset.id, cb.checked);
    });
  });
  container.querySelectorAll(".select-host-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await selectHost(btn.dataset.id);
    });
  });
  container.querySelectorAll(".edit-host-btn").forEach(btn => {
    btn.addEventListener("click", () => openHostEditModal(btn.dataset.id));
  });
  container.querySelectorAll(".del-host-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteHost(btn.dataset.id));
  });
}

async function selectHost(id) {
  const { profiles } = await chrome.storage.local.get("profiles");
  const host = (profiles || []).find(p => p.id === id);
  if (!host) return;
  window._currentProfileId = id;
  window._currentProfileName = host.name;
  renderRuleTable(host.rules || [], id);
  // 切换到规则页
  navItems.forEach(n => n.classList.remove("active"));
  pages.forEach(p => p.classList.remove("active"));
  document.querySelector('[data-page="rules"]')?.classList.add("active");
  document.getElementById("page-rules")?.classList.add("active");
  showToast(`已切换到「${host.name}」的规则`);
}

async function toggleHost(id, enabled) {
  const { profiles } = await chrome.storage.local.get("profiles");
  const updated = (profiles || []).map(p => p.id === id ? { ...p, enabled } : p);
  await chrome.storage.local.set({ profiles: updated });
  renderHostList(updated);
}

function openHostAddModal() {
  editingHostId = null;
  document.getElementById("hostModalTitle").textContent = "添加主播";
  document.getElementById("f-host-name").value = "";
  document.getElementById("hostModal").classList.add("show");
}

async function openHostEditModal(id) {
  editingHostId = id;
  const { profiles } = await chrome.storage.local.get("profiles");
  const host = (profiles || []).find(p => p.id === id);
  document.getElementById("hostModalTitle").textContent = "修改主播名称";
  document.getElementById("f-host-name").value = host?.name || "";
  document.getElementById("hostModal").classList.add("show");
}

async function saveHost() {
  const name = document.getElementById("f-host-name").value.trim();
  if (!name) { showToast("请输入主播名称"); return; }

  const { profiles } = await chrome.storage.local.get("profiles");
  let updated;

  if (editingHostId) {
    updated = (profiles || []).map(p => p.id === editingHostId ? { ...p, name } : p);
    showToast("主播名称已更新");
  } else {
    if ((profiles || []).length >= 4) { showToast("最多添加4个主播"); return; }
    updated = [...(profiles || []), {
      id: "profile_" + Date.now(),
      name, enabled: true, rules: []
    }];
    showToast("主播已添加");
  }

  await chrome.storage.local.set({ profiles: updated });
  renderHostList(updated);
  document.getElementById("hostModal").classList.remove("show");
}

async function deleteHost(id) {
  const { profiles } = await chrome.storage.local.get("profiles");
  const host = (profiles || []).find(p => p.id === id);
  if (!host) return;
  if (!confirm(`确定删除主播「${host.name}」及其所有规则吗？`)) return;
  if ((profiles || []).length <= 1) {
    if (!confirm("这是最后一个主播，删除后需要重新添加。确定吗？")) return;
  }
  const updated = (profiles || []).filter(p => p.id !== id);
  await chrome.storage.local.set({ profiles: updated });
  renderHostList(updated);
  if (window._currentProfileId === id) {
    const first = updated[0];
    if (first) {
      window._currentProfileId = first.id;
      window._currentProfileName = first.name;
      renderRuleTable(first.rules || [], first.id);
    }
  }
  showToast("主播已删除");
}

// Host modal events
document.getElementById("btnAddHost").addEventListener("click", openHostAddModal);
document.getElementById("closeHostModal").addEventListener("click", () => document.getElementById("hostModal").classList.remove("show"));
document.getElementById("cancelHostModal").addEventListener("click", () => document.getElementById("hostModal").classList.remove("show"));
document.getElementById("saveHostModal").addEventListener("click", saveHost);
document.getElementById("hostModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove("show");
});

// ====== 留言记录 ======
let currentDanmakuLog = [];

async function loadDanmakuLog() {
  const { danmakuLog } = await chrome.storage.local.get("danmakuLog");
  currentDanmakuLog = danmakuLog || [];
  renderDanmakuList(currentDanmakuLog);
}

function renderDanmakuList(log) {
  const container = document.getElementById("danmakuListBody");
  document.getElementById("danmakuCount").textContent = `共 ${log.length} 条留言（最多5000条）`;

  if (!log.length) {
    container.innerHTML = '<div style="text-align:center;color:#bbb;padding:20px">暂无留言记录</div>';
    return;
  }

  container.innerHTML = `
    <table style="width:100%;font-size:13px;border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:1px solid var(--border);text-align:left;">
          <th style="padding:8px;width:60px;">时间</th>
          <th style="padding:8px;width:80px;">用户</th>
          <th style="padding:8px;">留言内容</th>
          <th style="padding:8px;width:60px;text-align:center;">状态</th>
          <th style="padding:8px;width:140px;">回复</th>
        </tr>
      </thead>
      <tbody>
        ${log.slice(0, 2000).map(d => `
          <tr style="border-bottom:1px solid #f0f0f0;">
            <td style="padding:6px 8px;color:var(--text-muted);font-size:12px;white-space:nowrap;">${new Date(d.time).toLocaleTimeString("zh-CN", {hour:"2-digit",minute:"2-digit",second:"2-digit"})}</td>
            <td style="padding:6px 8px;font-size:12px;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(d.userName)}</td>
            <td style="padding:6px 8px;">${esc(d.text)}</td>
            <td style="padding:6px 8px;text-align:center;font-size:12px;">${d.matched ? '<span style="color:#4CAF50">已回复</span>' : '<span style="color:#999">-</span>'}</td>
            <td style="padding:6px 8px;font-size:12px;color:var(--text-muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(d.reply || "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// 搜索
document.getElementById("danmakuSearch").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { renderDanmakuList(currentDanmakuLog); return; }
  const filtered = currentDanmakuLog.filter(d =>
    (d.text || "").toLowerCase().includes(q) ||
    (d.userName || "").toLowerCase().includes(q)
  );
  renderDanmakuList(filtered);
  document.getElementById("danmakuCount").textContent = `搜索"${q}" · 匹配 ${filtered.length} 条`;
});

// 导出CSV
document.getElementById("btnExportDanmakuCSV").addEventListener("click", () => {
  if (!currentDanmakuLog.length) { showToast("暂无留言可导出"); return; }
  let csv = "\uFEFF时间,用户,留言内容,是否回复,自动回复内容\n";
  for (const d of currentDanmakuLog) {
    csv += `${new Date(d.time).toLocaleString("zh-CN")},"${(d.userName || "").replace(/"/g, '""')}","${(d.text || "").replace(/"/g, '""')}","${d.matched ? "是" : "否"}","${(d.reply || "").replace(/"/g, '""')}"\n`;
  }
  downloadFile(`抖音留言_${new Date().toISOString().slice(0,10)}.csv`, csv, "text/csv");
  showToast(`已导出 ${currentDanmakuLog.length} 条留言`);
});

// 导出JSON
document.getElementById("btnExportDanmakuJSON").addEventListener("click", () => {
  if (!currentDanmakuLog.length) { showToast("暂无留言可导出"); return; }
  downloadFile(`抖音留言_${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(currentDanmakuLog, null, 2), "application/json");
  showToast(`已导出 ${currentDanmakuLog.length} 条留言`);
});

// 清空
document.getElementById("btnClearDanmaku").addEventListener("click", () => {
  if (!confirm(`确定清空全部 ${currentDanmakuLog.length} 条留言记录吗？此操作不可恢复。`)) return;
  chrome.storage.local.set({ danmakuLog: [] });
  currentDanmakuLog = [];
  renderDanmakuList([]);
  showToast("留言记录已清空");
});

// ====== 初始化 ======
loadRules();
