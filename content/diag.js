// =============================================
// diag.js — 直播页结构诊断（TASK-DOM-DIAGNOSTIC-001）
// 用户在直播页点击"页面诊断"后，采集讲解商品卡与在线人数附近的
// 标签结构、class/data 属性、有限长度可见文字、可复用选择器建议。
//
// 脱敏铁律：
// - 只取目标容器附近的结构与截断文本；
// - 不读取 cookie、localStorage、请求头，不采集弹幕全文、私信、完整用户列表；
// - 单段文字/属性值限制长度；
// - 结果只存本机（POST /diagnostic → sessions/_diagnostic/），绝不提交 Git。
//
// 被 manifest content_scripts 在 product_parse.js 之后加载，提供 runPageDiagnostic。
// =============================================

const DIAG_TEXT_LIMIT = 120;
const DIAG_ATTR_LIMIT = 60;

function diagTruncate(v, limit) {
  return String(v == null ? "" : v).slice(0, limit == null ? DIAG_TEXT_LIMIT : limit);
}

function diagDescribe(el) {
  if (!el || el.nodeType !== 1) return null;
  const desc = { tag: el.tagName.toLowerCase() };
  if (el.id) desc.id = diagTruncate(el.id, DIAG_ATTR_LIMIT);
  try {
    const cls = (typeof el.className === "string" ? el.className : "").split(/\s+/).filter(Boolean).slice(0, 4);
    if (cls.length) desc.class = cls;
  } catch (e) {}
  const data = {};
  try {
    for (const a of el.attributes) {
      if (!a.name || a.name.indexOf("data-") !== 0) continue;
      if (/token|key|auth|secret|session|cookie/i.test(a.name)) continue; // 保守跳过敏感命名
      data[a.name] = diagTruncate(a.value, DIAG_ATTR_LIMIT);
    }
  } catch (e) {}
  if (Object.keys(data).length) desc.data = data;
  return desc;
}

function diagAncestors(el, levels) {
  const chain = [];
  let p = null;
  try { p = el.parentElement; } catch (e) { return chain; }
  for (let i = 0; i < (levels || 3) && p; i++) {
    chain.push(diagDescribe(p));
    try { p = p.parentElement; } catch (e) { break; }
  }
  return chain;
}

function diagSuggestSelector(el) {
  if (!el) return null;
  try {
    const e2e = el.getAttribute && el.getAttribute("data-e2e");
    if (e2e) return '[data-e2e="' + e2e + '"]';
    if (el.id) return "#" + el.id;
    const cls = (typeof el.className === "string" ? el.className : "").split(/\s+/).filter(Boolean);
    if (cls.length) return el.tagName.toLowerCase() + "." + cls.slice(0, 2).join(".");
    return el.tagName.toLowerCase();
  } catch (e) { return null; }
}

function diagVisibleText(el) {
  try {
    return (el.innerText || "").replace(/[\s]+/g, " ").trim().slice(0, DIAG_TEXT_LIMIT);
  } catch (e) { return ""; }
}

/**
 * 在直播页执行结构诊断（content script 上下文）。
 * 返回 { timestamp, url, productCard: {...}, onlineCount: {...} }
 */
function runPageDiagnostic() {
  const d = typeof document !== "undefined" ? document : null;
  const result = {
    timestamp: new Date().toISOString(),
    url: "",
    productCard: { found: false },
    onlineCount: { found: false }
  };
  if (!d) return result;
  try { result.url = location.hostname + location.pathname; } catch (e) {}

  // 1. 讲解商品卡（复用 product_parse.js 的定位逻辑）
  try {
    const root = (typeof findProductCardRoot === "function") ? findProductCardRoot(d) : null;
    if (root) {
      const item = {
        found: true,
        self: diagDescribe(root),
        ancestors: diagAncestors(root, 3),
        text: diagVisibleText(root),
        suggestedSelector: diagSuggestSelector(root)
      };
      try {
        const badge = d.querySelector('img[src*="jiangjiezhong"]');
        if (badge) {
          const src = badge.getAttribute("src") || "";
          item.badge = {
            self: diagDescribe(badge),
            srcTail: src.slice(-80), // 只保留尾部，确认资源名
            suggestedSelector: 'img[src*="jiangjiezhong"]'
          };
        }
      } catch (e) {}
      // 价格容器：含 ¥ 的子节点
      try {
        const all = root.querySelectorAll("span, div");
        for (const s of all) {
          const t = (s.innerText || "").trim();
          if (/[¥￥]/.test(t) && t.length < 40 && s.children.length <= 3) {
            item.priceNode = {
              self: diagDescribe(s),
              text: diagTruncate(t, 40),
              suggestedSelector: diagSuggestSelector(s)
            };
            break;
          }
        }
      } catch (e) {}
      result.productCard = item;
    }
  } catch (e) {}

  // 2. 在线人数（复用 metrics_parse.js 的候选选择器）
  try {
    const cands = (typeof ONLINE_SELECTOR_CANDIDATES !== "undefined") ? ONLINE_SELECTOR_CANDIDATES : [];
    let el = null, hitSel = null;
    for (const sel of cands) {
      try { el = d.querySelector(sel); } catch (e) { el = null; }
      if (el && (el.innerText || "").trim()) { hitSel = sel; break; }
    }
    if (el) {
      result.onlineCount = {
        found: true,
        self: diagDescribe(el),
        ancestors: diagAncestors(el, 3),
        text: diagTruncate((el.innerText || "").trim(), 20),
        hitSelector: hitSel,
        suggestedSelector: diagSuggestSelector(el)
      };
    }
  } catch (e) {}

  return result;
}
