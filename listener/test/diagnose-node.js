#!/usr/bin/env node
/**
 * Node 侧 API 诊断（Mac 本地运行，在 listener 目录）：
 *   node test/diagnose-node.js <sessionId> <startMs> <endMs>
 *
 * 做了什么（每步最多请求一次，不自动重试；不改任何业务代码）：
 *  [1] 用业务原函数 callDeepSeek 发最小测试。callDeepSeek 固定带
 *      response_format=json_object，所以 prompt 本身就要求只返回 JSON，
 *      避免"回复 OK"与强制 JSON 冲突而干扰诊断。
 *  [2] 用与 callDeepSeek 完全相同的请求体做一次原始请求，检查响应里
 *      是否出现 reasoning_content / reasoning_tokens。
 *      注意：未观察到 ≠ 模型一定没思考（网关可能不透传），结论只写"未观察到"。
 *  [3] 真实复盘请求检查：必须显式指定 sessionId 与毫秒范围（相对场次开始）。
 *      先展示证据条数与字符数，并保留业务的长度上限（MAX_EVIDENCE_CHARS）；
 *      经终端确认（输入 y）后才发送，一次真实调用，90 秒上限。
 *
 * 日志铁律：绝不输出密钥和直播原文，只输出计数、耗时、状态、错误码。
 * 超时口径：单次耗时只是样本，不能证明 30 秒长期够用或不够用；
 * 90 秒仍超时也不等于"改成 90 秒就解决"，需另行排查。
 *
 * 离线结构检查（不联网、不读密钥）：
 *   node test/diagnose-node.js --inspect <响应文件>
 * 只输出：HTTP 状态、耗时、顶层字段名、finish_reason、正文字符数、
 * reasoning_content/reasoning_tokens 有无及长度、期望字段缺失情况、
 * 是否存在多包一层的嵌套。不打印正文内容。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const readline = require("readline");

const APP_SUPPORT = path.join(os.homedir(), "Library", "Application Support", "LiveRoomListener");
const SECRETS = path.join(APP_SUPPORT, "analysis-secrets.json");
const SESSIONS_DIR = path.join(APP_SUPPORT, "sessions");
const Analysis = require(path.join(__dirname, "..", "analysis.js"));
const DIAG_TIMEOUT_MS = 90000;
const JSON_TEST_PROMPT = "只返回 JSON，不要其他文字：{\"ok\":true}";

function loadSecrets() {
  const s = JSON.parse(fs.readFileSync(SECRETS, "utf8"));
  if (!s.apiBase || !s.apiKey) { console.error("[ERR] 缺少 apiBase/apiKey"); process.exit(1); }
  if (!s.model) { console.error("[ERR] model 为空"); process.exit(1); }
  return { apiBase: String(s.apiBase), apiKey: String(s.apiKey), model: String(s.model) };
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

// 与 callDeepSeek 完全相同的请求体，用于检查原始响应结构
function rawChatOnce({ apiBase, apiKey, model, prompt, timeoutMs }) {
  return new Promise((resolve) => {
    const url = new URL(apiBase.replace(/\/$/, "") + "/chat/completions");
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });
    const t0 = Date.now();
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => resolve({ ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - t0, raw }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: null, ms: Date.now() - t0, err: "timeout" }); });
    req.on("error", () => resolve({ ok: false, status: null, ms: Date.now() - t0, err: "request_error" }));
    req.write(body);
    req.end();
  });
}

function inspectFile(file) {
  if (!file || !fs.existsSync(file)) {
    console.error("用法: node test/diagnose-node.js --inspect <响应文件>");
    process.exit(1);
  }
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log("HTTP:", saved.status, " 耗时:", saved.ms, "ms  模型:", saved.model, " 时间:", saved.at);
  let j = null;
  try { j = JSON.parse(saved.raw); } catch { /* 非 JSON */ }
  if (!j) { console.log("响应体不是合法 JSON"); return; }
  console.log("响应顶层字段名:", Object.keys(j).join(", "));
  const choice = (j.choices && j.choices[0]) || {};
  console.log("finish_reason:", choice.finish_reason);
  const msg = choice.message || {};
  const content = msg.content;
  console.log("正文类型:", Array.isArray(content) ? "数组" : typeof content,
    " 正文字符数:", typeof content === "string" ? content.length : "-");
  const rc = msg.reasoning_content;
  console.log("reasoning_content:", rc == null ? "无" : ("有，" + String(rc).length + " 字符"));
  const det = j.usage && j.usage.completion_tokens_details;
  console.log("reasoning_tokens:", det && typeof det.reasoning_tokens === "number" ? det.reasoning_tokens : "无");
  const u = j.usage || {};
  console.log("usage: prompt", u.prompt_tokens || 0, "/ completion", u.completion_tokens || 0, "/ total", u.total_tokens || 0);
  let inner = null;
  try { inner = JSON.parse(content); console.log("正文可解析为 JSON"); }
  catch { console.log("正文不是合法 JSON"); return; }
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) { console.log("正文 JSON 不是对象"); return; }
  console.log("正文顶层字段名:", Object.keys(inner).join(", "));
  for (const f of ["summary", "goodScripts", "problems", "pendingAV", "verification"]) {
    const v = inner[f];
    console.log("  " + f + ":", v == null ? "缺失"
      : ("存在（" + (Array.isArray(v) ? "数组×" + v.length : typeof v) + "）"));
  }
  for (const k of Object.keys(inner)) {
    const v = inner[k];
    if (v && typeof v === "object" && !Array.isArray(v) && v.goodScripts != null) {
      console.log("  发现嵌套: 字段 \"" + k + "\" 内含 goodScripts → 疑似多包了一层");
    }
  }
}

