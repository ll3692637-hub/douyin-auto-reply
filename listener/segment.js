// =============================================
// segment.js — 按换品节点生成直播复盘分段（TASK-SEGMENT-001）
// 纯函数，无 DOM 依赖；UMD 导出：Node 测试 require，浏览器端 <script src="/segment.js">。
//
// buildSegments(timeline, info):
// - timeline: [{ kind: "transcript"|"danmaku"|"visual"|"product", at: offsetMs, data }]
//   （product 的 data.type 为 "product_switch" | "price_update"；缺 type 的旧数据视为 switch）
// - info: { startTime, endTime }（时间戳；endTime 为 null 表示进行中）
// - 返回 segments: [{ index, startMs, endMs|null, product|null, priceUpdates: [], items: [] }]
//
// 规则：
// 1. 每个 product_switch 对应一个片段；片段结束于下一次 product_switch；
//    最后一段结束于本场结束时间（进行中则 endMs 为 null）。
// 2. price_update 归入当前片段的价格更新，不另起片段。
// 3. 无换品节点 → 单个片段，product 为 null（展示为"未识别商品的时间段"），仍含全部证据。
// 4. 时间边界 [startMs, endMs)：换品节点本身在片段头部展示，不计入 items。
// 5. 不做 AI 判断、不评价、不推断因果；类目通用。
// =============================================

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.LiveSegments = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function nodeType(p) {
    // 缺 type 的旧数据视为 product_switch（服务端现已默认填充）
    return (p && p.type === "price_update") ? "price_update" : "product_switch";
  }

  function buildSegments(timeline, info) {
    const tl = Array.isArray(timeline)
      ? timeline.slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); })
      : [];
    const startTime = (info && info.startTime) ? info.startTime : 0;
    const sessionEndMs = (info && info.endTime)
      ? Math.max(0, info.endTime - startTime)
      : null;

    // 换品节点（按时间排序）
    const switches = [];
    for (const x of tl) {
      if (x.kind === "product" && nodeType(x.data) === "product_switch") {
        switches.push({ at: x.at || 0, data: x.data });
      }
    }

    let segments;
    if (!switches.length) {
      // 无换品节点：整场为"未识别商品的时间段"，仍展示全部证据
      segments = [{ index: 0, startMs: 0, endMs: sessionEndMs, product: null, priceUpdates: [], items: [] }];
    } else {
      segments = switches.map(function (s, i) {
        return {
          index: i,
          startMs: i === 0 ? 0 : s.at, // 首片段从开场起算，避免 at≈0 的换品产生空片段
          endMs: (i + 1 < switches.length) ? switches[i + 1].at : sessionEndMs,
          product: s.data,
          priceUpdates: [],
          items: []
        };
      });
    }

    // 按 [startMs, endMs) 归属
    for (const x of tl) {
      const at = x.at || 0;
      let seg = segments[segments.length - 1];
      for (const s of segments) {
        if (at >= s.startMs && (s.endMs == null || at < s.endMs)) { seg = s; break; }
      }
      if (x.kind === "product") {
        if (nodeType(x.data) === "price_update") seg.priceUpdates.push(x.data);
        // product_switch 本体在片段头部展示，不计入 items
      } else {
        seg.items.push(x);
      }
    }

    return segments;
  }

  return { buildSegments: buildSegments };
});
