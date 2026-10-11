// popup.js - 弹出面板逻辑（双平台：抖音 + 视频号）

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";
  const isDouyin = url.includes("live.douyin.com");
  const isChannels = url.includes("channels.weixin.qq.com");
  const isLive = isDouyin || isChannels;

  if (!isLive) {
    document.getElementById("noPageTip").style.display = "block";
    document.getElementById("mainContent").style.display = "none";
    return;
  }

  document.getElementById("mainContent").style.display = "block";
  document.getElementById("noPageTip").style.display = "none";

  // 更新平台标识
  const platformName = isDouyin ? "抖音" : "视频号";
  document.getElementById("platformBadge").textContent = platformName;
  document.getElementById("platformBadge").style.background = isDouyin ? "#FE2C55" : "#07C160";

  await loadAll(tab.id);

  // ===== 监听模式 UI 初始化 =====
  initListenUI(isDouyin, tab.id);

  // 绑定事件
  document.getElementById("masterToggle").addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    document.getElementById("toggleLabel").textContent = enabled ? "开启中" : "已暂停";
    await chrome.runtime.sendMessage({ type: "TOGGLE_ENABLED", enabled });
  });

  document.getElementById("btnOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById("btnResetStats").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "RESET_STATS" });
    document.getElementById("statTotal").textContent = "0";
    document.getElementById("statMatched").textContent = "0";
    document.getElementById("statReplied").textContent = "0";
  });

  // 检测 content script 是否初始化
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_INIT_STATUS" });
    updateStatus(res?.initialized, res?.enabled);
  } catch {
    updateStatus(false, true, false);
  }
}

async function loadAll(tabId) {
  const { profiles, settings, stats, history, danmakuLog } = await chrome.storage.local.get([
    "profiles", "settings", "stats", "history", "danmakuLog"
  ]);

  // 统计
  document.getElementById("statTotal").textContent = stats?.total || 0;
  document.getElementById("statMatched").textContent = stats?.matched || 0;
  document.getElementById("statReplied").textContent = stats?.replied || 0;

  // 主开关
  const enabled = settings?.enabled ?? true;
  document.getElementById("masterToggle").checked = enabled;
  document.getElementById("toggleLabel").textContent = enabled ? "开启中" : "已暂停";

  // 活跃主播
  const activeProfiles = (profiles || []).filter(p => p.enabled);
  const allRules = [];
  activeProfiles.forEach(p => { if (p.rules) allRules.push(...p.rules); });
  const enabledRules = allRules.filter(r => r.enabled);

  // 规则列表
  renderRules(enabledRules);

  // 历史记录
  renderHistory(history || []);

  // 今日留言数
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayLog = (danmakuLog || []).filter(d => d.time >= today.getTime());

  // 更新状态栏
  document.getElementById("statusText").textContent =
    `今日留言: ${todayLog.length}条 · ` +
    (activeProfiles.length > 0
      ? `${activeProfiles.map(p => p.name).join("、")} · ${enabledRules.length}条规则`
      : "自动回复开启");
}

function renderRules(rules) {
  const container = document.getElementById("ruleList");
  if (!rules.length) {
    container.innerHTML = '<div class="empty-tip">暂无规则，去管理页添加</div>';
    return;
  }
  container.innerHTML = rules.slice(0, 6).map(r => `
    <div class="rule-item ${r.enabled ? "" : "disabled"}">
      <div class="rule-dot ${r.enabled ? "on" : "off"}"></div>
      <div class="rule-info">
        <div class="rule-name">${escHtml(r.name)}</div>
        <div class="rule-kw">${r.keywords.slice(0, 4).map(escHtml).join(" · ")}</div>
      </div>
      <span class="rule-toggle" data-id="${r.id}" data-enabled="${r.enabled}">
        ${r.enabled ? "暂停" : "启用"}
      </span>
    </div>
  `).join("") + (rules.length > 6 ? `<div style="text-align:center;font-size:11px;color:#bbb;padding:4px">还有 ${rules.length - 6} 条规则，前往管理页查看</div>` : "");

  // 绑定单条规则开关
  container.querySelectorAll(".rule-toggle").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const nowEnabled = btn.dataset.enabled === "true";
      const { profiles } = await chrome.storage.local.get("profiles");
      const updated = (profiles || []).map(p => ({
        ...p, rules: (p.rules || []).map(r => r.id === id ? { ...r, enabled: !nowEnabled } : r)
      }));
      await chrome.storage.local.set({ profiles: updated });
      // 重新计算规则
      const activeProfiles = updated.filter(p => p.enabled);
      const allRules = [];
      activeProfiles.forEach(p => { if (p.rules) allRules.push(...p.rules); });
      renderRules(allRules.filter(r => r.enabled));
    });
  });
}

