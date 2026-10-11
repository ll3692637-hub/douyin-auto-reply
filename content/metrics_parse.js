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
 * 返回 { metrics, rawMetrics, matchedSelector }；无稳定数据时对应项为 null。
 */
function readVisualMetrics(doc) {
  const result = {
    metrics: { online: null, enter: null, leave: null },
    rawMetrics: { online: null, enter: null, leave: null },
    matchedSelector: null
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

  // 2. 兜底：文本模式扫描（要求"人在看"后缀，避免误命中弹幕/价格数字）
  try {
    const els = d.querySelectorAll("span, div, p");
    for (const el of els) {
      const txt = (el.innerText || "").trim();
      if (!txt || txt.length > 24) continue;
      if (!/人在看/.test(txt)) continue;
      const parsed = parseOnlineText(txt);
      if (parsed) {
        result.metrics.online = parsed.value;
        result.rawMetrics.online = parsed.raw;
        result.matchedSelector = "text-pattern:人在看";
        return result;
      }
    }
  } catch (e) { /* 忽略 */ }

  // 3. 进房/离开：页面无稳定聚合值，按任务要求存 null，不推断
  return result;
}
