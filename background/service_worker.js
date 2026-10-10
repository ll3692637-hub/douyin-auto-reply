// =============================================
// 抖音直播自动回复 - Service Worker v2.0
// 支持多主播：每个主播独立规则，合并所有启用主播的规则匹配
// =============================================

const dedupCache = new Map();       // 用户级去重: userId_ruleId
const contentDedupCache = new Map(); // 内容级去重: ruleId_keyword
const rateWindow = { count: 0, windowStart: Date.now() };

// =============================================
// 监听模式状态（与自动回复完全隔离）
// =============================================
const LISTEN_LOCAL_SERVER = "http://127.0.0.1:17842";
let listenState = {
  active: false,
  sessionId: null,
  tabId: null,
  startTime: 0,
  danmakuCount: 0,
  audioChunks: 0,
  lastError: null
};
let listenStateHydrated = false;

async function ensureListenState() {
  if (listenStateHydrated) return;
  const saved = await chrome.storage.session.get("listenState");
  if (saved.listenState && typeof saved.listenState === "object") {
    listenState = { ...listenState, ...saved.listenState };
  }
  listenStateHydrated = true;
}

function persistListenState() {
  return chrome.storage.session.set({ listenState }).catch(() => {});
}

// =============================================
// 账号名单同步（TASK-DANMAKU-001）
// 名单源头在本地服务的 accounts.json；Service Worker 在发送决策前必须能读到，
// 因此启动/开播时从本机服务拉取并缓存到 chrome.storage.local。
// 服务没跑或名单缺失 = 不启用过滤（fail-open，全部按 audience 处理，不误杀）。
// =============================================

const ACCOUNTS_CACHE_KEY = "listenerAccounts";
const ACCOUNTS_CACHE_TTL_MS = 10 * 60 * 1000;

