// =============================================
// 抖音直播自动回复 - Content Script v4.0
// 双通道：DOM轮询扫描（主通道）+ WebSocket拦截（辅助）
// =============================================

console.log("[🎯抖音] Content Script v4 已加载");

(function () {
  "use strict";

  let isEnabled = true;
  let isInitialized = false;
  let scanCount = 0;
  const seenTexts = new Set();
  const POLL_INTERVAL = 1500; // 每1.5秒扫描一次

  // =============================================
  // 通道1：定期DOM扫描（主通道）
  // 弹幕必定渲染在DOM中，定期扫描全页文本
  // =============================================
  function scanDOM() {
    if (!isEnabled) return;
    scanCount++;

    // 扫描所有可见文本节点
    const candidates = findChatCandidates();

    for (const candidate of candidates) {
      const parsed = parseChatLine(candidate);
      if (!parsed) continue;

      // ★ 去重：user+content 组合，防止同一评论因 DOM 重渲染被重复发送
      const dedupKey = `${parsed.user || "_"}|${parsed.content.slice(0, 80)}`;
      if (seenTexts.has(dedupKey)) continue;
      seenTexts.add(dedupKey);
      if (seenTexts.size > 3000) {
        const first = seenTexts.values().next().value;
        seenTexts.delete(first);
      }

      if (!isInitialized) {
        isInitialized = true;
        updateIndicatorUI(true);
        showToastUI("✅ DOM扫描就绪，自动回复已启动", "success");
      }

      console.log(`[🎯抖音] 弹幕 [${parsed.user}]: ${parsed.content}`);

      chrome.runtime.sendMessage({
        type: "NEW_DANMAKU",
        data: {
          text: parsed.content,
          userName: parsed.user || "用户",
          userId: parsed.user || "user",
          timestamp: Date.now()
        }
      }).catch(() => {});
    }

    // 每30次扫描清理seenTexts
    if (scanCount % 30 === 0) {
      cleanSeenTexts();
    }
  }

  function findChatCandidates() {
    const results = [];
    const vw = innerWidth, vh = innerHeight;
    const seen = new Set();
    const pageVisible = document.visibilityState === "visible";

    const allEls = document.querySelectorAll("*");
    for (const el of allEls) {
      // ★ 关键修复：不仅看叶子节点，也看含冒号的父节点
      // 抖音弹幕通常: <div><span>用户名</span><span>：内容</span></div>
      const text = (el.textContent || "").trim();
      if (!text) continue;
      if (seen.has(text)) continue;
      seen.add(text);

      const hasColon = text.includes("：") || text.includes(":");
      const hasChinese = /[\u4e00-\u9fff]/.test(text);
      const len = text.length;
      if (!hasChinese) continue;

      // ★ 位置过滤 — 仅在页面可见时使用
      // 标签页隐藏时 getBoundingClientRect() 全部返回0，跳过位置检查
      if (pageVisible) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.top < vh * 0.08) continue;
        if (rect.top > vh * 0.92) continue;
        if (rect.left > vw * 0.25 && rect.left < vw * 0.75 &&
            rect.top > vh * 0.10 && rect.top < vh * 0.75) continue;
        if (rect.width > vw * 0.6) continue;
      }

      // 弹幕特征检测
      if (hasColon && len >= 3 && len <= 80) {
        // "用户名：内容" 格式 → 首选
        results.push({ text, el });
      } else if (el.children.length === 0 && len >= 2 && len <= 30) {
        // 短中文叶子节点（无冒号）→ 可能是内容部分
        if (!isUIOnlyText(text)) {
          results.push({ text, el });
        }
      }
    }

    return results;
  }

  function isUIOnlyText(text) {
    const uiWords = [
      "精选", "推荐", "搜索", "关注", "朋友", "我的", "直播", "放映厅",
      "短剧", "小游戏", "充钻石", "客户端", "壁纸", "通知", "私信", "投稿",
      "退出直播间", "刷新", "退出网页全屏", "开启小窗模式",
      "标清", "原画", "蓝光", "超清", "高清", "直播加载中",
      "小心心", "赠送", "人气票", "棒棒糖", "礼花筒", "大啤酒", "闪耀星辰", "鲜花", "玫瑰",
      "比心兔兔", "更多", "充值", "在线观众", "全部",
      "下载抖音精选", "下载抖音", "抖音电商", "抖音",
      "粉丝", "我的喜欢", "我的收藏", "观看历史", "稍后再看",
      "我的作品", "我的预约", "我的订单", "退出登录",
      "发布视频/图文", "视频管理", "作品数据", "开直播", "直播数据",
      "创作者学习中心", "创作者中心", "剪映专业版",
      "查看价格", "全部商品", "小时榜", "人气榜",
      "去设置", "周日", "30天内", "用户服务协议", "隐私政策",
      "账号找回", "联系我们", "加入我们", "营业执照", "友情链接", "站点地图",
      "广告投放", "1钻", "9钻", "199钻", "2钻", "99钻", "10钻", "299钻",
      "开启读屏标签", "读屏标签已关闭",
      "自动回复", "扫描中", "DOM扫描",
      "热门标签", "为你推荐", "猜你喜欢", "大家都在看",
    ];
    const t = text.trim();
    if (uiWords.includes(t)) return true;

    // ★ 过滤被掩码的用户名（抖音可能用 ASCII * 或全角 ＊）
    // 模式：中文前缀(1-3字) + 掩码符号(2个以上) + 可选中文后缀 + 可选冒号
    // 如"康*****"、"晨***儿"、"康*****："、"梦*****"
    if (/^[\u4e00-\u9fff]{1,3}[\*＊★]{2,}/.test(t) && t.length <= 20) return true;

    // ★ 过滤我们的内部状态消息
    if (t.includes("DOM扫描就绪") || t.includes("自动回复已启动") || t.includes("开始扫描")) return true;
    // 匹配带编号的模式
    if (/^\d+钻$/.test(t)) return true;
    if (/^高等级用户$/.test(t)) return true;
    if (/^1000贡献用户/.test(t)) return true;
    if (/^(京).*号$/.test(t)) return true; // 许可证号
    if (/(举报|sfjubao|feedback|douyin\.com|bytedance)/.test(t)) return true;
    if (/^\d{4}.*抖音/.test(t)) return true;

    // ★ 过滤系统通知格式（无冒号的纯中文短句）
    // 如"进入了直播间"、"关注了主播"等系统消息的不同DOM片段
    if (/^(进入|关注|分享|送出|点赞|欢迎|来了|来到)/.test(t) && t.length <= 12) return true;
    if (/^(直播间|主播|送出了|分享了)/.test(t) && t.length <= 10) return true;

    // 排除明显的页面描述/广告文案（长度>40且不含冒号）
    if (t.length > 40 && !t.includes("：") && !t.includes(":")) return true;

    return false;
  }

  // ★ 检测是否为掩码用户名（无实义内容）
  function isMaskedUsername(text) {
    // 全中文长度 2-12，且包含掩码符号（ASCII * 或全角 ＊ 或 ★）
    if (/^[\u4e00-\u9fff\*＊★]{2,12}$/.test(text) && /[\*＊★]{2,}/.test(text)) return true;
    return false;
  }

  // ★ 检测是否为独立的用户名（非弹幕内容）
  // 抖音公屏中，无冒号的短纯中文 ≈ 系统通知的用户名片段
  // 真正的弹幕在DOM里一定有"用户名：内容"的冒号格式
  function isStandaloneUsername(text) {
    // 掩码用户名（如"李****"、"张***儿"）
    if (/[\*＊★]{2,}/.test(text)) return true;

    // 短纯中文 2~5 字，没有标点/数字/常见聊天词 → 大概率是名字
    if (/^[\u4e00-\u9fff]{2,5}$/.test(text)) {
      // 白名单：常见短聊天词，这些就算短也是真弹幕
      const shortChatWords = /^(多少|什么|怎么|哪里|几号|多大|链接|发货|快递|包邮|退货|换货|尺码|大小|颜色|价格|质量|你好|谢谢|再见|在吗|欢迎|加油|好看|不错|喜欢|真棒|可以|是的|好的|有了|没有|来了|走了|还行|不错|还有|主播|多少钱|啥价)$/;
      if (shortChatWords.test(text)) return false;
      return true;
    }

    // 带装饰的短名：emoji前缀(1~4个符号) + 中文名(2~4字)
    // 如 "🌈好运来"、"🔥小明"、"💕阿花"
    if (/^[^\u4e00-\u9fff]{1,4}[\u4e00-\u9fff]{2,4}$/.test(text)) return true;

    return false;
  }

  function parseChatLine(candidate) {
    const text = candidate.text;

    // 模式1: "用户名：消息内容" — 最可靠的弹幕格式
    const colonMatch = text.match(/^(.{1,20})[：:]\s*(.{0,200})$/);
    if (colonMatch) {
      const user = colonMatch[1].trim();
      const content = colonMatch[2].trim();

      // ★ 内容为空 → 系统通知（如"康*****："），跳过
      if (!content || content.length === 0) return null;
      // ★ 用户名伪装成内容 → 跳过
      if (isStandaloneUsername(content)) return null;

      if (isValidChat(content)) return { user, content };
    }

    // 模式2: 纯短文本（无冒号）→ 大概率是系统通知的用户名片段
    // ★ 独立用户名 → 直接拒绝
    if (isStandaloneUsername(text)) return null;
    if (!isValidChat(text)) return null;
    if (text.length < 2 || text.length > 60) return null;
    // 额外过滤：含常见系统通知词汇的不算
    if (/(进入|关注了|点赞了|送出|分享了|欢迎|来了)$/.test(text)) return null;

    return { user: "", content: text };
  }

  function isValidChat(text) {
    if (!text || text.length < 1 || text.length > 200) return false;
    // 必须有中文
    if (!/[\u4e00-\u9fff]/.test(text)) return false;
    // 过滤纯数字/时间戳
    if (/^\d{8,}$/.test(text.replace(/\D/g, ""))) return false;

    // ★ 过滤系统消息（正则，比includes更灵活）
    // 抖音常见系统提示格式：
    //   "XXX进入了直播间" / "XXX进入直播间"
    //   "XXX关注了主播" / "XXX关注主播"
    //   "XXX点赞了" / "XXX点赞了主播"
    //   "XXX送出了小心心" / "XXX送出X个XX"
    //   "XXX分享了直播间"
    //   "欢迎XXX" / "XXX来了"
    const sysRegex = [
      /进入.{0,2}直播/,      // 进入/进入了 直播间
      /关注.{0,2}(主播|了)/,  // 关注了/关注 主播
      /点了赞|点赞了/,        // 点赞了主播/点赞了
      /送出.{0,2}(小心心|人气|礼|玫瑰|鲜花|棒棒糖|啤酒|闪耀|比心)/, // 送出了X个XX
      /分享了(直播间|直播)/,
      /欢迎.{1,10}(进入|来到)/,
      /来了$/,
      /^.{1,6}(来到|来了)/,   // 欢迎XXX来到了
      /compress_type|server_time|internal_src|webcast|pushserver|cursor|gzip/,
    ];
    for (const re of sysRegex) {
      if (re.test(text)) return false;
    }
    return true;
  }

  function cleanSeenTexts() {
    // 只保留最近的一小批
    const entries = [...seenTexts];
    if (entries.length > 500) {
      seenTexts.clear();
      for (const e of entries.slice(-300)) seenTexts.add(e);
    }
  }

  // =============================================
  // 通道2：WebSocket postMessage（辅助通道，来自ws-patch.js）
  // =============================================
  window.addEventListener("message", (event) => {
    if (!event.data || event.data.source !== "douyin-auto-reply") return;

    // ws-patch.js 发来的数据大部分是噪音，只取有中文的
    const { content } = event.data;
    if (!content || typeof content !== "string") return;
    if (!/[\u4e00-\u9fff]/.test(content)) return;
    if (content.length < 2 || content.length > 200) return;

    // 过滤已知噪音模式
    const noisePatterns = [
      "compress_type", "server_time", "internal_src", "pushserver",
      "webcast", "cursor", "gzip", "wss_msg_type", "first_req_ms",
      "live_cursor", "pb:", "msgB"
    ];
    for (const p of noisePatterns) {
      if (content.includes(p)) return;
    }

    const dedupKey = `ws_${content}`;
    if (seenTexts.has(dedupKey)) return;
    seenTexts.add(dedupKey);

    console.log(`[🎯抖音] WS弹幕: ${content}`);

    chrome.runtime.sendMessage({
      type: "NEW_DANMAKU",
      data: {
        text: content,
        userName: "用户",
        userId: "ws-user",
        timestamp: Date.now()
      }
    }).catch(() => {});
  });

  // =============================================
  // 发送回复
  // =============================================
  async function sendReply(text) {
    const inputs = [
      ...document.querySelectorAll("textarea"),
      ...document.querySelectorAll("input[type='text'], input:not([type])"),
      ...document.querySelectorAll("[contenteditable='true']"),
    ].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    let best = null, bestScore = -1;
    for (const el of inputs) {
      let score = 0;
      const r = el.getBoundingClientRect();
      if (r.top > innerHeight * 0.5) score += 3;
      if (/(说|发|聊|input|message|comment|reply|send)/i.test(el.getAttribute("placeholder") || "")) score += 5;
      if (el.tagName === "TEXTAREA") score += 2;
      if (r.width < 600) score += 1;
      if (score > bestScore) { bestScore = score; best = el; }
    }

    if (!best) { console.warn("[🎯抖音] 未找到输入框"); return false; }

    try {
      best.focus();
      if (best.isContentEditable || best.getAttribute("contenteditable") === "true") {
        best.textContent = "";
        best.focus();
        document.execCommand("insertText", false, text);
        best.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        const proto = best.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(best, text); else best.value = text;
        best.dispatchEvent(new Event("input", { bubbles: true }));
        best.dispatchEvent(new Event("change", { bubbles: true }));
      }

      await sleep(300);

      // 尝试多种方式发送
      const sent = await trySend(best);
      console.log("[🎯抖音] 发送结果:", sent);
      return true;
    } catch (e) {
      console.error("[🎯抖音] 发送失败:", e.message);
      return false;
    }
  }

  async function trySend(inputEl) {
    console.log("[🎯抖音] 尝试发送, input:", inputEl.tagName, "class:", String(inputEl.className || "").slice(0, 40));

    // 方法1：找发送按钮并点击
    const sendBtn = findSendBtn(inputEl);
    if (sendBtn) {
      console.log("[🎯抖音] 找到发送按钮:", sendBtn.tagName, String(sendBtn.className || "").slice(0, 30));
      // 用 dispatchEvent 而非 .click()（SVG元素没有.click()）
      sendBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      // 如果元素支持 .click() 也调用
      if (typeof sendBtn.click === "function") sendBtn.click();
      await sleep(200);

      // 检查是否发送成功（输入框是否清空）
      const valueAfter = getInputValue(inputEl);
      if (!valueAfter || valueAfter.length < 2) {
        console.log("[🎯抖音] ✅ 点击发送成功（输入框已清空）");
        return "click-ok";
      }
      console.log("[🎯抖音] 点击后输入框未清空，尝试其他方式");
    }

    // 方法2：模拟完整 Enter 键序列（React 兼容）
    console.log("[🎯抖音] 尝试 Enter 键");

    // keydown
    inputEl.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true,
      charCode: 0, isComposing: false
    }));

    // 对于 React：beforeinput 事件
    inputEl.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertLineBreak", data: "\n",
      bubbles: true, cancelable: true, composed: true
    }));

    await sleep(50);

    // keypress
    inputEl.dispatchEvent(new KeyboardEvent("keypress", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true,
      charCode: 13
    }));

    await sleep(50);

    // keyup
    inputEl.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    }));

    await sleep(300);

    const valueAfterEnter = getInputValue(inputEl);
    if (!valueAfterEnter || valueAfterEnter.length < 2) {
      console.log("[🎯抖音] ✅ Enter键发送成功");
      return "enter-ok";
    }

    // 方法3：也往 document 上派发 Enter（React 事件委托）
    console.log("[🎯抖音] 尝试向document派发Enter");
    const docEnter = new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    });
    document.dispatchEvent(docEnter);
    await sleep(200);

    // 方法4：找 form 提交
    const form = inputEl.closest("form");
    if (form) {
      console.log("[🎯抖音] 找到表单，尝试提交");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await sleep(200);
    }

    // 最终检查
    const finalValue = getInputValue(inputEl);
    if (!finalValue || finalValue.length < 2) {
      console.log("[🎯抖音] ✅ 发送成功");
      return "ok";
    }

    console.warn("[🎯抖音] ⚠️ 所有发送方式都未清空输入框，当前值:", finalValue);
    return "failed-all";
  }

  function getInputValue(el) {
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      return el.textContent || "";
    }
    return el.value || "";
  }

  function findSendBtn(input) {
    // 在输入框周围找发送按钮
    const inputRect = input.getBoundingClientRect();

    // 收集整个页面底部的可点击元素
    const candidates = [];

    // 从输入框往上找5层父元素
    let root = input;
    for (let i = 0; i < 5 && root; i++) {
      // 找所有可能可点击的元素
      const clickable = root.querySelectorAll(
        "button, [role='button'], svg, [class*='send'], [class*='Send'], " +
        "[class*='submit'], [class*='Submit'], [class*='publish'], [class*='Publish'], " +
        "[class*='post'], [class*='Post'], img[class*='send'], div[class*='send'], " +
        "span[class*='send'], [data-e2e*='send']"
      );
      for (const el of clickable) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.width > 200 || r.height > 200) continue; // 太大不是按钮

        // 必须在输入框附近（同层级或右侧）
        const nearInput = (
          r.bottom >= inputRect.top - 50 &&
          r.top <= inputRect.bottom + 50
        );

        if (!nearInput) continue;

        // 评分
        let score = 0;

        // 在输入框右侧
        if (r.left >= inputRect.right - 20) score += 10;

        // 含发送文字
        const txt = (el.textContent || "").trim();
        if (/发送|send|发布|publish/i.test(txt)) score += 20;

        // 含发送相关class
        const cls = (el.className || "").toString().toLowerCase();
        if (/send|submit|publish|post/.test(cls)) score += 15;

        // 是 button
        if (el.tagName === "BUTTON") score += 5;

        // 在输入框附近
        score += Math.max(0, 10 - Math.abs(r.right - inputRect.right) / 10);

        candidates.push({ el, score, right: r.right });
      }
      root = root.parentElement;
    }

    // 如果父元素没找到，搜索整个文档底部区域
    if (candidates.length === 0) {
      const allClickable = document.querySelectorAll(
        "button, [role='button'], [class*='send'], [class*='Send'], [class*='submit']"
      );
      for (const el of allClickable) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.width > 200 || r.height > 200) continue;
        if (r.top < innerHeight * 0.5) continue; // 只找下半屏

        let score = 0;
        if (r.right > innerWidth * 0.7) score += 5; // 靠右
        const txt = (el.textContent || "").trim();
        if (/发送|send|发布|publish/i.test(txt)) score += 20;
        const cls = (el.className || "").toString().toLowerCase();
        if (/send|submit|publish|post/.test(cls)) score += 10;
        if (el.tagName === "BUTTON") score += 3;
        if (score > 0) candidates.push({ el, score, right: r.right });
      }
    }

    if (candidates.length === 0) return null;

    // 按评分排序，最高分的是发送按钮
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].el;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // =============================================
  // UI
  // =============================================
  function createIndicator() {
    if (document.getElementById("douyin-auto-reply-indicator")) return;
    const el = document.createElement("div");
    el.id = "douyin-auto-reply-indicator";
    Object.assign(el.style, {
      position: "fixed", bottom: "80px", right: "16px", zIndex: "99999999",
      background: "rgba(0,0,0,0.78)", color: "#fff", padding: "6px 14px",
      borderRadius: "20px", display: "flex", alignItems: "center", gap: "8px",
      fontFamily: '-apple-system,"Microsoft YaHei",sans-serif', fontSize: "12px",
      cursor: "pointer", userSelect: "none", transition: "all .3s",
      boxShadow: "0 2px 12px rgba(0,0,0,0.5)", border: "1px solid rgba(255,255,255,0.1)"
    });
    el.innerHTML = '<div id="dar-dot" style="width:8px;height:8px;border-radius:50%;background:#FF9800;flex-shrink:0;transition:background .3s;"></div><span id="dar-text">扫描中...</span>';
    el.title = "点击切换自动回复开关";
    el.addEventListener("click", () => {
      isEnabled = !isEnabled;
      updateIndicatorUI(isEnabled);
      chrome.runtime.sendMessage({ type: "TOGGLE_ENABLED", enabled: isEnabled }).catch(() => {});
      showToastUI(isEnabled ? "✅ 已开启" : "⏸ 已暂停", isEnabled ? "success" : "warn");
    });
    document.body.appendChild(el);
    console.log("[🎯抖音] UI 指示灯已创建");
  }

  function updateIndicatorUI(enabled) {
    const dot = document.getElementById("dar-dot");
    const text = document.getElementById("dar-text");
    if (!dot || !text) return;
    dot.style.background = isInitialized ? (enabled ? "#4CAF50" : "#888") : "#FF9800";
    text.textContent = isInitialized ? (enabled ? "自动回复 ✓" : "已暂停") : `扫描中(第${scanCount}轮)...`;
  }

  function showToastUI(msg, type) {
    const colors = { success: "#4CAF50", error: "#f44336", info: "#2196F3", warn: "#FF9800" };
    const t = document.createElement("div");
    Object.assign(t.style, {
      position: "fixed", bottom: "130px", right: "16px", zIndex: "99999999",
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
    // TASK-VISUAL-TREND-001：供 SW 采样趋势指标（在线人数等）
    if (msg.type === "GET_VISUAL_METRICS") {
      try {
        sendResponse(readVisualMetrics(document));
      } catch (e) {
        sendResponse({ metrics: { online: null, enter: null, leave: null },
          rawMetrics: { online: null, enter: null, leave: null }, matchedSelector: null });
      }
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
      console.log("[🎯抖音] DOM扫描器启动 (间隔" + POLL_INTERVAL + "ms)");
      scannerRunning = true;
      scheduleScan();

      // ★ 定时保活 ping，防止 Service Worker 休眠
      setInterval(() => {
        chrome.runtime.sendMessage({ type: "PING" }).catch(() => {});
      }, 20000);
    }, 3000);
  }

  function scheduleScan() {
    if (!scannerRunning) return;
    scanTimer = setTimeout(() => {
      scanDOM();
      scheduleScan();
    }, POLL_INTERVAL);
  }

  // 兜底UI
  setTimeout(() => {
    if (!document.getElementById("douyin-auto-reply-indicator")) {
      createIndicator();
      updateIndicatorUI(isEnabled);
    }
  }, 5000);

  setInterval(() => updateIndicatorUI(isEnabled), 3000);
})();
