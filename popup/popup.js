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

init();