async function syncAccountsFromServer() {
  try {
    const resp = await fetch(`${LISTEN_LOCAL_SERVER}/accounts`);
    if (!resp.ok) return false;
    const data = await resp.json();
    const accounts = data && data.accounts ? data.accounts : { anchor_uids: [], water_army_uids: [], rooms: [] };
    await chrome.storage.local.set({
      [ACCOUNTS_CACHE_KEY]: { ...accounts, syncedAt: Date.now() }
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function getCachedAccounts() {
  try {
    const saved = await chrome.storage.local.get(ACCOUNTS_CACHE_KEY);
    const a = saved[ACCOUNTS_CACHE_KEY];
    if (!a || !Array.isArray(a.anchor_uids)) return null;
    return a;
  } catch (e) {
    return null;
  }
}

function parseRoomId(url) {
  const m = String(url || "").match(/live\.douyin\.com\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * 是否应跳过这条弹幕的自动回复（主播号/水军号）。
 * 在 handleDanmaku 的自动回复管线入口调用，规则匹配之前。
 */
async function shouldExcludeDanmaku(danmaku, tabId) {
  const accounts = await getCachedAccounts();
  if (!accounts) return false; // 无名单 = 不过滤
  const uid = String(danmaku.userId || "");
  if (!uid) return false;
  const isListed = accounts.anchor_uids.includes(uid) || accounts.water_army_uids.includes(uid);
  if (!isListed) return false;
  // 按直播间隔离：rooms 为空 = 名单未配置生效范围，不过滤
  if (!Array.isArray(accounts.rooms) || accounts.rooms.length === 0) return false;
  try {
    const tab = tabId ? await chrome.tabs.get(tabId) : null;
    const roomId = parseRoomId(tab && tab.url);
    if (!roomId || !accounts.rooms.map(String).includes(roomId)) return false;
  } catch (e) {
    return false;
  }
  return true;
}

const DEFAULT_RULES = [
  { id: "rule_1", name: "购买下单", enabled: true, keywords: ["怎么买", "购买", "下单", "在哪买", "链接", "小黄车"], matchMode: "fuzzy", replies: ["亲，直接点左下角小黄车就可以下单哦~", "左下角购物车一键下单，支持全国包邮！"], replyMode: "random", createdAt: Date.now() },
  { id: "rule_2", name: "价格询问", enabled: true, keywords: ["价格", "多少钱", "价钱", "报价", "啥价", "什么价"], matchMode: "fuzzy", replies: ["亲，价格在左下角购物车里有显示，今天直播间有专属优惠哦！", "直播间专享价，比日常便宜很多，点左下角小黄车看看~"], replyMode: "random", createdAt: Date.now() },
  { id: "rule_3", name: "发货物流", enabled: true, keywords: ["发货", "快递", "几天到", "物流", "到货", "包邮"], matchMode: "fuzzy", replies: ["亲，拍下后48小时内发货，一般3~5天到哦，偏远地区稍慢一点~", "顺丰/圆通随机发，大概3~5个工作日，请放心等待~"], replyMode: "random", createdAt: Date.now() },
  { id: "rule_4", name: "尺码型号", enabled: true, keywords: ["尺码", "型号", "规格", "尺寸", "大小"], matchMode: "fuzzy", replies: ["亲，详细尺码表在商品详情页里有，拿不准的可以私信小助手哦~"], replyMode: "sequential", createdAt: Date.now() },
  { id: "rule_5", name: "欢迎新人", enabled: true, keywords: ["第一次来", "新来的", "刚进来", "新粉"], matchMode: "fuzzy", replies: ["欢迎新朋友来到直播间！记得点击关注哦，每天都有好货~", "欢迎欢迎！喜欢的话给主播点个关注吧，福利多多！"], replyMode: "random", createdAt: Date.now() },
  { id: "rule_6", name: "退换货", enabled: true, keywords: ["退货", "换货", "退款", "不喜欢", "质量问题"], matchMode: "fuzzy", replies: ["亲，支持7天无理由退换，有问题直接联系客服处理，放心购~"], replyMode: "sequential", createdAt: Date.now() }
];

const DEFAULT_PROFILES = [
  { id: "profile_1", name: "默认主播", enabled: true, rules: DEFAULT_RULES }
];

const DEFAULT_SETTINGS = {
  enabled: true, replyDelay: { min: 500, max: 2000 },
  dedupWindow: 60, contentDedupWindow: 30, maxRepliesPerMinute: 10,
  showNotification: false, logHistory: true, historyLimit: 500,
  atMention: false  // @用户名回复（默认关闭）
};

// 合并所有启用主播的规则
function getAllActiveRules(profiles) {
  const allRules = [];
  for (const p of (profiles || [])) {
    if (p.enabled && p.rules) {
      for (const r of p.rules) {
        if (r.enabled) allRules.push(r);
      }
    }
  }
  return allRules;
}

async function initDefaults() {
  try {
    const data = await chrome.storage.local.get(["profiles", "rules", "settings", "stats", "history"]);
    const updates = {};

    // 迁移旧版 rules 到 profiles
    if (!data.profiles) {
      if (data.rules && data.rules.length > 0) {
        updates.profiles = [{ id: "profile_1", name: "默认主播", enabled: true, rules: data.rules }];
      } else {
        updates.profiles = DEFAULT_PROFILES;
      }
    }
    if (!data.settings) updates.settings = DEFAULT_SETTINGS;
    if (!data.stats) updates.stats = { total: 0, matched: 0, replied: 0, startTime: Date.now() };
    if (!data.history) updates.history = [];

    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
      // 清除旧 rules key
      if (updates.profiles && data.rules) {
        await chrome.storage.local.remove("rules");
      }
      console.log("[AutoReply SW] 已初始化（多主播模式）");
    }
  } catch (e) {
    console.error("[AutoReply SW] 初始化失败:", e);
  }
}

function cleanDedupCache() {
  const now = Date.now();
  for (const [key, expire] of dedupCache) {
    if (now > expire) dedupCache.delete(key);
  }
  for (const [key, expire] of contentDedupCache) {
    if (now > expire) contentDedupCache.delete(key);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ pong: true });
    return true;
  }
  if (message.type === "NEW_DANMAKU") {
    handleDanmaku(message.data, sender.tab?.id)
      .then(r => { try { sendResponse(r); } catch (e) {} })
      .catch(e => { try { sendResponse({ replied: false, reason: "error" }); } catch (_) {} });
    return true;
  }
  if (message.type === "GET_STATUS") {
    getStatus().then(sendResponse).catch(() => sendResponse({ enabled: true }));
    return true;
  }
  if (message.type === "TOGGLE_ENABLED") {
    toggleEnabled(message.enabled).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === "RESET_STATS") {
    resetStats().then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  // ===== 监听模式（与自动回复完全隔离）=====
  if (message.type === "LISTEN_START") {
    startListening(message.tabId)
      .then(r => { try { sendResponse(r); } catch(e){} })
      .catch(e => { try { sendResponse({ ok: false, error: safeErr(e) }); } catch(_){} });
    return true;
  }
  if (message.type === "LISTEN_STOP") {
    stopListening()
      .then(r => { try { sendResponse(r); } catch(e){} })
      .catch(e => { try { sendResponse({ ok: false, error: safeErr(e) }); } catch(_){} });
    return true;
  }
  if (message.type === "LISTEN_STATUS") {
    ensureListenState().then(() => sendResponse({
      active: listenState.active,
      sessionId: listenState.sessionId,
      danmakuCount: listenState.danmakuCount,
      audioChunks: listenState.audioChunks,
      duration: listenState.active ? Date.now() - listenState.startTime : 0,
      lastError: listenState.lastError
    })).catch(() => sendResponse({ active: false }));
    return true;
  }
  if (message.type === "OFFSCREEN_CHUNK_SENT") {
    ensureListenState().then(() => {
      if (listenState.active && message.sessionId === listenState.sessionId) {
        listenState.audioChunks = message.sequence;
        return persistListenState();
      }
    });
    return false;
  }
  if (message.type === "OFFSCREEN_CAPTURE_ERROR") {
    ensureListenState().then(() => {
      if (listenState.active && message.sessionId === listenState.sessionId) {
        listenState.lastError = safeErr(message.error || "audio capture failed");
        return persistListenState();
      }
    });
    return false;
  }
});

async function handleDanmaku(danmaku, tabId) {
  await ensureListenState();
  // ★ 第二道防线：过滤无效弹幕
  // - 纯掩码用户名（如"康*****"、"相*****"）
  // - 空内容或仅冒号
  // - 内部状态消息
  const rawText = (danmaku.text || "").trim();
  if (!rawText || rawText.length === 0) {
    return { replied: false, reason: "empty_text" };
  }
  if (/^[\u4e00-\u9fff]{1,3}[\*＊★]{2,}/.test(rawText) && rawText.length <= 20) {
    return { replied: false, reason: "masked_username" };
  }
  if (rawText.includes("DOM扫描就绪") || rawText.includes("自动回复已启动")) {
    return { replied: false, reason: "internal_msg" };
  }

  // ★ 监听模式：转发弹幕到本地服务，完全跳过自动回复管线
  // 不匹配规则、不下发 DO_REPLY、不增加自动回复统计
  if (listenState.active) {
    forwardDanmakuToListenServer(danmaku).catch(e => {
      console.warn("[Listen] 弹幕转发失败:", safeErr(e));
    });
    return { replied: false, reason: "listen_mode" };
  }

  // ★ TASK-DANMAKU-001：主播号/水军号跳过（在 Service Worker 决策点）
  // 名单来自本机服务 accounts.json（已同步缓存在 chrome.storage.local）
  if (await shouldExcludeDanmaku(danmaku, tabId)) {
    return { replied: false, reason: "excluded_account" };
  }

  const { profiles, settings, stats } = await chrome.storage.local.get(["profiles", "settings", "stats"]);
  const currentSettings = settings || DEFAULT_SETTINGS;

  const newStats = { ...(stats || {}), total: ((stats || {}).total || 0) + 1 };
  chrome.storage.local.set({ stats: newStats }).catch(() => {});

  if (!currentSettings.enabled) return { replied: false, reason: "disabled" };

  const activeRules = getAllActiveRules(profiles);
  const matched = matchRules(danmaku.text, activeRules);

  // ★ 记录所有留言到公屏日志（含是否匹配和回复内容）
  const logEntry = {
    time: Date.now(),
    userName: danmaku.userName,
    userId: danmaku.userId,
    text: danmaku.text,
    matched: !!matched,
    ruleName: matched ? matched.rule.name : "",
    reply: ""
  };

  if (!matched) {
    addDanmakuLog(logEntry).catch(() => {});
    return { replied: false, reason: "no_match" };
  }

  cleanDedupCache();
  const dedupKey = `${danmaku.userId}_${matched.rule.id}`;
  if (dedupCache.has(dedupKey)) {
    addDanmakuLog({ ...logEntry, matched: false }).catch(() => {}); // 重复不计为匹配
    return { replied: false, reason: "dedup" };
  }

  // ★ 内容级去重：同一关键词触发的相似评论，30s 内只回复一条
  const contentDedupKey = `${matched.rule.id}_${matched.keyword}`;
  if (contentDedupCache.has(contentDedupKey)) {
    addDanmakuLog({ ...logEntry, matched: false }).catch(() => {});
    return { replied: false, reason: "content_dedup" };
  }

  const now = Date.now();
  if (now - rateWindow.windowStart > 60000) { rateWindow.count = 0; rateWindow.windowStart = now; }
  if (rateWindow.count >= (currentSettings.maxRepliesPerMinute || 10)) {
    addDanmakuLog(logEntry).catch(() => {});
    return { replied: false, reason: "rate_limit" };
  }

  const replyText = pickReply(matched.rule);
  if (!replyText) {
    addDanmakuLog(logEntry).catch(() => {});
    return { replied: false, reason: "empty_reply" };
  }

  let finalReply = replyText;
  if (currentSettings.atMention && danmaku.userName && danmaku.userName !== "用户") {
    finalReply = "@" + danmaku.userName + " " + replyText;
  }

  const delayMin = currentSettings.replyDelay?.min ?? 500;
  const delayMax = currentSettings.replyDelay?.max ?? 2000;
  const delay = delayMin + Math.random() * (delayMax - delayMin);

  dedupCache.set(dedupKey, Date.now() + (currentSettings.dedupWindow || 60) * 1000);
  contentDedupCache.set(contentDedupKey, Date.now() + (currentSettings.contentDedupWindow || 30) * 1000);
  rateWindow.count++;

  const finalStats = { ...newStats, matched: (newStats.matched || 0) + 1, replied: (newStats.replied || 0) + 1 };
  chrome.storage.local.set({ stats: finalStats }).catch(() => {});

  // 记录到留言日志（含回复内容）
  logEntry.reply = finalReply;
  addDanmakuLog(logEntry).catch(() => {});

  if (currentSettings.logHistory !== false) {
    addHistory({ time: Date.now(), userName: danmaku.userName, userId: danmaku.userId, danmaku: danmaku.text, matchedKeyword: matched.keyword, ruleName: matched.rule.name, reply: finalReply, delay: Math.round(delay) }).catch(() => {});
  }

  if (tabId) {
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: "DO_REPLY", text: finalReply, danmaku, keyword: matched.keyword })
        .catch(e => console.warn("[AutoReply SW] 发送失败:", e.message));
    }, delay);
  }

  console.log(`[AutoReply SW] "${danmaku.text}" → "${matched.keyword}" → "${finalReply}" (user:${danmaku.userName || "?"})`);
  return { replied: true, replyText: finalReply, delay: Math.round(delay) };
}

