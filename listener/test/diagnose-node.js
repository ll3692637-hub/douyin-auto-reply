#!/usr/bin/env node
/**
 * Node 侧 API 诊断（Mac 本地运行）：
 *   cd <项目>/listener && node test/diagnose-node.js [sessionId]
 *
 * 做了什么（每步最多请求一次，不自动重试）：
 *  [1] 用业务原函数 callDeepSeek 发最小测试（"回复 OK"），90 秒上限
 *  [2] 用与 callDeepSeek 完全相同的请求体做一次原始请求，只检查响应里
 *      是否含 reasoning_content（思考字段）——核实是否为非思考输出
 *  [3] 取最新（或指定）会话的真实 2 分钟证据，用业务原函数 buildPrompt
 *      构造真实复盘请求：统计输入字符数，说明输出上限，再用 callDeepSeek
 *      实发一次（90 秒上限），记录耗时与 token 用量，并做结构校验
 *
 * 日志铁律：绝不输出密钥和直播原文，只输出计数、耗时、状态、错误码。
 * 成本：共 3 次小额/真实请求（[3] 为一次真实 2 分钟分析调用）。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");

const APP_SUPPORT = path.join(os.homedir(), "Library", "Application Support", "LiveRoomListener");
const SECRETS = path.join(APP_SUPPORT, "analysis-secrets.json");
const SESSIONS_DIR = path.join(APP_SUPPORT, "sessions");
const Analysis = require(path.join(__dirname, "..", "analysis.js"));
const DIAG_TIMEOUT_MS = 90000;

function loadSecrets() {
  const s = JSON.parse(fs.readFileSync(SECRETS, "utf8"));
  if (!s.apiBase || !s.apiKey) { console.error("[ERR] 缺少 apiBase/apiKey"); process.exit(1); }
  if (!s.model) { console.error("[ERR] model 为空"); process.exit(1); }
  return { apiBase: String(s.apiBase), apiKey: String(s.apiKey), model: String(s.model) };
}

// 与 callDeepSeek 完全相同的请求体，用于检查原始响应结构（含思考字段）
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
    req.on("error", (e) => resolve({ ok: false, status: null, ms: Date.now() - t0, err: "request_error" }));
    req.write(body);
    req.end();
  });
}

function findLatestSession() {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  const cands = fs.readdirSync(SESSIONS_DIR)
    .map(name => path.join(SESSIONS_DIR, name))
    .filter(d => { try { return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, "transcript.jsonl")); } catch { return false; } });
  if (!cands.length) return null;
  cands.sort((a, b) => fs.statSync(path.join(b, "transcript.jsonl")).mtimeMs - fs.statSync(path.join(a, "transcript.jsonl")).mtimeMs);
  return cands[0];
}

async function main() {
  const { apiBase, apiKey, model } = loadSecrets();
  console.log("apiBase:", apiBase);
  console.log("model:", model);
  console.log("注：callDeepSeek 默认 30 秒超时；本诊断统一用 90 秒上限测真实耗时，再决定是否调整。");

  // [1] 最小测试：业务原函数
  console.log("\n[1] callDeepSeek 最小测试（prompt=回复 OK）");
  {
    const t0 = Date.now();
    try {
      const { content, usage } = await Analysis.callDeepSeek({
        apiBase, apiKey, model, prompt: "回复 OK", timeoutMs: DIAG_TIMEOUT_MS,
      });
      console.log("  结果: 成功，耗时", Date.now() - t0, "ms");
      console.log("  content 长度:", (content || "").length, "字符");
      console.log("  usage:", JSON.stringify({ p: usage.prompt_tokens || 0, c: usage.completion_tokens || 0 }));
    } catch (e) {
      console.log("  结果: 失败，耗时", Date.now() - t0, "ms，错误:", e.message);
    }
  }

  // [2] 思考字段检查：原始响应里有没有 reasoning_content
  console.log("\n[2] 非思考输出核实（原始响应结构检查）");
  {
    const r = await rawChatOnce({ apiBase, apiKey, model, prompt: "回复 OK", timeoutMs: DIAG_TIMEOUT_MS });
    if (!r.ok) {
      console.log("  请求失败:", r.err || ("HTTP " + r.status), "耗时", r.ms, "ms");
    } else {
      let msg = null;
      try { msg = JSON.parse(r.raw).choices[0].message; } catch { /* 解析失败 */ }
      if (!msg) {
        console.log("  响应解析失败，耗时", r.ms, "ms");
      } else {
        const hasReasoning = msg.reasoning_content != null && String(msg.reasoning_content).length > 0;
        console.log("  HTTP 200，耗时", r.ms, "ms");
        console.log("  reasoning_content:", hasReasoning ? ("存在（" + String(msg.reasoning_content).length + " 字符）→ 模型在思考，需配置非思考参数") : "无 → 当前即为非思考输出，无需额外参数");
        console.log("  content 长度:", String(msg.content || "").length, "字符");
      }
    }
  }

  // [3] 真实复盘请求：输入字符数 / 输出上限 / 耗时
  console.log("\n[3] 真实 2 分钟复盘请求检查");
  const sessionIdArg = process.argv[2];
  const sessionDir = sessionIdArg ? path.join(SESSIONS_DIR, sessionIdArg) : findLatestSession();
  if (!sessionDir || !fs.existsSync(path.join(sessionDir, "transcript.jsonl"))) {
    console.log("  无可用会话（需要至少一场有转写的监听），跳过本步。");
    return;
  }
  console.log("  会话:", path.basename(sessionDir));
  const firstLine = fs.readFileSync(path.join(sessionDir, "transcript.jsonl"), "utf8").split("\n").find(l => l.trim());
  const rangeStartMs = firstLine ? (JSON.parse(firstLine).offsetMs || 0) : 0;
  const rangeEndMs = rangeStartMs + 120000;
  const { evidence, evidenceHash, totalChars } = Analysis.collectEvidence(sessionDir, rangeStartMs, rangeEndMs);
  if (!Analysis.hasAnalyzable(evidence)) {
    console.log("  该范围无可分析内容，跳过本步。");
    return;
  }
  const root = path.join(__dirname, "..");
  const prompt = Analysis.buildPrompt(
    evidence,
    fs.readFileSync(path.join(root, "analysis-rules-base-v1.md"), "utf8"),
    fs.readFileSync(path.join(root, "analysis-rules-scarf-v1.md"), "utf8"));
  console.log("  证据字符数:", totalChars, "；完整 prompt 输入字符数:", prompt.length);
  console.log("  输出上限: 代码未设置 max_tokens，输出上限为模型默认；实测以 usage.completion_tokens 为准。");
  console.log("  正在发送真实分析请求（90 秒上限，一次性，不重试）…");
  {
    const t0 = Date.now();
    try {
      const { content, usage } = await Analysis.callDeepSeek({
        apiBase, apiKey, model, prompt, timeoutMs: DIAG_TIMEOUT_MS,
      });
      const ms = Date.now() - t0;
      const p = usage.prompt_tokens || 0, c = usage.completion_tokens || 0;
      console.log("  结果: 成功，耗时", ms, "ms；usage prompt/completion:", p + "/" + c);
      let verdict = "";
      try {
        const parsed = JSON.parse(content);
        const v = Analysis.validateModelOutput(parsed, Analysis.buildEvidenceByRef(evidence));
        verdict = v.ok ? "结构校验通过" : ("结构校验失败: " + v.errors.slice(0, 3).join("；"));
      } catch {
        verdict = "返回不是合法 JSON";
      }
      console.log("  输出校验:", verdict);
      console.log("  超时结论:", ms <= 25000
        ? "耗时 < 30s，现 30 秒超时够用，无需调整。"
        : "耗时超过/接近 30s，建议将 MODEL_TIMEOUT_MS 从 30000 改为 90000。");
    } catch (e) {
      const ms = Date.now() - t0;
      console.log("  结果: 失败，耗时", ms, "ms，错误:", e.message);
      if (/超时/.test(e.message)) console.log("  超时结论: 30 秒不够，建议将 MODEL_TIMEOUT_MS 改为 90000。");
    }
  }
}

main().catch(e => { console.error("[ERR]", e.message); process.exit(1); });