function renderHistory(history) {
  const container = document.getElementById("historyList");
  if (!history.length) {
    container.innerHTML = '<div class="empty-tip">暂无回复记录</div>';
    return;
  }
  container.innerHTML = history.slice(0, 10).map(h => {
    const time = new Date(h.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return `
      <div class="history-item">
        <div class="history-danmaku">
          <span class="history-user">${escHtml(h.userName)}</span>
          <span>${escHtml(h.danmaku)}</span>
          <span class="history-time">${time}</span>
        </div>
        <div class="history-reply">
          <span>↳</span>
          <span class="history-reply-text">${escHtml(h.reply)}</span>
        </div>
      </div>
    `;
  }).join("");
}

function updateStatus(initialized, enabled) {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  if (!initialized) {
    dot.className = "status-dot";
    text.textContent = "弹幕监听未就绪（刷新页面）";
  } else if (!enabled) {
    dot.className = "status-dot disabled";
    text.textContent = "自动回复已暂停";
  } else {
    dot.className = "status-dot live";
    text.textContent = "弹幕监听中，自动回复开启";
  }
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// =============================================
// 监听模式（与自动回复完全隔离）
// =============================================
let listenPollTimer = null;

// 识别档案下拉框：从本机服务拉取档案列表，恢复上次选择
// 加载完成前禁用"开始监听"，防止极快点击时按 general 开播
async function loadListenProfiles() {
  const select = document.getElementById("listenProfile");
  const keywordsInput = document.getElementById("listenKeywords");
  const startBtn = document.getElementById("btnListenStart");
  if (!select) return;
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = "档案加载中..."; }
  try {
    let profiles = [];
    try {
      const resp = await fetch("http://127.0.0.1:17842/profiles");
      if (resp.ok) {
        const data = await resp.json();
        profiles = (data.profiles || []).filter(p => p && p.id);
      }
    } catch (e) { /* 服务没跑则用默认 */ }
    if (profiles.length === 0) {
      profiles = [{ id: "general", name: "通用", hotwordCount: 0 }];
    }
    select.innerHTML = "";
    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.hotwordCount > 0 ? `${p.name}（${p.hotwordCount}热词）` : p.name;
      select.appendChild(opt);
    }
    try {
      const saved = await chrome.storage.local.get("listenProfile");
      const lp = saved.listenProfile;
      if (lp) {
        if (lp.profileId && [...select.options].some(o => o.value === lp.profileId)) {
          select.value = lp.profileId;
        }
        if (keywordsInput && lp.keywordsRaw) keywordsInput.value = lp.keywordsRaw;
      }
    } catch (e) {}
  } finally {
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = "开始监听"; }
  }
}

