#!/usr/bin/env node
/**
* 离线整理已保存的真实响应（不调用 API、不改业务代码）：
* node test/organize-responses.js <sessionId> <startMs> <endMs> [响应文件1] [响应文件2]
* 不给文件路径时，自动取最新的两个 diag-response-*.json。
* sessionId/startMs/endMs 须与当时 [3] 运行一致，用于把 refs 还原成原文与时间。
*
* 每份输出：
* 1. 好话术原文及时间定位
* 2. 为什么值得保留
* 3. 可复用骨架和适用条件
* 4. 问题判断与依据
* 两份分开标注（同一片段的第 N 次分析），不合并；缺失如实标注；不新增分析。
*/
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_SUPPORT = path.join(os.homedir(), "Library", "Application Support", "LiveRoomListener");
const SESSIONS_DIR = path.join(APP_SUPPORT, "sessions");
const Analysis = require(path.join(__dirname, "..", "analysis.js"));

const TYPE_LABEL = { filler: "无效口水话", imagery: "美感没讲出来", engagement: "缺少观众参与感"};

function latestTwo() {
const files = fs.readdirSync(APP_SUPPORT)
.filter(f => f.startsWith("diag-response-") && f.endsWith(".json"))
.map(f => path.join(APP_SUPPORT, f))
.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
return files.slice(-2);
}

function loadOne(file, evidence) {
const saved = JSON.parse(fs.readFileSync(file, "utf8"));
const out = { file: path.basename(file), at: saved.at, ms: saved.ms,
model: saved.model, thinkingDisableRequested:!!saved.thinkingDisableRequested,
status: saved.status, errors: [], result: null};
let j = null;
try { j = JSON.parse(saved.raw);} catch { out.errors.push("响应体不是合法 JSON"); return out;}
const msg = j && j.choices && j.choices[0] && j.choices[0].message;
if (!msg || typeof msg.content!== "string") { out.errors.push("响应无合法 content"); return out;}
let parsed = null;
try { parsed = JSON.parse(msg.content);}
catch { out.errors.push("正文不是合法 JSON"); return out;}
out.result = parsed;
const v = Analysis.validateModelOutput(parsed, Analysis.buildEvidenceByRef(evidence));
out.errors = v.errors;
out.valid = v.ok;
return out;
}

function line(s) { console.log(s);}

function renderOne(n, r) {
line("＝".repeat(24) + " 第" + n + "次分析（同一片段） " + "＝".repeat(24));
line("来源: " + r.file + " ｜ 时间: " + (r.at || "未知") + " ｜ 耗时: " + r.ms + "ms" +
" ｜ thinkingDisableRequested: " + (r.thinkingDisableRequested? "是": "否"));
line("结构校验: " + (r.result? (r.valid? "通过": "失败——" + r.errors.slice(0, 3).join("；")): "无可用正文——" + r.errors.join("；")));
const res = r.result || {};

if (res.summary) { line(""); line("\u3010本段摘要\u3011" + res.summary);}

// 1. 好话术原文及时间定位
line(""); line("\u3010一、好话术原文及时间定位\u3011");
if (!Array.isArray(res.goodScripts)) {
line(" 缺失：模型未返回 goodScripts 字段。");
} else if (!res.goodScripts.length) {
line(" 模型返回空数组：本轮未发现值得复用的好话术。");
} else {
res.goodScripts.forEach((g, i) => {
const gap = g.hasGap? "（引用中间有跳过，以 … 标示）": "";
line(" (" + (i + 1) + ") [" + (g.startLabel || "?") + " – " + (g.endLabel || "?") + "] refs=" +
(Array.isArray(g.refs)? g.refs.join(","): "?") + gap);
line(" 「" + (g.text || "") + "」");
if (g.asrNotes) line(" ASR 标注: " + g.asrNotes);
});
}

// 2. 为什么值得保留
line(""); line("\u3010二、为什么值得保留\u3011");
if (Array.isArray(res.goodScripts) && res.goodScripts.length) {
res.goodScripts.forEach((g, i) => line(" (" + (i + 1) + ") " + (g.whyKeep || "（模型未填写）")));
} else {
line(" 无（好话术缺失或为空）。");
}

// 3. 可复用骨架和适用条件
line(""); line("\u3010三、可复用骨架和适用条件\u3011");
if (Array.isArray(res.goodScripts) && res.goodScripts.length) {
res.goodScripts.forEach((g, i) => {
line(" (" + (i + 1) + ") 骨架: " + (g.reusableFrame || "（模型未填写）"));
line(" 适用: " + (g.appliesTo || "（模型未填写）"));
});
} else {
line(" 无（好话术缺失或为空）。");
}

// 4. 问题判断与依据
line(""); line("\u3010四、问题判断与依据\u3011");
if (!Array.isArray(res.problems)) {
line(" 缺失：模型未返回 problems 字段。");
} else if (!res.problems.length) {
line(" 模型返回空数组：本轮未发现明显问题。");
} else {
res.problems.forEach((p, i) => {
line(" (" + (i + 1) + ") [" + (TYPE_LABEL[p.type] || p.type || "?") + "] [" +
(p.startLabel || "?") + " – " + (p.endLabel || "?") + "]");
if (p.text) line(" 「" + p.text + "」");
line(" 依据: " + (p.description || "（模型未填写）"));
});
}
if (Array.isArray(res.pendingAV) && res.pendingAV.length) {
line(" 待音视频分析:");
res.pendingAV.forEach(s => line(" - " + s));
} else if (!Array.isArray(res.pendingAV)) {
line(" 待音视频分析: 缺失（模型未返回该字段）。");
}
line(""); line("\u3010下次验证\u3011" + (res.verification || "缺失：模型未返回该字段。"));
line("");
}

function main() {
const sessionId = process.argv[2];
const startMs = Number(process.argv[3]);
const endMs = Number(process.argv[4]);
if (!sessionId ||!Number.isFinite(startMs) ||!Number.isFinite(endMs)) {
console.error("用法: node test/organize-responses.js <sessionId> <startMs> <endMs> [响应文件1] [响应文件2]");
process.exit(1);
}
const sessionDir = path.join(SESSIONS_DIR, sessionId);
const { evidence} = Analysis.collectEvidence(sessionDir, startMs, endMs);

let files = process.argv.slice(5, 7);
if (!files.length) {
files = latestTwo();
if (files.length < 2) { console.error("应用数据目录下找不到两个 diag-response 文件，请显式传入路径。"); process.exit(1);}
console.log("自动选取最新的两个响应文件:");
files.forEach(f => console.log(" " + path.basename(f)));
console.log("");
}
const items = files.map(f => loadOne(f, evidence));
items.forEach((r, i) => renderOne(i + 1, r));
console.log("注：以上为两次独立分析结果的原文整理，未合并、未新增判断；缺失处已如实标注。");
}

main();