function saveRawResponse({ status, ms, raw, model }) {
  const file = path.join(APP_SUPPORT, "diag-response-" + Date.now() + ".json");
  fs.writeFileSync(file, JSON.stringify({ status, ms, raw, model, at: new Date().toISOString() }));
  console.log("  原始响应已保存:", file, "（离线检查: node test/diagnose-node.js --inspect <文件>）");
}

async function main() {
  // 离线结构检查：不联网、不读密钥
  if (process.argv[2] === "--inspect") {
    inspectFile(process.argv[3]);
    return;
  }
  const { apiBase, apiKey, model } = loadSecrets();
  console.log("apiBase:", apiBase);
  console.log("model:", model);
  console.log("注：callDeepSeek 业务默认超时 30 秒；本诊断用 90 秒上限测真实耗时（单次样本，仅供决策参考）。");

  // [1] 最小测试：业务原函数 + 与 JSON 模式匹配的 prompt
  console.log("\n[1] callDeepSeek 最小测试（prompt 要求只返回 JSON，与 response_format 匹配）");
  {
    const t0 = Date.now();
    try {
      const { content, usage } = await Analysis.callDeepSeek({
        apiBase, apiKey, model, prompt: JSON_TEST_PROMPT, timeoutMs: DIAG_TIMEOUT_MS,
      });
      console.log("  结果: 成功，耗时", Date.now() - t0, "ms");
      console.log("  content 长度:", (content || "").length, "字符");
      let isJson = false;
      try { JSON.parse(content); isJson = true; } catch { /* 非 JSON */ }
      console.log("  content 是否为合法 JSON:", isJson ? "是" : "否");
      console.log("  usage:", JSON.stringify({ p: usage.prompt_tokens || 0, c: usage.completion_tokens || 0 }));
    } catch (e) {
      console.log("  结果: 失败，耗时", Date.now() - t0, "ms，错误:", e.message);
    }
  }

  // [2] 思考迹象检查：只报告"观察到/未观察到"，不下断言
  console.log("\n[2] 思考迹象检查（原始响应结构）");
  {
    const r = await rawChatOnce({ apiBase, apiKey, model, prompt: JSON_TEST_PROMPT, timeoutMs: DIAG_TIMEOUT_MS });
    if (!r.ok) {
      console.log("  请求失败:", r.err || ("HTTP " + r.status), "耗时", r.ms, "ms");
    } else {
      let j = null;
      try { j = JSON.parse(r.raw); } catch { /* 解析失败 */ }
      const msg = j && j.choices && j.choices[0] && j.choices[0].message;
      if (!msg) {
        console.log("  响应解析失败，耗时", r.ms, "ms");
      } else {
        const rc = msg.reasoning_content;
        const rt = j.usage && j.usage.completion_tokens_details &&
          j.usage.completion_tokens_details.reasoning_tokens;
        console.log("  HTTP 200，耗时", r.ms, "ms");
        if (rc != null && String(rc).length > 0) {
          console.log("  观察到 reasoning_content（" + String(rc).length + " 字符）→ 模型有思考输出，需研究非思考参数配置。");
        } else if (typeof rt === "number" && rt > 0) {
          console.log("  观察到 reasoning_tokens=" + rt + " → 模型有思考消耗，需研究非思考参数配置。");
        } else {
          console.log("  未观察到 reasoning_content / reasoning_tokens。注意：网关可能不透传思考字段，不能据此断定模型未思考；如需确认，结合响应延迟与平台文档再判断。");
        }
        console.log("  content 长度:", String(msg.content || "").length, "字符");
      }
    }
  }

  // [3] 真实复盘请求：必须显式指定场次与范围，展示条数后确认才发送
  console.log("\n[3] 真实复盘请求检查（需显式参数）");
  const sessionId = process.argv[2];
  const rangeStartMs = Number(process.argv[3]);
  const rangeEndMs = Number(process.argv[4]);
  if (!sessionId || !Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs) || rangeEndMs <= rangeStartMs) {
    console.log("  未提供有效参数，本步跳过（不发送任何真实数据）。");
    console.log("  用法: node test/diagnose-node.js <sessionId> <startMs> <endMs>（毫秒，相对场次开始）");
    return;
  }
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(path.join(sessionDir, "transcript.jsonl"))) {
    console.log("  找不到该场次的 transcript.jsonl，本步跳过。");
    return;
  }
  const { evidence, totalChars } = Analysis.collectEvidence(sessionDir, rangeStartMs, rangeEndMs);
  console.log("  场次:", sessionId, "；范围:", evidence.range.label);
  console.log("  证据条数: 转写", evidence.transcripts.length, "、弹幕", evidence.danmaku.length,
    "、商品", evidence.products.length, "、在线采样", evidence.online.length);
  console.log("  证据字符数:", totalChars);
  if (!Analysis.hasAnalyzable(evidence)) {
    console.log("  该范围无可分析内容，本步结束（未发送）。");
    return;
  }
  // 保留业务的证据长度限制（与 analyzeRange 的 TOO_LARGE 同口径）
  if (totalChars > Analysis.MAX_EVIDENCE_CHARS) {
    console.log("  证据超过业务上限 " + Analysis.MAX_EVIDENCE_CHARS + " 字符，按业务规则应缩小范围，本步结束（未发送）。");
    return;
  }
  const root = path.join(__dirname, "..");
  const prompt = Analysis.buildPrompt(
    evidence,
    fs.readFileSync(path.join(root, "analysis-rules-base-v1.md"), "utf8"),
    fs.readFileSync(path.join(root, "analysis-rules-scarf-v1.md"), "utf8"));
  console.log("  完整 prompt 输入字符数:", prompt.length);
  console.log("  输出上限: 代码未设置 max_tokens，输出上限为模型默认；实测以 usage.completion_tokens 为准。");
  const ans = await ask("  以上范围将发送给模型做一次真实分析（付费，一次，不重试）。确认发送请输入 y 后回车：");
  if (String(ans).trim().toLowerCase() !== "y") {
    console.log("  已取消，未发送。");
    return;
  }
  {
    // 用与 callDeepSeek 相同请求体的原始调用：业务函数本身已在 [1] 验证，
    // 这里需要保留 finish_reason、reasoning_content 等原始字段供结构检查
    console.log("  说明: 本步用与 callDeepSeek 相同请求体的原始调用（保留原始响应字段）；业务函数本身已在 [1] 验证。");
    const r = await rawChatOnce({ apiBase, apiKey, model, prompt, timeoutMs: DIAG_TIMEOUT_MS });
    const ms = r.ms;
    if (!r.ok) {
      console.log("  结果: 失败，本次耗时", ms, "ms，", r.err ? ("错误: " + r.err) : ("HTTP " + r.status));
      if (r.raw) saveRawResponse({ status: r.status, ms, raw: r.raw, model });
      if (r.err === "timeout") {
        console.log("  超时参考: 90 秒上限内仍超时。不能据此认定改参数即可解决；可能涉及模型生成慢或网关排队，需进一步排查。");
      }
    } else {
      saveRawResponse({ status: r.status, ms, raw: r.raw, model });
      let j = null;
      try { j = JSON.parse(r.raw); } catch { /* 非 JSON */ }
      const msg = j && j.choices && j.choices[0] && j.choices[0].message;
      const content = msg && msg.content;
      const usage = (j && j.usage) || {};
      console.log("  结果: 成功，本次耗时", ms, "ms；usage prompt/completion:",
        (usage.prompt_tokens || 0) + "/" + (usage.completion_tokens || 0),
        "；finish_reason:", j && j.choices && j.choices[0] && j.choices[0].finish_reason);
      let verdict;
      try {
        const parsed = JSON.parse(content);
        const v = Analysis.validateModelOutput(parsed, Analysis.buildEvidenceByRef(evidence));
        verdict = v.ok ? "结构校验通过" : ("结构校验失败: " + v.errors.slice(0, 3).join("；"));
      } catch {
        verdict = "返回不是合法 JSON";
      }
      console.log("  输出校验:", verdict);
      console.log("  超时参考: 本次", ms, "ms。单次样本不能证明 30 秒长期够用或不够用；",
        ms > 30000 ? "本次已超过 30 秒，说明现超时对这类请求至少偶发不足，可考虑放宽到 90 秒再观察。" : "本次在 30 秒内，但样本不足以下结论，建议多测几场再决定。");
    }
  }
}

main().catch(e => { console.error("[ERR]", e.message); process.exit(1); });
