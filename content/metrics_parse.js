// =============================================
// metrics_parse.js — 直播页趋势指标解析
// 被 manifest content_scripts 先于 content.js 加载，提供全局函数。
// Node 测试通过 vm 加载本文件验证 parseOnlineText（见 listener/test/mock_test.js）。
// 修改解析逻辑时，保证两边一致。
// =============================================

// 在线人数候选选择器（按优先级逐个尝试；命中即停，并记录 selector 供首轮实机校准）
// 注意：抖音 web 页面结构常变，候选未命中时走文本模式兜底，仍无则存 null（不猜）。
const ONLINE_SELECTOR_CANDIDATES = [
  '[data-e2e="live-room-view-count"]',
  ".live-room-view-count",
  '[class*="view-count"]',
  '[class*="audience-count"]'
];

/**
 * 解析在线人数文本 → { value, raw } 或 null
 * "1.2万人" → 12000；"860人" → 860；"1.2万人在看" → 12000
 */
function parseOnlineText(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return null;
  const t = raw.replace(/[\s,，]/g, "");
  let m = t.match(/([\d.]+)万人在看/);
  if (m) return { value: Math.round(parseFloat(m[1]) * 10000), raw };
  m = t.match(/([\d.]+)人在看/);
  if (m) return { value: Math.round(parseFloat(m[1])), raw };
  // 无"人在看"后缀的万/人：只在选择器命中的元素上使用（调用方保证作用域）
  m = t.match(/^([\d.]+)万$/);
  if (m) return { value: Math.round(parseFloat(m[1]) * 10000), raw };
  m = t.match(/^([\d.]+)人$/);
  if (m) return { value: Math.round(parseFloat(m[1])), raw };
  return null;
}

/**
 * 从直播页 DOM 读取趋势指标（在 content script 上下文中调用）。
 * 返回 { metrics, rawMetrics, matchedSelector, debugHint }；无稳定数据时对应项为 null。
 * debugHint：找到"在线观众"标签但解析不出数字时，记一小段上下文供校准（本地诊断用）。
 */
function tryParseOnlineScope(text) {
  const t = String(text || "").replace(/[\s,，]/g, "");
  let m = t.match(/([\d.]+)万人在看/) || t.match(/([\d.]+)人在看/);
  if (m) return parseOnlineText(m[0]);
  m = t.match(/在线(观众|人数)[\s:：]*([\d.]+万?人?)/);
  if (m) return parseOnlineText(m[2]);
  return null;
}

function readVisualMetrics(doc) {
  const result = {
    metrics: { online: null, enter: null, leave: null },
    rawMetrics: { online: null, enter: null, leave: null },
    matchedSelector: null,
    debugHint: null
  };
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d) return result;

  // 1. 候选选择器逐个尝试
  for (const sel of ONLINE_SELECTOR_CANDIDATES) {
    let el = null;
    try { el = d.querySelector(sel); } catch (e) { continue; }
    if (el && el.innerText) {
      const parsed = parseOnlineText(el.innerText);
      if (parsed) {
        result.metrics.online = parsed.value;
        result.rawMetrics.online = parsed.raw;
        result.matchedSelector = sel;
        return result;
      }
    }
  }

  // 2. 文本模式扫描：限定小元素，避免误命中弹幕/价格
  try {
    const els = d.querySelectorAll("span, div, p");
    for (const el of els) {
      const txt = (el.innerText || "").trim();
      if (!txt || txt.length > 60) continue;
      if (!/在线观众|在线人数|人在看/.test(txt)) continue;
      let parsed = tryParseOnlineScope(txt);
      if (!parsed && el.nextElementSibling && el.nextElementSibling.innerText) {
        const sibTxt = el.nextElementSibling.innerText.trim();
        // 兄弟节点通常就是"在线观众"标签后的数字（如 "1.2万"）
        parsed = tryParseOnlineScope(sibTxt) || parseOnlineText(sibTxt);
      }
      if (!parsed && el.parentElement && el.parentElement.innerText && el.parentElement.innerText.length < 160) {
        parsed = tryParseOnlineScope(el.parentElement.innerText);
      }
      if (parsed) {
        result.metrics.online = parsed.value;
        result.rawMetrics.online = parsed.raw;
        result.matchedSelector = "text-pattern:在线";
        return result;
      }
      // 找到标签但无数字：记上下文供校准
      if (!result.debugHint && /在线观众|在线人数/.test(txt)) {
        result.debugHint = txt.slice(0, 60);
      }
    }
  } catch (e) { /* 忽略 */ }

  // 3. 进房/离开：页面无稳定聚合值，按任务要求存 null，不推断
  return result;
}