function initListenUI(isDouyin, tabId) {
  const section = document.getElementById("listenSection");
  const noPage = document.getElementById("listenNoPage");
  const startBtn = document.getElementById("btnListenStart");
  const stopBtn = document.getElementById("btnListenStop");

  if (isDouyin) {
    section.style.display = "block";
    noPage.style.display = "none";
    loadListenProfiles();
  } else {
    section.style.display = "none";
    noPage.style.display = "block";
    return;
  }

  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    startBtn.textContent = "启动中...";
    document.getElementById("listenError").style.display = "none";
    // 识别档案 + 本场关键词（TASK-ASR-002）：随 LISTEN_START 透传给本机服务
    const profileId = document.getElementById("listenProfile")?.value || "general";
    const keywordsRaw = document.getElementById("listenKeywords")?.value || "";
    const sessionKeywords = keywordsRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    try { await chrome.storage.local.set({ listenProfile: { profileId, keywordsRaw } }); } catch (e) {}
    try {
      const res = await chrome.runtime.sendMessage({ type: "LISTEN_START", tabId, profileId, sessionKeywords });
      if (res?.ok) {
        updateListenUI(true);
        startPollListenStatus();
      } else {
        const errEl = document.getElementById("listenError");
        errEl.textContent = res?.hint || res?.error || "启动失败";
        errEl.style.display = "block";
        startBtn.disabled = false;
        startBtn.textContent = "开始监听";
      }
    } catch (e) {
      const errEl = document.getElementById("listenError");
      errEl.textContent = "通信失败: " + (e.message || "");
      errEl.style.display = "block";
      startBtn.disabled = false;
      startBtn.textContent = "开始监听";
    }
  });

  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    stopBtn.textContent = "停止中...";
    try {
      await chrome.runtime.sendMessage({ type: "LISTEN_STOP" });
    } catch (e) {}
    updateListenUI(false);
    stopPollListenStatus();
    stopBtn.disabled = false;
    stopBtn.textContent = "停止监听";
  });

  // TASK-DOM-DIAGNOSTIC-001：页面诊断（只在当前直播页执行，结果存本机）
  const diagBtn = document.getElementById("btnPageDiag");
  diagBtn.addEventListener("click", async () => {
    diagBtn.disabled = true;
    diagBtn.textContent = "诊断中...";
    const okEl = document.getElementById("diagResult");
    const errEl = document.getElementById("listenError");
    okEl.style.display = "none";
    errEl.style.display = "none";
    try {
      const res = await chrome.runtime.sendMessage({ type: "RUN_DIAGNOSTIC", tabId });
      if (res?.ok) {
        okEl.textContent = `诊断完成（${res.id}），已存本机，在复盘页查看`;
        okEl.style.display = "block";
      } else {
        errEl.textContent = res?.error || "诊断失败";
        errEl.style.display = "block";
      }
    } catch (e) {
      errEl.textContent = "通信失败: " + (e.message || "");
      errEl.style.display = "block";
    }
    diagBtn.disabled = false;
    diagBtn.textContent = "页面诊断";
  });

  // 检查当前状态
  chrome.runtime.sendMessage({ type: "LISTEN_STATUS" }).then(res => {
    if (res?.active) {
      updateListenUI(true);
      startPollListenStatus();
    }
  }).catch(() => {});
}

function updateListenUI(active) {
  const dot = document.getElementById("listenDot");
  const text = document.getElementById("listenStatusText");
  const stats = document.getElementById("listenStats");
  const startBtn = document.getElementById("btnListenStart");
  const stopBtn = document.getElementById("btnListenStop");

  if (active) {
    dot.style.background = "#4CAF50";
    dot.className = "status-dot live";
    text.textContent = "监听中...";
    text.style.color = "#4CAF50";
    stats.style.display = "block";
    startBtn.style.display = "none";
    stopBtn.style.display = "block";
  } else {
    dot.style.background = "#ccc";
    dot.className = "status-dot";
    text.textContent = "未开始";
    text.style.color = "#666";
    stats.style.display = "none";
    startBtn.style.display = "block";
    startBtn.disabled = false;
    startBtn.textContent = "开始监听";
    stopBtn.style.display = "none";
  }
}

function startPollListenStatus() {
  stopPollListenStatus();
  listenPollTimer = setInterval(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: "LISTEN_STATUS" });
      if (res) {
        document.getElementById("listenDanmakuCount").textContent = res.danmakuCount || 0;
        document.getElementById("listenAudioChunks").textContent = res.audioChunks || 0;
        document.getElementById("listenDuration").textContent = Math.floor((res.duration || 0) / 1000) + "s";
        if (!res.active) {
          updateListenUI(false);
          stopPollListenStatus();
        }
      }
    } catch (e) {}
  }, 2000);
}

function stopPollListenStatus() {
  if (listenPollTimer) {
    clearInterval(listenPollTimer);
    listenPollTimer = null;
  }
}

init();
