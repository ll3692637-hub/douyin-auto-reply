/**
 * TASK-AI-002: 单片段 AI 分析 — 证据、缓存、模型逻辑
 * server.js 只做路由，所有业务逻辑在此模块，便于测试。
 *
 * 设计要点（Codex 评审 7 点修正）：
 * 1. preview/analyze 分离：preview 返回条数、缺失项、evidenceHash；analyze 携带 hash，证据变化则 409
 * 2. 证据用稳定 ref（t_0001/d_0001/p_0001/o_0001），模型返回后校验 ref 存在且时间/引文一致
 * 3. 起点商品 = 最近 product_switch + 其后到范围起点前的 price_update；标注"最近识别到的商品"
 * 4. 服务端防并发：同缓存键共用一次模型调用；缓存键含 mock 模式/provider/规则文件内容哈希
 * 5. 保存前复查会话存在；删除与写入协调，删完不复活
 * 6. 反馈独立文件；模型输出做 JSON/长度/引用校验；密钥不进日志
 * 7. 无可分析内容不调用；证据带质量标记；上下文与范围证据分开；弹幕用户名默认不发送
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const RULE_VERSION = "ai-rules-base-v1+scarf-v1";
const MAX_EVIDENCE_CHARS = 20000;
const MODEL_TIMEOUT_MS = 30000;
const MAX_FIELD_CHARS = 4000; // 模型单字段长度上限
const PROBLEM_TYPES = ["filler", "imagery", "engagement"]; // 无效口水话/美感没讲出来/缺少观众参与感
// 可复用骨架空洞模式：只由通用大词和连接符组成、没有具体槽位
const EMPTY_FRAME_RE = /^[\s\u3000痛点卖点促单钩子逼单开场收尾种草转化话术、，,+.＋\/\\|-]+$/;

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n")
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function fmtLabel(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60), ss = s % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

function qualityOf(item) {
  if (item.mock) return "mock";
  if (item.status && item.status !== "ok") return "failed";
  return "real";
}

// ---------- 证据收集 ----------
function collectEvidence(sessionDir, rangeStartMs, rangeEndMs) {
  const transcripts = [], danmaku = [], products = [], online = [];
  const notes = [];

  // 转写（范围内）
  for (const t of readJsonl(path.join(sessionDir, "transcript.jsonl"))) {
    const at = t.offsetMs;
    if (at == null || at < rangeStartMs || at >= rangeEndMs) continue;
    const text = (t.text || "").trim();
    if (!text) continue;
    transcripts.push({ atMs: at, text, quality: qualityOf(t) });
  }
  // 弹幕（范围内；用户名默认不发送；主播号/运营号打 isStaff 标记，不当作自然观众需求）
  for (const d of readJsonl(path.join(sessionDir, "danmaku.jsonl"))) {
    const at = d.offsetMs;
    if (at == null || at < rangeStartMs || at >= rangeEndMs) continue;
    const text = (d.text || "").trim();
    if (!text) continue;
    const role = d.role || "audience";
    danmaku.push({
      atMs: at, text, quality: qualityOf(d),
      isStaff: role === "anchor" || role === "water_army",
    });
  }
  // 商品/价格（范围内）
  const prodNodes = readJsonl(path.join(sessionDir, "product.jsonl"));
  for (const p of prodNodes) {
    const at = p.offsetMs;
    if (at == null || at < rangeStartMs || at >= rangeEndMs) continue;
    const prod = p.product || {};
    products.push({
      atMs: at,
      type: p.type === "price_update" ? "price_update" : "product_switch",
      name: prod.name || "",
      priceText: prod.priceText || (prod.price ? "¥" + prod.price : ""),
      quality: qualityOf(p),
    });
  }
  // 在线采样（范围内，只取真实数值）
  for (const v of readJsonl(path.join(sessionDir, "visual.jsonl"))) {
    const at = v.offsetMs;
    if (at == null || at < rangeStartMs || at >= rangeEndMs) continue;
    const on = v.metrics ? v.metrics.online : null;
    if (on == null) continue;
    online.push({ atMs: at, online: on });
  }

  // 起点商品：最近 product_switch + 其后到范围起点前的 price_update
  let contextProduct = null;
  const switches = prodNodes
    .filter(p => p.type !== "price_update" && p.offsetMs != null && p.offsetMs <= rangeStartMs)
    .sort((a, b) => a.offsetMs - b.offsetMs);
  if (switches.length) {
    const sw = switches[switches.length - 1];
    const prod = sw.product || {};
    let priceText = prod.priceText || (prod.price ? "¥" + prod.price : "");
    // 应用之后、范围起点之前的价格更新
    const laterPrices = prodNodes
      .filter(p => p.type === "price_update" && p.offsetMs > sw.offsetMs && p.offsetMs <= rangeStartMs)
      .sort((a, b) => a.offsetMs - b.offsetMs);
    if (laterPrices.length) {
      const lp = laterPrices[laterPrices.length - 1].product || {};
      priceText = lp.priceText || (lp.price ? "¥" + lp.price : "") || priceText;
    }
    contextProduct = {
      name: prod.name || "",
      priceText,
      sinceMs: sw.offsetMs,
      sinceLabel: fmtLabel(sw.offsetMs),
      note: "最近识别到的商品（系统识别时间），不是确定主播一直在讲它",
    };
  }

  // 缺失项声明
  if (!transcripts.length) notes.push("本范围无转写");
  if (!danmaku.length) notes.push("本范围无弹幕");
  if (!products.length && !contextProduct) notes.push("本范围无商品信息");
  if (!online.length) notes.push("本范围无在线采样");
  else notes.push("在线采样间隔约5分钟，只反映采样点数值，不代表分钟级变化");

  // 稳定 ref（按时间排序后编号）
  const byTime = (a, b) => a.atMs - b.atMs;
  transcripts.sort(byTime).forEach((t, i) => { t.ref = `t_${String(i + 1).padStart(4, "0")}`; t.label = fmtLabel(t.atMs); });
  danmaku.sort(byTime).forEach((d, i) => { d.ref = `d_${String(i + 1).padStart(4, "0")}`; d.label = fmtLabel(d.atMs); });
  products.sort(byTime).forEach((p, i) => { p.ref = `p_${String(i + 1).padStart(4, "0")}`; p.label = fmtLabel(p.atMs); });
  online.sort(byTime).forEach((o, i) => { o.ref = `o_${String(i + 1).padStart(4, "0")}`; o.label = fmtLabel(o.atMs); });

  const evidence = {
    range: { startMs: rangeStartMs, endMs: rangeEndMs, label: `${fmtLabel(rangeStartMs)} – ${fmtLabel(rangeEndMs)}` },
    contextProduct, // 上下文（范围外），与范围内证据分开
    transcripts, danmaku, products, online,
    notes,
  };
  const evidenceHash = sha256(JSON.stringify(evidence));
  const totalChars = JSON.stringify(evidence).length;
  return { evidence, evidenceHash, totalChars };
}

function hasAnalyzable(evidence) {
  return evidence.transcripts.length > 0 || evidence.danmaku.length > 0 ||
    evidence.products.length > 0 || evidence.online.length > 0;
}

function previewSummary(evidence, evidenceHash) {
  const missing = [];
  if (!evidence.transcripts.length) missing.push("transcript");
  if (!evidence.danmaku.length) missing.push("danmaku");
  if (!evidence.products.length && !evidence.contextProduct) missing.push("product");
  if (!evidence.online.length) missing.push("online");
  return {
    range: evidence.range,
    counts: {
      transcript: evidence.transcripts.length,
      danmaku: evidence.danmaku.length,
      product: evidence.products.length,
      online: evidence.online.length,
      contextProduct: evidence.contextProduct ? 1 : 0,
    },
    missing,
    notes: evidence.notes,
    evidenceHash,
    hasAnalyzable: hasAnalyzable(evidence),
  };
}

// ---------- 缓存 ----------
// 规则内容哈希：base（事实边界）+ scarf（类目档案）两个文件全部计入
function ruleContentHash(rulesPaths) {
  const paths = Array.isArray(rulesPaths) ? rulesPaths : [rulesPaths];
  try {
    return sha256(paths.map(p => fs.readFileSync(p, "utf8")).join("\n---\n"));
  } catch {
    return "no-rules-file";
  }
}

function buildCacheKey({ evidenceHash, model, provider, ruleHash, mockMode }) {
  return sha256([evidenceHash, model, provider, ruleHash, mockMode ? "mock" : "real"].join("|"));
}

// 并发去重：同缓存键共用一次模型调用
const inflight = new Map();

// ---------- 模型输出校验（分析标准 v0.1） ----------
// 服务端根据 refs 自动拼接还原完整上下文原话与起止毫秒时间，模型不自己拼长句
// 防断章：先按 atMs 升序排（防模型乱序）；编号不连续处用 … 隔开，不静默拼成连续讲话
function enrichRefs(item, evidenceByRef) {
  const srcs = item.refs.map(r => evidenceByRef.get(r)).filter(Boolean);
  srcs.sort((a, b) => a.atMs - b.atMs);
  const nums = srcs.map(s => parseInt(String(s.ref).split("_")[1], 10));
  const parts = [];
  let hasGap = false;
  srcs.forEach((s, i) => {
    if (i > 0 && Number.isFinite(nums[i]) && Number.isFinite(nums[i - 1]) && nums[i] !== nums[i - 1] + 1) {
      parts.push("…");
      hasGap = true;
    }
    parts.push(String(s.text || s.name || (s.online != null ? s.online : "")).trim());
  });
  item.text = parts.join("");
  item.hasGap = hasGap; // true 表示中间有跳过，非连续引用
  item.startMs = srcs[0].atMs;
  item.endMs = srcs[srcs.length - 1].atMs;
  item.startLabel = fmtLabel(item.startMs);
  item.endLabel = fmtLabel(item.endMs);
  item.refCount = srcs.length;
}

function refPrefix(ref) {
  return ref.split("_")[0];
}

function validateModelOutput(result, evidenceByRef) {
  const errors = [];
  try {
    if (!result || typeof result !== "object" || Array.isArray(result))
      return { ok: false, errors: ["结果不是对象"] };
    for (const f of ["summary", "goodScripts", "problems", "verification"]) {
      if (result[f] == null) errors.push(`缺少字段 ${f}`);
    }
    if (errors.length) return { ok: false, errors };
    if (typeof result.summary !== "string" || !result.summary.trim())
      errors.push("summary 必须是非空字符串");
    if (typeof result.verification !== "string" || !result.verification.trim())
      errors.push("verification 必须是非空字符串");
    // 好话术 / 问题数组允许为空（确实没有就不硬凑），但必须为数组
    if (!Array.isArray(result.goodScripts)) errors.push("goodScripts 必须是数组");
    if (!Array.isArray(result.problems)) errors.push("problems 必须是数组");
    if (result.pendingAV != null && !Array.isArray(result.pendingAV))
      errors.push("pendingAV 必须是数组");
    if (result.summary && result.summary.length > MAX_FIELD_CHARS) errors.push("summary 超长");
    if (result.verification && result.verification.length > MAX_FIELD_CHARS) errors.push("verification 超长");
    if (errors.length) return { ok: false, errors };

    const checkRefs = (refs, where, opts) => {
      const allowedPrefixes = (opts && opts.allowedPrefixes) || null;
      if (!Array.isArray(refs) || refs.length === 0) { errors.push(`${where} refs 非空`); return false; }
      // GPT 评审：拒绝重复引用
      if (new Set(refs).size !== refs.length) { errors.push(`${where} refs 有重复`); return false; }
      const prefixes = new Set();
      for (const r of refs) {
        if (typeof r !== "string" || !evidenceByRef.has(r)) { errors.push(`${where} 引用了不存在的 ${r}`); return false; }
        prefixes.add(refPrefix(r));
      }
      if (prefixes.size > 1) { errors.push(`${where} refs 应指向同一类型记录`); return false; }
      // GPT 评审：好话术原文限定来自转写，弹幕不能冒充主播说的话
      if (allowedPrefixes && ![...prefixes].every(p => allowedPrefixes.includes(p))) {
        errors.push(`${where} refs 类型不符合要求（仅允许 ${allowedPrefixes.join("/")}）`); return false;
      }
      return true;
    };

    for (const [i, g] of (result.goodScripts || []).entries()) {
      const where = `goodScripts[${i}]`;
      if (!g || typeof g !== "object") { errors.push(`${where} 条目非法`); continue; }
      // 好话术原文必须来自转写（t_），弹幕可作语境但不能冒充主播说的话
      if (!checkRefs(g.refs, where, { allowedPrefixes: ["t"] })) continue;
      for (const f of ["whyKeep", "reusableFrame", "appliesTo"]) {
        if (typeof g[f] !== "string" || !g[f].trim() || g[f].length > MAX_FIELD_CHARS) {
          errors.push(`${where} ${f} 非法`); break;
        }
      }
      // 可复用骨架严禁空洞大词：只由通用词组成、且没有任何槽位符号时才打回；
      // 带 [ ] / 【 】 / → 的具体骨架一律放行（Gemini 评审：防误杀）
      const frame = (g.reusableFrame || "").trim();
      const hasSlot = frame.includes("[") || frame.includes("【") || frame.includes("→");
      if (frame && !hasSlot && EMPTY_FRAME_RE.test(frame))
        errors.push(`${where} reusableFrame 过于空洞，需带槽位的具体句式`);
      if (g.asrNotes != null && typeof g.asrNotes !== "string") errors.push(`${where} asrNotes 非法`);
      if (!errors.some(e => e.startsWith(where))) enrichRefs(g, evidenceByRef);
    }
    for (const [i, p] of (result.problems || []).entries()) {
      const where = `problems[${i}]`;
      if (!p || typeof p !== "object") { errors.push(`${where} 条目非法`); continue; }
      if (!PROBLEM_TYPES.includes(p.type)) { errors.push(`${where} type 非法`); continue; }
      if (!checkRefs(p.refs, where)) continue;
      if (typeof p.description !== "string" || !p.description.trim() || p.description.length > MAX_FIELD_CHARS)
        { errors.push(`${where} description 非法`); continue; }
      if (!errors.some(e => e.startsWith(where))) enrichRefs(p, evidenceByRef);
    }
    for (const [i, s] of (result.pendingAV || []).entries()) {
      if (typeof s !== "string" || !s.trim()) errors.push(`pendingAV[${i}] 非法`);
    }
  } catch (e) {
    // 畸形输出不能抛出未处理异常
    return { ok: false, errors: ["输出结构异常，无法校验"] };
  }
  return { ok: errors.length === 0, errors };
}

function buildEvidenceByRef(evidence) {
  const m = new Map();
  for (const t of evidence.transcripts) m.set(t.ref, t);
  for (const d of evidence.danmaku) m.set(d.ref, d);
  for (const p of evidence.products) m.set(p.ref, p);
  for (const o of evidence.online) m.set(o.ref, o);
  return m;
}

// ---------- prompt 组装 ----------
function buildPrompt(evidence, baseRulesText, scarfRulesText) {
  const ev = {
    范围: evidence.range.label,
    起点商品_上下文: evidence.contextProduct || "无",
    转写: evidence.transcripts.map(t => ({ ref: t.ref, 时间: t.label, 内容: t.text, 质量: t.quality })),
    弹幕: evidence.danmaku.map(d => {
      const e = { ref: d.ref, 时间: d.label, 内容: d.text, 质量: d.quality };
      if (d.isStaff) e.isStaff = true; // 主播号/运营号：不当作自然观众需求
      return e;
    }),
    商品事件_范围内: evidence.products.map(p => ({ ref: p.ref, 时间: p.label, 类型: p.type, 商品: p.name, 价格: p.priceText })),
    在线采样: evidence.online.map(o => ({ ref: o.ref, 时间: o.label, 在线: o.online })),
    数据说明: evidence.notes,
  };
  const rulesText = `${baseRulesText}\n\n---\n\n${scarfRulesText}`;
  return `${rulesText}\n\n## 本次分析的证据（JSON）\n\`\`\`json\n${JSON.stringify(ev, null, 1)}\n\`\`\`\n\n请只输出 JSON，不要输出其他内容，格式：\n{"summary":"…","goodScripts":[{"refs":["t_0001","t_0002"],"whyKeep":"…","reusableFrame":"…","appliesTo":"…","asrNotes":""}],"problems":[{"type":"filler","refs":["t_0005"],"description":"…"}],"pendingAV":["…"],"verification":"…"}\n注意：好话术 refs 必须是**转写记录**（t_），弹幕可作语境但不能冒充主播说的话；refs 指向连续记录，不要自己拼接长句，引文由服务端自动还原；编号不连续处自动用 … 隔开，严禁重复引用；确实没有好话术或明显问题时对应数组返回 [] 并如实说明。`;
}

// ---------- 模型调用 ----------
function callDeepSeek({ apiBase, apiKey, model, prompt, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiBase.replace(/\/$/, "") + "/chat/completions");
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: timeoutMs || MODEL_TIMEOUT_MS,
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          // 错误响应不泄露密钥：只保留状态码和脱敏后的 body 片段
          return reject(new Error(`模型接口返回 ${res.statusCode}`));
        }
        try {
          const j = JSON.parse(raw);
          const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          resolve({ content, usage: j.usage || {} });
        } catch (e) {
          reject(new Error("模型返回解析失败"));
        }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("模型请求超时")); });
    req.on("error", (e) => reject(new Error("模型请求失败")));
    req.write(body);
    req.end();
  });
}

function mockResult(evidence) {
  // 调用前已保证 hasAnalyzable，first 必存在
  const first = evidence.transcripts[0] || evidence.danmaku[0] || evidence.products[0] || evidence.online[0];
  const byRef = buildEvidenceByRef(evidence);
  const g = {
    refs: [first.ref],
    whyKeep: "MOCK：此处应说明哪句话解决了什么顾虑",
    reusableFrame: "MOCK：先问[某类困扰]→拿[具体参照物]对比→给[动作指令]",
    appliesTo: "MOCK：适用条件",
    asrNotes: "",
  };
  enrichRefs(g, byRef);
  return {
    summary: `MOCK：本段 ${evidence.range.label} 共有转写 ${evidence.transcripts.length} 条、弹幕 ${evidence.danmaku.length} 条${evidence.contextProduct ? `，起点商品为${evidence.contextProduct.name}` : ""}。`,
    goodScripts: [g],
    problems: [],
    pendingAV: ["MOCK：语气感染力待音视频分析"],
    verification: "MOCK：下次观察对应指标变化",
  };
}

// ---------- 主流程 ----------
async function analyzeRange(opts) {
  const {
    sessionDir, sessionId, rangeStartMs, rangeEndMs,
    evidenceHash: clientHash, secrets, rulesBasePath, rulesScarfPath, mockMode,
  } = opts;

  // 会话存在性复查
  if (!fs.existsSync(sessionDir)) throw Object.assign(new Error("会话不存在"), { code: "SESSION_GONE" });

  const { evidence, evidenceHash, totalChars } = collectEvidence(sessionDir, rangeStartMs, rangeEndMs);

  // 确认校验：必须携带 preview 的 hash，且严格匹配（Codex 评审：不可绕过）
  if (!clientHash || typeof clientHash !== "string")
    throw Object.assign(new Error("请先预览确认后再分析"), { code: "HASH_REQUIRED" });
  if (clientHash !== evidenceHash)
    throw Object.assign(new Error("证据已变化，请重新确认后再分析"), { code: "EVIDENCE_CHANGED" });

  // 无可分析内容：不付费调用
  if (!hasAnalyzable(evidence))
    throw Object.assign(new Error("本范围无转写、弹幕、商品、在线数据可分析"), { code: "NO_EVIDENCE" });

  // 输入超限：提示缩小范围，不悄悄截断
  if (totalChars > MAX_EVIDENCE_CHARS)
    throw Object.assign(new Error(`证据量过大（约${Math.round(totalChars / 1000)}k 字符），请缩小时间范围后重试`), { code: "TOO_LARGE" });

  const ruleHash = ruleContentHash([rulesBasePath, rulesScarfPath]);
  const model = (secrets && secrets.model) || "deepseek-chat";
  const provider = (secrets && secrets.provider) || "deepseek";
  const cacheKey = buildCacheKey({ evidenceHash, model, provider, ruleHash, mockMode });

  const analysisDir = path.join(sessionDir, "analysis");
  const cacheFile = path.join(analysisDir, "cache", cacheKey + ".json");
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    return { ...cached, cached: true };
  }

  // 并发去重：同缓存键共用一次模型调用；键包含会话身份做隔离（Codex 评审）
  const inflightKey = sessionId + "|" + cacheKey;
  if (inflight.has(inflightKey)) return inflight.get(inflightKey);
  const job = (async () => {
    let result, usage = {}, isMock = false;
    // Codex 评审：只有测试模式才允许 mock；正常模式缺密钥直接中文报错，不自动降级
    if (mockMode) {
      result = mockResult(evidence);
      isMock = true;
    } else if (!secrets || !secrets.apiKey) {
      throw Object.assign(new Error("尚未配置分析 API，请先在应用数据目录创建 analysis-secrets.json 并填入 DeepSeek 密钥"), { code: "NO_API_KEY" });
    } else {
      const baseRulesText = fs.readFileSync(rulesBasePath, "utf8");
      const scarfRulesText = fs.readFileSync(rulesScarfPath, "utf8");
      const prompt = buildPrompt(evidence, baseRulesText, scarfRulesText);
      const { content, usage: u } = await callDeepSeek({
        apiBase: secrets.apiBase || "https://api.deepseek.com",
        apiKey: secrets.apiKey,
        model,
        prompt,
      });
      usage = { promptTokens: u.prompt_tokens || 0, completionTokens: u.completion_tokens || 0 };
      let parsed;
      try { parsed = JSON.parse(content); }
      catch { throw Object.assign(new Error("模型返回不是合法 JSON"), { code: "BAD_MODEL_OUTPUT" }); }
      const v = validateModelOutput(parsed, buildEvidenceByRef(evidence));
      if (!v.ok) throw Object.assign(new Error("模型输出校验失败：" + v.errors.slice(0, 3).join("；")), { code: "BAD_MODEL_OUTPUT" });
      result = parsed;
    }

    const analysis = {
      analysisId: "an_" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      sessionId, rangeStartMs, rangeEndMs, rangeLabel: evidence.range.label,
      model, provider, ruleVersion: RULE_VERSION, ruleHash,
      evidenceHash, mock: isMock,
      result, usage,
      createdAt: new Date().toISOString(),
    };

    // 保存前复查会话仍存在（删除并发：删完不复活）
    // 先让出事件循环，让并发的删除操作有机会执行（真实模型调用本身是异步的）
    await new Promise(r => setImmediate(r));
    if (!fs.existsSync(sessionDir))
      throw Object.assign(new Error("会话已删除，分析结果未保存"), { code: "SESSION_GONE" });
    fs.mkdirSync(path.join(analysisDir, "cache"), { recursive: true });
    // 写缓存与结果；若会话在 mkdir 后被删，writeFile 前再查一次
    if (!fs.existsSync(sessionDir))
      throw Object.assign(new Error("会话已删除，分析结果未保存"), { code: "SESSION_GONE" });
    fs.writeFileSync(cacheFile, JSON.stringify({ ...analysis, cached: undefined }));
    fs.writeFileSync(path.join(analysisDir, analysis.analysisId + ".json"),
      JSON.stringify(analysis, null, 1));
    return { ...analysis, cached: false };
  })();
  inflight.set(inflightKey, job);
  try {
    return await job;
  } finally {
    inflight.delete(inflightKey);
  }
}

// 反馈：独立文件（jsonl 追加），不嵌入分析结果
function saveFeedback(sessionDir, analysisId, type, note) {
  if (!fs.existsSync(sessionDir)) throw Object.assign(new Error("会话不存在"), { code: "SESSION_GONE" });
  if (!["useful", "inaccurate"].includes(type)) throw Object.assign(new Error("反馈类型非法"), { code: "BAD_INPUT" });
  const dir = path.join(sessionDir, "analysis", "feedback");
  fs.mkdirSync(dir, { recursive: true });
  const entry = { analysisId, type, note: String(note || "").slice(0, 500), at: new Date().toISOString() };
  fs.appendFileSync(path.join(dir, analysisId + ".jsonl"), JSON.stringify(entry) + "\n");
  return entry;
}

function listAnalyses(sessionDir) {
  const dir = path.join(sessionDir, "analysis");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json") && f.startsWith("an_"))
    .map(f => {
      try {
        const a = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        return {
          analysisId: a.analysisId, rangeLabel: a.rangeLabel,
          rangeStartMs: a.rangeStartMs, rangeEndMs: a.rangeEndMs,
          model: a.model, ruleVersion: a.ruleVersion, mock: a.mock,
          createdAt: a.createdAt,
          summary: (a.result && a.result.summary || "").slice(0, 120),
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function getAnalysis(sessionDir, analysisId) {
  const f = path.join(sessionDir, "analysis", analysisId + ".json");
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

function listFeedback(sessionDir, analysisId) {
  const f = path.join(sessionDir, "analysis", "feedback", analysisId + ".jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

module.exports = {
  RULE_VERSION, MAX_EVIDENCE_CHARS, PROBLEM_TYPES,
  collectEvidence, previewSummary, hasAnalyzable,
  buildCacheKey, ruleContentHash,
  validateModelOutput, buildEvidenceByRef, enrichRefs,
  buildPrompt, analyzeRange, saveFeedback,
  listAnalyses, getAnalysis, listFeedback,
  _inflight: inflight, // 测试用
};