function matchRules(text, rules) {
  if (!text) return null;
  const lt = text.toLowerCase();
  for (const rule of rules) {
    for (const kw of rule.keywords) {
      const hit = rule.matchMode === "exact" ? lt.trim() === kw.toLowerCase().trim() : lt.includes(kw.toLowerCase());
      if (hit) return { rule, keyword: kw };
    }
  }
  return null;
}

const replyCounters = {};
function pickReply(rule) {
  if (!rule.replies?.length) return "";
  if (rule.replyMode === "sequential") {
    const idx = (replyCounters[rule.id] || 0) % rule.replies.length;
    replyCounters[rule.id] = idx + 1;
    return rule.replies[idx];
  }
  return rule.replies[Math.floor(Math.random() * rule.replies.length)];
}

async function addHistory(entry) {
  const { settings, history } = await chrome.storage.local.get(["settings", "history"]);
  const limit = settings?.historyLimit || 500;
  const newHistory = [entry, ...(history || [])].slice(0, limit);
  await chrome.storage.local.set({ history: newHistory });
}

const DANMAKU_LOG_LIMIT = 5000;
async function addDanmakuLog(entry) {
  const { danmakuLog } = await chrome.storage.local.get("danmakuLog");
  const log = [entry, ...(danmakuLog || [])].slice(0, DANMAKU_LOG_LIMIT);
  await chrome.storage.local.set({ danmakuLog: log });
}

