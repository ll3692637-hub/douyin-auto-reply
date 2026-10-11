// =============================================
// product_parse.js — 直播页讲解商品卡解析（TASK-PRODUCT-001 修订版）
// 只记录"讲解商品卡"的换品节点；不读取购物车、不自动点击、不跳转。
// 被 manifest content_scripts 先于 content.js 加载，提供全局函数。
// Node 测试通过 vm 加载本文件验证（见 listener/test/mock_test.js）。
// SW 侧的 productKey/shouldRecordSwitch 为精简复刻，修改时保持一致。
// =============================================

// 讲解商品卡候选选择器（按优先级）；未命中走"讲解中"文本模式，仍无则返回 null
const PRODUCT_SELECTOR_CANDIDATES = [
  '[data-e2e="live-product-card"]',
  ".live-product-card",
  '[class*="product-explain"]',
  '[class*="explain-product"]'
];

/**
 * 价格提取：priceText 保留页面原文；price 只有明确数值时才填
 * 锁价优先：同卡同时出现 ¥199 与 ??3元 时取 ??3元（price 为 null）
 * "券后价¥149" → { priceText: "券后价¥149", price: "149" }
 * "??9元" / "199~299元" / "到手价待公布" → { priceText: 原文, price: null }
 */
function extractPrice(text) {
  // 锁价/占位优先：??3元、?999元、??元 —— 带 ? 一律视为锁价
  let m = text.match(/\?+\s*\d*(?:\.\d+)?\s*元/);
  if (m) return { priceText: m[0].trim(), price: null };
  m = text.match(/(券后价\s*)?[¥￥]\s*(\d+(?:\.\d+)?)/);
  if (m) return { priceText: m[0].trim(), price: m[2] };
  m = text.match(/\d+(?:\.\d+)?\s*[-~～]\s*\d+(?:\.\d+)?\s*元/); // 范围价
  if (m) return { priceText: m[0].trim(), price: null };
  m = text.match(/(到手价待公布|价格待定|待公布|暂未定价)/);
  if (m) return { priceText: m[1], price: null };
  return { priceText: null, price: null };
}

/**
 * 从商品卡根节点提取字段（只读 DOM，不点击）
 * 返回 { id, link, name, price, priceText, seq, source, rawText }；提不出 name 则返回 null
 */
function extractProductFromCard(root) {
  let text = "";
  try { text = (root.innerText || "").replace(/[\s]+/g, " ").trim(); } catch (e) {}
  if (!text) return null;

  const { priceText, price } = extractPrice(text);

  // 链接 / ID：卡片内的商品链接（只读 href，不跳转）
  let link = null, id = null;
  try {
    const a = root.querySelector("a[href]");
    if (a && a.href) {
      link = String(a.href);
      const im = link.match(/product\/(\d+)/i) || link.match(/[?&](?:product[_-]?id|id)=(\w+)/i);
      if (im) id = im[1];
    }
  } catch (e) {}

  // 序号："1号" / "商品1"
  let seq = null;
  const sm = text.match(/(\d+)\s*号/);
  if (sm) seq = sm[1];

  // 名称：去掉价格原文后的行里取最长的一行（过滤讲解中/购买按钮等）
  let name = null;
  try {
    const lines = (root.innerText || "").split("\n").map(s =>
      s.replace(/(券后价\s*)?[¥￥]\s*[\d.]+/g, "").replace(/\?+\s*[\d.]*\s*元/g, "").trim()
    ).filter(Boolean);
    const bad = /^(讲解中|正在讲解|券后价|去购买|立即购买|加入购物车|看全部|.*商品详情.*)$/;
    const cands = lines.filter(l =>
      l.length >= 2 && l.length <= 60 && !bad.test(l) && !/^\d+\s*号$/.test(l)
    );
    cands.sort((a, b) => b.length - a.length);
    name = cands[0] || null;
  } catch (e) {}

  if (!name) return null; // 名称是展示与兜底标识的必需项
  return { id, link, name, price, priceText, seq, source: "讲解商品卡", rawText: text.slice(0, 200) };
}

