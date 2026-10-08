// =============================================
// 视频号直播助手 - Content Script v2.0
// channels.weixin.qq.com/.../liveBuild
// 基于抖音已验证的DOM扫描方案，适配视频号右面板评论
// =============================================

console.log("[📺视频号] ★★ V2重写版已加载 ★★");

(function () {
  "use strict";

  let isEnabled = true;
  let isInitialized = false;
  let scanCount = 0;
  const seenTexts = new Set();
  const POLL_INTERVAL = 2000;

  // =============================================
  // 评论扫描
  // =============================================
  function scanComments() {
    if (!isEnabled) return;
    scanCount++;

    const candidates = findCommentCandidates();

    for (const candidate of candidates) {
      const parsed = parseChatLine(candidate);
      if (!parsed) continue;

      // ★ 强去重：user + content 组合 + content-only 备选，三重保护
      const dedupKey = `${parsed.user || "_"}|${parsed.content.slice(0, 80)}`;
      const contentKey = `__${parsed.content.replace(/\s+/g, "").slice(0, 80)}`;
      if (seenTexts.has(dedupKey) || seenTexts.has(contentKey)) continue;
      seenTexts.add(dedupKey);
      seenTexts.add(contentKey);
      if (seenTexts.size > 5000) {
        const first = seenTexts.values().next().value;
        seenTexts.delete(first);
      }

      if (!isInitialized) {
        isInitialized = true;
        updateIndicatorUI(true);
        showToastUI("✅ 视频号评论扫描就绪", "success");
      }

      console.log(`[📺视频号] 评论 [${parsed.user}]: ${parsed.content}`);

      chrome.runtime.sendMessage({
        type: "NEW_DANMAKU",
        data: {
          text: parsed.content,
          userName: parsed.user || "用户",
          userId: parsed.user || "channels-user",
          timestamp: Date.now()
        }
      }).catch(() => {});
    }

    if (scanCount % 30 === 0) {
      cleanSeenTexts();
    }
  }

  // =============================================
  // 找评论候选 — 支持 Wujie 微前端沙箱
  // =============================================
  let diagDone = false;
  function findCommentCandidates() {
    const results = [];
    const vw = innerWidth, vh = innerHeight;
    const seen = new Set();
    const pageVisible = document.visibilityState === "visible";

    // 收集所有需要扫描的文档
    const docs = [document];

    // Wujie iframe 模式
    const wujieFrames = document.querySelectorAll("iframe");
    for (const frame of wujieFrames) {
      try {
        const fdoc = frame.contentDocument || frame.contentWindow?.document;
        if (fdoc && fdoc.body && fdoc.querySelectorAll("*").length > 50) {
          docs.push(fdoc);
        }
      } catch (e) {
        if (scanCount <= 3) console.warn("[📺视频号] iframe访问异常:", e.message.slice(0, 60));
      }
    }

    // ★ 也搜索主文档里的 shadow root（Wujie WebComponent 模式）
    function collectShadowRoots(root) {
      root.querySelectorAll("*").forEach(el => {
        if (el.shadowRoot) {
          try { docs.push(el.shadowRoot); } catch(e) {}
          collectShadowRoots(el.shadowRoot);
        }
      });
    }
    try { collectShadowRoots(document); } catch(e) {}

    for (const doc of docs) {
      try {
        const allEls = doc.querySelectorAll("*");
        for (const el of allEls) {
          const text = (el.textContent || "").trim().replace(/\s+/g, " ");
          if (!text) continue;
          if (seen.has(text)) continue;
          seen.add(text);

          const hasColon = text.includes("：") || text.includes(":");
          const hasChinese = /[\u4e00-\u9fff]/.test(text);
          const len = text.length;
          if (!hasChinese) continue;

          // 位置过滤
          if (pageVisible) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (rect.left < vw * 0.5) continue;
            if (rect.top < vh * 0.05 || rect.top > vh * 0.95) continue;
            if (rect.width > vw * 0.45) continue;
          }

          if (hasColon && len >= 3 && len <= 200) {
            results.push({ text, el });
          } else if (el.children.length === 0 && len >= 2 && len <= 200) {
            if (!isUIOnlyText(text)) {
              results.push({ text, el });
            }
          }
        }
      } catch (e) {
        console.warn("[📺视频号] 扫描文档异常:", e.message);
      }
    }

    // ★ 诊断：首轮3次后打印统计
    if (!diagDone && scanCount >= 3) {
      diagDone = true;
      let total = 0, chinese = 0, right = 0, colon = 0;
      document.querySelectorAll("*").forEach(el => {
        total++;
        const text = (el.textContent || "").trim();
        if (/[\u4e00-\u9fff]/.test(text)) {
          chinese++;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.left > vw * 0.5) {
            right++;
            if (text.includes("：") || text.includes(":")) colon++;
          }
        }
      });
      // ★ iframe 可访问性诊断
      const iframeStatuses = [];
      document.querySelectorAll("iframe").forEach((frame, i) => {
        try {
          const fdoc = frame.contentDocument || frame.contentWindow?.document;
          if (fdoc && fdoc.body) {
            const cnt = fdoc.querySelectorAll("*").length;
            iframeStatuses.push(`#${i}: ${cnt}el(可访问)`);
          } else {
            iframeStatuses.push(`#${i}: x-origin(跨域阻止)`);
          }
        } catch (e) { iframeStatuses.push(`#${i}: err(${e.message.slice(0,30)})`); }
      });
      console.log(`[📺视频号] 诊断: 总=${total} 中文=${chinese} 右侧=${right} 冒号=${colon} iframe=${wujieFrames.length} 窗口=${vw}x${vh}`);
      console.log(`[📺视频号] iframe可访问: ${iframeStatuses.join(" | ") || "无iframe"}`);
    }

    return results;
  }

  function cleanSeenTexts() {
    const entries = [...seenTexts];
    if (entries.length > 500) {
      seenTexts.clear();
      for (const e of entries.slice(-300)) seenTexts.add(e);
    }
  }

  // =============================================
  // 文本过滤 — 视频号专用 UI 黑名单 + 抖音通用规则
  // =============================================
  function isUIOnlyText(text) {
    const uiWords = [
      // 视频号助手特有 UI
      "评论", "回复", "助手发言", "发送", "清屏", "禁言",
      "在线观众", "观看人数", "热度", "点赞", "分享",
      "直播管理", "互动管理", "音乐", "音频", "草稿箱",
      "主页", "活动", "开播时间", "更多", "收起", "展开",
      "直播数据", "数据总览", "商品", "购物袋", "公告",
      "微信", "视频号", "视频号助手", "全部评论",
      "暂无评论", "暂时没有评论", "快来参与互动吧",
      "请输入", "搜索", "加载中", "帮助", "反馈",
      "设置", "简介", "选品", "讲解", "粉丝", "关注",
      "数据", "分析", "收入", "私信", "通知",
      // 视频号数据面板文案
      "成交金额", "成交订单", "成交人数", "成交件数", "退款金额",
      "总热度", "总观看", "新增粉丝", "最高在线", "平均在线",
      "在售", "已售", "库存", "讲解中", "待讲解",
      "当前在线人数", "开播时长", "最近一场回放观看人数",
      "特效创作工具", "自动字幕", "免费不限次数",
      // 抖音通用
      "精选", "推荐", "朋友", "我的", "放映厅", "短剧",
      "小游戏", "充钻石", "客户端", "壁纸", "投稿",
      "退出直播间", "刷新", "退出网页全屏", "开启小窗模式",
      "标清", "原画", "蓝光", "超清", "高清", "直播加载中",
      "小心心", "赠送", "人气票", "棒棒糖", "礼花筒",
      "大啤酒", "闪耀星辰", "鲜花", "玫瑰", "比心兔兔",
      "更多", "充值", "在线观众", "全部",
      "下载抖音精选", "下载抖音", "抖音电商", "抖音",
      "自动回复", "扫描中", "DOM扫描",
    ];
    const t = text.trim();
    if (uiWords.includes(t)) return true;

    // 掩码用户名
    if (/^[\u4e00-\u9fff]{1,3}[\*＊★]{2,}/.test(t) && t.length <= 20) return true;
    // 内部状态消息
    if (t.includes("评论扫描就绪") || t.includes("自动回复已启动")) return true;
    // 数据统计格式: "在售 268"、"¥9639.00"、"51 件"
    if (/^(在售|已售|成交|退款|观看|新增|最高)\s*\d/.test(t)) return true;
    if (/^[¥￥]\d/.test(t)) return true;
    if (/^\d+\s*(件|单|人|元|次)/.test(t)) return true;
    // 含数据指标的文本
    if (/(成交金额|成交订单|总热度|总观看|新增粉丝|最高在线)/.test(t) && t.length <= 30) return true;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return true;
    if (/^\d+$/.test(t)) return true;
    // 视频号系统通知
    if (/^(进入|关注|分享|送出|点赞|欢迎|来了|来到)/.test(t) && t.length <= 12) return true;
    // 太长的非对话文本
    if (t.length > 40 && !t.includes("：") && !t.includes(":")) return true;

    return false;
  }

  // ★ 独立用户名检测（从抖音版复制）
  function isStandaloneUsername(text) {
    if (/[\*＊★]{2,}/.test(text)) return true;
    if (/^[\u4e00-\u9fff]{2,5}$/.test(text)) {
      const shortChatWords = /^(多少|什么|怎么|哪里|几号|多大|链接|发货|快递|包邮|退货|换货|尺码|大小|颜色|价格|质量|你好|谢谢|再见|在吗|欢迎|加油|好看|不错|喜欢|真棒|可以|是的|好的|有了|没有|来了|走了|还行|不错|还有|主播|多少钱|啥价)$/;
      if (shortChatWords.test(text)) return false;
      return true;
    }
    if (/^[^\u4e00-\u9fff]{1,4}[\u4e00-\u9fff]{2,4}$/.test(text)) return true;
    return false;
  }

  function parseChatLine(candidate) {
    const text = candidate.text;

    // 模式1: "用户名：消息内容"
    const colonMatch = text.match(/^(.{1,20})[：:]\s*(.{0,200})$/);
    if (colonMatch) {
      const user = colonMatch[1].trim();
      const content = colonMatch[2].trim();
      if (!content || content.length === 0) return null;
      // ★ 过滤自己的回复（助手粉丝 / 助手发言）
      if (/助手/.test(user)) return null;
      if (isStandaloneUsername(content)) return null;
      if (isValidChat(content)) return { user, content };
    }

    // 模式2: 纯短文本
    // ★ 也过滤包含"助手粉丝 回复"的文本段
    if (/助手粉丝/.test(text)) return null;
    if (isStandaloneUsername(text)) return null;
    if (!isValidChat(text)) return null;
    if (text.length < 2 || text.length > 100) return null;
    if (/(进入|关注了|点赞了|送出|分享了|欢迎|来了)$/.test(text)) return null;

    return { user: "", content: text };
  }

  function isValidChat(text) {
    if (!text || text.length < 1 || text.length > 500) return false;
    if (!/[\u4e00-\u9fff]/.test(text)) return false;
    if (/^\d{8,}$/.test(text.replace(/\D/g, ""))) return false;
    if (/compress_type|server_time|internal_src|webcast|pushserver|cursor|gzip/.test(text)) return false;
    return true;
  }

  // =============================================
  // 发送回复 — 全面诊断模式
  // =============================================
  let inputDiagDone = false;
  async function sendReply(text) {
    const docs = [document];
    const statuses = [];
    document.querySelectorAll("iframe").forEach((frame, i) => {
      try {
        const fdoc = frame.contentDocument || frame.contentWindow?.document;
        if (fdoc && fdoc.body) {
          const cnt = fdoc.querySelectorAll("textarea, input:not([type='hidden']), [contenteditable]").length;
          statuses.push(`#${i}: ${cnt}inp/${fdoc.querySelectorAll("*").length}el`);
          docs.push(fdoc);
        } else {
          statuses.push(`#${i}: x-origin`);
        }
      } catch (e) { statuses.push(`#${i}: err`); }
    });
    // ★ 也搜索 shadow roots
    function collectShadowRoots(root) {
      root.querySelectorAll("*").forEach(el => {
        if (el.shadowRoot) {
          try { docs.push(el.shadowRoot); } catch(e) {}
          collectShadowRoots(el.shadowRoot);
        }
      });
    }
    try { collectShadowRoots(document); } catch(e) {}

    console.log("[📺视频号] iframe:", statuses.join(" | "));

    // ★ 首次诊断：全面搜索所有可能的输入元素
    if (!inputDiagDone) {
      inputDiagDone = true;
      const candList = [];
      for (const doc of docs) {
        const all = doc.querySelectorAll("*");
        for (const el of all) {
          const tag = el.tagName.toLowerCase();
          const cls = (el.className && typeof el.className === "string") ? el.className.toLowerCase() : "";
          const ph = (el.getAttribute("placeholder") || "").toLowerCase();
          const role = (el.getAttribute("role") || "").toLowerCase();
          const aria = (el.getAttribute("aria-label") || "").toLowerCase();
          const contenteditable = el.getAttribute("contenteditable");
          const type = (el.getAttribute("type") || "").toLowerCase();
          const id = (el.id || "").toLowerCase();
          const dataAttrs = [...(el.attributes || [])].filter(a => a.name.startsWith("data-")).map(a => `${a.name}=${a.value}`).join(";");

          // 匹配条件
          let score = 0;
          if (tag === "textarea" || tag === "input") score = 100;
          else if (contenteditable === "true" || contenteditable === "") score = 90;
          else if (role === "textbox" || role === "combobox" || role === "searchbox") score = 80;
          else {
            // 启发式：class/placeholder 含输入相关关键词
            const hits = ["comment", "chat", "reply", "message", "send", "editor",
              "发言", "评论", "输入", "聊天", "回复", "说点什么", "助手"];
            for (const h of hits) {
              if (cls.includes(h) || ph.includes(h) || id.includes(h) || aria.includes(h)) {
                score = 60; break;
              }
            }
          }

          if (score > 0) {
            const r = el.getBoundingClientRect();
            candList.push({
              el, score,
              tag, cls: cls.slice(0, 40), ph: ph.slice(0, 30),
              visible: r.width > 0 && r.height > 0,
              w: Math.round(r.width), h: Math.round(r.height),
              x: Math.round(r.left), y: Math.round(r.top),
              docRef: doc === document ? "main" : (docs.indexOf(doc) + "")
            });
          }
        }
      }
      candList.sort((a, b) => b.score - a.score);
      console.log(`[📺视频号] 🔍 输入框全面诊断 (共${candList.length}个候选):`);
      candList.forEach((c, i) => {
        if (i < 20) {
          console.log(`  #${i} [${c.docRef}] <${c.tag}> cls="${c.cls}" ph="${c.ph}" visible=${c.visible} ${c.w}x${c.h} @(${c.x},${c.y}) score=${c.score}`);
        }
      });
      if (candList.length === 0) {
        console.warn("[📺视频号] 🔍 未找到任何输入候选！将列出所有右侧区域元素:");
        const rightEls = [];
        for (const doc of docs) {
          doc.querySelectorAll("*").forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && r.left > innerWidth * 0.5 && r.top < innerHeight * 0.95) {
              const txt = (el.textContent || "").trim().slice(0, 30);
              const cls = (typeof el.className === "string") ? el.className.slice(0, 30) : "";
              if (el.children.length <= 1 && txt) {
                rightEls.push({ tag: el.tagName, cls, txt, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) });
              }
            }
          });
        }
        console.table(rightEls.slice(0, 30));
      }
    }

    // 常规查找（包括全面诊断中发现的所有候选）
    const allInputs = [];
    for (const doc of docs) {
      allInputs.push(
        ...doc.querySelectorAll("textarea"),
        ...doc.querySelectorAll("input[type='text'], input:not([type])"),
        ...doc.querySelectorAll("[contenteditable='true']"),
        ...doc.querySelectorAll("div[role='textbox']"),
      );
    }

    console.log("[📺视频号] 找到输入框候选:", allInputs.length, "个");
    allInputs.forEach((el, i) => {
      if (i < 5) {
        const r = el.getBoundingClientRect();
        console.log(`  #${i} ${el.tagName} placeholder="${el.getAttribute("placeholder")||""}" visible=${r.width>0&&r.height>0} @(${Math.round(r.left)},${Math.round(r.top)})`);
      }
    });

    const inputs = allInputs.filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    let best = null, bestScore = -1;
    for (const el of inputs) {
      let score = 0;
      const r = el.getBoundingClientRect();
      const ph = (el.getAttribute("placeholder") || "").toLowerCase();
      if (ph.includes("发言") || ph.includes("助手")) score += 50;
      if (r.top > innerHeight * 0.5) score += 3;
      if (el.tagName === "TEXTAREA") score += 2;
      if (r.width < 600) score += 1;
      if (score > bestScore) { bestScore = score; best = el; }
    }

    if (!best) {
      console.warn("[📺视频号] 未找到输入框");
      return false;
    }

    console.log("[📺视频号] 输入框:", best.tagName, best.getAttribute("placeholder"), best.getBoundingClientRect());

    try {
      best.focus();
      if (best.isContentEditable || best.getAttribute("contenteditable") === "true") {
        best.textContent = "";
        best.focus();
        (best.ownerDocument || document).execCommand("insertText", false, text);
        best.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        const proto = best.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(best, text);
        else best.value = text;
        best.dispatchEvent(new Event("input", { bubbles: true }));
        best.dispatchEvent(new Event("change", { bubbles: true }));
      }

      await sleep(400);

      // 找"发送"按钮
      const sendCandidates = [];
      for (const doc of docs) {
        const btns = doc.querySelectorAll("button, [role='button'], span, div");
        for (const el of btns) {
          const txt = (el.textContent || "").trim();
          if (txt === "发送" || txt === "Send") {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && r.width < 200) {
              // 找真正的可点击元素：如果 el 包含 clickable 子元素，用子元素
              const childBtn = el.querySelector("button, [role='button'], .btn, [class*='send']");
              const target = childBtn || el;
              sendCandidates.push({ el: target, right: r.right, bottom: r.bottom, parentTag: el.tagName });
            }
          }
        }
      }
      sendCandidates.sort((a, b) => (b.right + b.bottom) - (a.right + a.bottom));

      if (sendCandidates.length > 0) {
        const { el: btn, parentTag } = sendCandidates[0];
        const r = btn.getBoundingClientRect();
        console.log(`[📺视频号] 发送按钮: <${btn.tagName}> cls="${(btn.className||'')}" parent=${parentTag} @(${Math.round(r.left)},${Math.round(r.top)}) ${Math.round(r.width)}x${Math.round(r.height)}`);
        
        // 方法1: PointerEvents (React 17+)
        btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true }));
        btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true }));
        btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        if (typeof btn.click === "function") btn.click();
        await sleep(300);

        // 方法2: 如果还没发出去，按 Enter 键
        best.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true, composed: true
        }));
        best.dispatchEvent(new KeyboardEvent("keyup", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true, composed: true
        }));
        await sleep(200);
      } else {
        // 找不到按钮，直接 Enter
        best.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true, composed: true
        }));
        best.dispatchEvent(new KeyboardEvent("keyup", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true, composed: true
        }));
        await sleep(200);
      }

      console.log("[📺视频号] 发送完成:", text.slice(0, 20));
      return true;
    } catch (e) {
      console.error("[📺视频号] 发送失败:", e.message);
      return false;
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // =============================================
  // UI
  // =============================================
  function createIndicator() {
    if (document.getElementById("channels-auto-reply-indicator")) return;
    const el = document.createElement("div");
    el.id = "channels-auto-reply-indicator";
    Object.assign(el.style, {
      position: "fixed", bottom: "100px", right: "16px", zIndex: "99999999",
      background: "rgba(0,0,0,0.78)", color: "#fff", padding: "6px 14px",
      borderRadius: "20px", display: "flex", alignItems: "center", gap: "8px",
      fontFamily: '-apple-system,"Microsoft YaHei",sans-serif', fontSize: "12px",
      cursor: "pointer", userSelect: "none", transition: "all .3s",
      boxShadow: "0 2px 12px rgba(0,0,0,0.5)", border: "1px solid rgba(255,255,255,0.1)"
    });
    el.innerHTML = '<div id="car-dot" style="width:8px;height:8px;border-radius:50%;background:#07C160;flex-shrink:0;transition:background .3s;"></div><span id="car-text">扫描中...</span>';
    el.title = "点击切换自动回复开关";
    el.addEventListener("click", () => {
      isEnabled = !isEnabled;
      updateIndicatorUI(isEnabled);
      chrome.runtime.sendMessage({ type: "TOGGLE_ENABLED", enabled: isEnabled }).catch(() => {});
      showToastUI(isEnabled ? "✅ 已开启" : "⏸ 已暂停", isEnabled ? "success" : "warn");
    });
    document.body.appendChild(el);
    console.log("[📺视频号] UI 指示灯已创建");
  }

  function updateIndicatorUI(enabled) {
    const dot = document.getElementById("car-dot");
    const text = document.getElementById("car-text");
    if (!dot || !text) return;
    dot.style.background = isInitialized ? (enabled ? "#07C160" : "#888") : "#FF9800";
    text.textContent = isInitialized ? (enabled ? "视频号自动回复 ✓" : "已暂停") : `扫描中(第${scanCount}轮)...`;
  }

  function showToastUI(msg, type) {
    const colors = { success: "#07C160", error: "#f44336", info: "#2196F3", warn: "#FF9800" };
    const t = document.createElement("div");
    Object.assign(t.style, {
      position: "fixed", bottom: "150px", right: "16px", zIndex: "99999999",
      background: colors[type] || "#2196F3", color: "#fff",
      padding: "8px 16px", borderRadius: "8px", fontSize: "13px",
      fontFamily: '-apple-system,"Microsoft YaHei",sans-serif',
      opacity: "0", transition: "opacity .3s", pointerEvents: "none",
      maxWidth: "300px", wordBreak: "break-word", boxShadow: "0 2px 8px rgba(0,0,0,0.3)"
    });
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = "1"; });
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 3500);
  }

  // =============================================
  // 收 background 指令
  // =============================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "DO_REPLY") {
      sendReply(msg.text).then(ok => {
        sendResponse({ ok });
        showToastUI(ok ? `💬 ${msg.text.slice(0, 20)}` : "⚠️ 回复失败", ok ? "success" : "error");
      });
      return true;
    }
    if (msg.type === "STATUS_CHANGED") {
      isEnabled = msg.enabled;
      updateIndicatorUI(isEnabled);
      sendResponse({ ok: true });
    }
    if (msg.type === "GET_INIT_STATUS") {
      sendResponse({
        initialized: isInitialized,
        enabled: isEnabled,
        pipActive: false,
        scanCount: scanCount
      });
    }
  });

  // =============================================
  // 入口
  // =============================================
  chrome.runtime.sendMessage({ type: "GET_STATUS" })
    .then(res => { if (res) isEnabled = res.enabled ?? true; })
    .catch(() => {});

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      createIndicator();
      updateIndicatorUI(isEnabled);
      startScanner();
    });
  } else {
    createIndicator();
    updateIndicatorUI(isEnabled);
    startScanner();
  }

  let scanTimer = null;
  let scannerRunning = false;

  function startScanner() {
    setTimeout(() => {
      console.log("[📺视频号] 评论扫描器启动 (间隔" + POLL_INTERVAL + "ms)");
      scannerRunning = true;
      scheduleScan();

      // 定时保活 ping
      setInterval(() => {
        chrome.runtime.sendMessage({ type: "PING" }).catch(() => {});
      }, 20000);
    }, 3000);
  }

  function scheduleScan() {
    if (!scannerRunning) return;
    scanTimer = setTimeout(() => {
      scanComments();
      scheduleScan();
    }, POLL_INTERVAL);
  }

  // 兜底UI
  setTimeout(() => {
    if (!document.getElementById("channels-auto-reply-indicator")) {
      createIndicator();
      updateIndicatorUI(isEnabled);
    }
  }, 5000);

  setInterval(() => updateIndicatorUI(isEnabled), 3000);
})();