async function getStatus() {
  const { settings, stats, profiles } = await chrome.storage.local.get(["settings", "stats", "profiles"]);
  return {
    enabled: settings?.enabled ?? true,
    stats: stats || { total: 0, matched: 0, replied: 0 },
    activeProfiles: (profiles || []).filter(p => p.enabled).map(p => p.name)
  };
}

async function toggleEnabled(enabled) {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...(settings || DEFAULT_SETTINGS), enabled } });
  const tabs = await chrome.tabs.query({ url: "*://live.douyin.com/*" });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "STATUS_CHANGED", enabled }).catch(() => {});
  }
  return { ok: true };
}

async function resetStats() {
  await chrome.storage.local.set({ stats: { total: 0, matched: 0, replied: 0, startTime: Date.now() } });
  return { ok: true };
}

// =============================================
// 监听模式函数（与自动回复完全隔离）
// =============================================

function safeErr(err) {
  const msg = (err && err.message) ? err.message : String(err || "unknown");
  return msg.replace(/(secretId|secretKey|appId|password|token)[^,\s]*/gi, "$1:***");
}

let offscreenDocCreated = false;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen/offscreen.html")]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (offscreenDocCreated) return;
  const existing = await hasOffscreenDocument();
  if (existing) { offscreenDocCreated = true; return; }
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "采集直播间标签页音频用于 ASR 转写"
  });
  offscreenDocCreated = true;
  console.log("[Listen] offscreen 文档已创建");
}