/**
 * 讲解商品卡根节点定位
 * 2026-10-11 实机确认："讲解中"是图片（img[src*="jiangjiezhong"]），不是文字；
 * 用该语义化资源名做锚点，向上找到含标题+价格的卡片容器。
 */
function findProductCardRoot(d) {
  try {
    const badge = d.querySelector('img[src*="jiangjiezhong"]');
    if (badge) {
      let scope = badge.parentElement;
      for (let i = 0; i < 5 && scope; i++) {
        const t = scope.innerText || "";
        if (t.length > 10 && /[¥￥]/.test(t)) return scope; // 含价格的容器
        scope = scope.parentElement;
      }
      // 兜底：badge 往上 3 层
      scope = badge;
      for (let i = 0; i < 3 && scope.parentElement; i++) scope = scope.parentElement;
      return scope;
    }
  } catch (e) {}
  // 备选："券后价"文本锚点
  try {
    const els = d.querySelectorAll("span, div");
    for (const el of els) {
      const txt = (el.innerText || "").trim();
      if (!/券后价/.test(txt) || txt.length > 40) continue;
      let scope = el.parentElement;
      for (let i = 0; i < 4 && scope; i++) {
        if ((scope.innerText || "").length > 20) return scope;
        scope = scope.parentElement;
      }
    }
  } catch (e) {}
  return null;
}

/**
 * 读取讲解商品卡（在 content script 上下文中调用）
 * 返回 { product, matchedSelector, debugHint }
 */
function parseProductCard(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d) return { product: null, matchedSelector: null, debugHint: null };

  // 1. 候选选择器
  for (const sel of PRODUCT_SELECTOR_CANDIDATES) {
    let el = null;
    try { el = d.querySelector(sel); } catch (e) { continue; }
    if (el) {
      const p = extractProductFromCard(el);
      if (p) return { product: p, matchedSelector: sel, debugHint: null };
    }
  }

  // 2. 讲解中角标图片锚点（实机 pin）
  const root = findProductCardRoot(d);
  if (root) {
    const p = extractProductFromCard(root);
    if (p) return { product: p, matchedSelector: 'img[src*="jiangjiezhong"]', debugHint: null };
    return { product: null, matchedSelector: null,
      debugHint: ("card:" + (root.innerText || "").replace(/[\s]+/g, " ")).slice(0, 80) };
  }

  return { product: null, matchedSelector: null, debugHint: null };
}

/**
 * 稳定标识：优先商品 ID 或链接；没有时用"名称＋价格"；不可靠时返回 null（不猜）
 */
function productKey(p) {
  if (!p) return null;
  if (p.id) return "id:" + p.id;
  if (p.link) return "link:" + p.link;
  if (p.name && p.price) return "np:" + p.name + "|" + p.price;
  return null;
}

/**
 * 是否产生换品节点：key 有效且与上次不同（A→B→A 每次都算新的）
 */
function shouldRecordSwitch(lastKey, key) {
  return !!(key && key !== lastKey);
}

/**
 * 商品节点状态机（权威定义，SW 侧精简复刻，修改时保持一致）
 * 给定上次 (lastKey, lastPriceText) 与本次 (key, priceText)，
 * 返回 "product_switch" | "price_update" | null（无变化/标识不可靠）
 * - key 变化 → product_switch（并重置该商品的价格状态）
 * - key 相同且读到新的非空 priceText → price_update（如锁价 ??3元 → 实价 ¥199）
 * - key 相同但本轮价格暂时读不到 → null（保留上次价格状态，避免 DOM 闪动制造噪声）
 * - key 相同且 priceText 相同 → null
 */
function decideProductNode(lastKey, lastPriceText, key, priceText) {
  if (!key) return null;
  if (key !== lastKey) return "product_switch";
  // 商品卡在切换动画或页面重绘中可能暂时不含价格；这不是价格更新。
  if (!priceText) return null;
  if ((priceText || null) !== (lastPriceText || null)) return "price_update";
  return null;
}