async function closeOffscreenDocument() {
  if (!offscreenDocCreated) return;
  try {
    const existing = await hasOffscreenDocument();
    if (existing) await chrome.offscreen.closeDocument();
  } catch (e) {
    console.warn("[Listen] 关闭 offscreen 文档失败:", e.message);
  }
  offscreenDocCreated = false;
}

async function startListening(tabId) {
  await ensureListenState();
  if (listenState.active) {
    return { ok: false, error: "already_listening" };
  }
  // 同步账号名单（失败不阻塞开播；无名单时不过滤）
  syncAccountsFromServer().catch(() => {});

  // 验证标签页是抖音直播页
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url || !tab.url.includes("live.douyin.com")) {
      return { ok: false, error: "not_live_tab" };
    }
  } catch (e) {
    return { ok: false, error: "tab_not_found" };
  }

  // 检查本地服务是否在线
  try {
    const healthResp = await fetch(`${LISTEN_LOCAL_SERVER}/health`, { method: "GET", signal: AbortSignal.timeout(3000) });
    if (!healthResp.ok) throw new Error("server unhealthy");
  } catch (e) {
    listenState.lastError = "local_service_offline";
    return { ok: false, error: "local_service_offline", hint: "请先启动本地监听服务 (cd listener && node server.js)" };
  }

  // 通知本地服务创建会话
  const sessionId = "session_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  try {
    const resp = await fetch(`${LISTEN_LOCAL_SERVER}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, tabId, startTime: Date.now() })
    });
    if (!resp.ok) throw new Error("session start failed");
  } catch (e) {
    listenState.lastError = safeErr(e);
    return { ok: false, error: "session_start_failed" };
  }

  // 获取 tab 音频 streamId
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    if (!streamId) throw new Error("no streamId");
  } catch (e) {
    await fetch(`${LISTEN_LOCAL_SERVER}/session/stop`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId })
    }).catch(() => {});
    return { ok: false, error: "capture_failed", hint: "无法获取标签页音频流" };
  }

  // 创建 offscreen 文档并发送采集指令
  await ensureOffscreenDocument();

  try {
    const offResp = await chrome.runtime.sendMessage({ type: "OFFSCREEN_START_CAPTURE", streamId, sessionId, tabId });
    if (!offResp?.ok) throw new Error(offResp?.error || "offscreen start failed");
  } catch (e) {
    await fetch(`${LISTEN_LOCAL_SERVER}/session/stop`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId })
    }).catch(() => {});
    await closeOffscreenDocument();
    return { ok: false, error: "offscreen_start_failed", hint: safeErr(e) };
  }

  listenState = {
    active: true,
    sessionId,
    tabId,
    startTime: Date.now(),
    danmakuCount: 0,
    audioChunks: 0,
    lastError: null
  };
  await persistListenState();

  console.log("[Listen] 监听已启动, sessionId:", sessionId, "tabId:", tabId);
  return { ok: true, sessionId };
}

async function stopListening() {
  await ensureListenState();
  if (!listenState.active) {
    return { ok: true, wasActive: false };
  }

  // 停止 offscreen 采集
  try {
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_CAPTURE" });
  } catch (e) {
    console.warn("[Listen] offscreen 停止失败:", safeErr(e));
  }

  // 通知本地服务结束会话
  try {
    await fetch(`${LISTEN_LOCAL_SERVER}/session/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: listenState.sessionId })
    });
  } catch (e) {
    console.warn("[Listen] 通知服务停止失败:", safeErr(e));
  }

  // 关闭 offscreen 文档
  await closeOffscreenDocument();

  const duration = Date.now() - listenState.startTime;
  console.log("[Listen] 监听已停止, 时长:", (duration/1000).toFixed(0) + "s, 弹幕:", listenState.danmakuCount, "音频段:", listenState.audioChunks);

  listenState = {
    active: false,
    sessionId: null,
    tabId: null,
    startTime: 0,
    danmakuCount: 0,
    audioChunks: 0,
    lastError: null
  };
  await persistListenState();

  return { ok: true };
}

async function forwardDanmakuToListenServer(danmaku) {
  await ensureListenState();
  if (!listenState.active || !listenState.sessionId) return;

  const offset = Date.now() - listenState.startTime;
  const payload = {
    sessionId: listenState.sessionId,
    offsetMs: offset,
    userName: danmaku.userName || "用户",
    userId: danmaku.userId || "user",
    text: danmaku.text,
    timestamp: Date.now()
  };

  try {
    const resp = await fetch(`${LISTEN_LOCAL_SERVER}/danmaku`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (resp.ok) {
      listenState.danmakuCount++;
      await persistListenState();
    } else {
      console.warn("[Listen] 弹幕写入失败:", resp.status);
    }
  } catch (e) {
    // 本地服务可能暂时不可用，不中断监听
    listenState.lastError = safeErr(e);
    await persistListenState();
  }
}

// 监听标签页关闭/导航 → 自动停止监听
chrome.tabs.onRemoved.addListener((tabId) => {
  if (listenState.active && listenState.tabId === tabId) {
    console.log("[Listen] 标签页已关闭, 自动停止监听");
    stopListening().catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => { initDefaults(); console.log("[AutoReply SW] 扩展已安装/更新"); });
initDefaults();
console.log("[AutoReply SW] Service Worker 已启动（多主播模式）");
