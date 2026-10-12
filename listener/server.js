// =============================================
// LiveRoomListener - Mac 本地监听服务
// 仅监听 127.0.0.1:17842，不暴露局域网端口
// 从 ~/Library/Application Support/LiveRoomListener/asr-secrets.json 读取密钥
// 绝不打印、复制、提交密钥内容
// =============================================

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = Number(process.env.LISTENER_PORT || 17842);
const HOST = "127.0.0.1";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024; // 腾讯云一句话识别本地音频上限 3MB
const MAX_VISUAL_BYTES = 2 * 1024 * 1024; // /visual 请求上限（含 base64 截图）
const MAX_FRAME_BYTES = 1536 * 1024; // 单张截图上限 1.5MB（1280x720 q0.7 约 80-150KB）

// 路径常量
const APP_SUPPORT = process.env.LISTENER_DATA_DIR
  ? path.resolve(process.env.LISTENER_DATA_DIR)
  : path.join(os.homedir(), "Library", "Application Support", "LiveRoomListener");
const SECRETS_PATH = path.join(APP_SUPPORT, "asr-secrets.json");
const SESSIONS_DIR = path.join(APP_SUPPORT, "sessions");
// 识别档案目录（随代码发布，可提交）；asr-secrets.json 等用户数据绝不提交
const PROFILES_DIR = path.join(__dirname, "profiles");
// 账号名单（用户私有配置，不提交；见 accounts.example.json）
const ACCOUNTS_PATH = path.join(__dirname, "accounts.json");

const { washText } = require("./textnorm");

// =============================================
// 密钥读取（仅在此处读取，不输出内容）
// =============================================

let cachedCredentials = null;

function loadCredentials() {
  if (cachedCredentials) return cachedCredentials;
  try {
    const raw = fs.readFileSync(SECRETS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.tencentAsr || !parsed.tencentAsr.appId || !parsed.tencentAsr.secretId || !parsed.tencentAsr.secretKey) {
      throw new Error("credentials incomplete");
    }
    cachedCredentials = parsed.tencentAsr;
    return cachedCredentials;
  } catch (e) {
    cachedCredentials = null;
    throw new Error("ASR secrets file is unavailable or invalid");
  }
}

// =============================================
// 识别档案（Recognition Profile）
// 本地 JSON 配置：热词给腾讯云识别时用，norm_terms 给"洗一遍"用。
// 不把任何品类词汇写死在代码中；无档案时退回通用识别。
// =============================================

let cachedProfiles = null;

function loadProfiles() {
  if (cachedProfiles) return cachedProfiles;
  cachedProfiles = {};
  try {
    const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith(".json"));
    for (const f of files) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), "utf-8"));
        if (p && p.id) cachedProfiles[p.id] = p;
      } catch (e) { /* 单个档案损坏不影响其他 */ }
    }
  } catch (e) { /* 目录缺失则空档案 */ }
  // 兜底：至少保证 general 存在
  if (!cachedProfiles.general) {
    cachedProfiles.general = { id: "general", name: "通用", engine: "16k_zh", hotwords: [], norm_terms: [] };
  }
  return cachedProfiles;
}

function getProfile(profileId) {
  const profiles = loadProfiles();
  return profiles[profileId] || profiles.general;
}

/**
 * 拼装腾讯云 HotwordList 参数："热词|权重,热词|权重"
 * 档案热词 + 本场临时关键词（权重默认 6，可单独指定 "词|权重"）
 * 腾讯云限制单个热词 ≤30 字符（最多 10 个汉字）；超长词跳过并告警，不截断，
 * 避免用户误粘整段话术导致真实请求报参数错误。
 */
function isValidHotword(term) {
  if (term.length > 30) return false;
  const cjkCount = (term.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjkCount > 10) return false;
  return true;
}

function buildHotwordList(profile, sessionKeywords) {
  const parts = [];
  const seen = new Set();
  const push = (term, weight) => {
    term = String(term || "").trim();
    if (!term || seen.has(term)) return;
    if (!isValidHotword(term)) {
      console.warn(`[Listener] 跳过超长热词 (${term.length}字符): "${term.slice(0, 24)}..."`);
      return;
    }
    seen.add(term);
    let w = Number(weight);
    // 官方合法值：1-11 或 100；非法值钳制到 6
    if (!(w >= 1 && w <= 11) && w !== 100) w = 6;
    parts.push(`${term}|${w}`);
  };
  for (const h of (profile && profile.hotwords) || []) push(h.term, h.weight);
  for (const k of sessionKeywords || []) {
    if (typeof k === "string" && k.includes("|")) {
      const [t, w] = k.split("|");
      push(t, w);
    } else {
      push(k, 6);
    }
  }
  return parts.slice(0, 128).join(",");
}

// =============================================
// 账号名单（TASK-DANMAKU-001）
// anchor_uids: 主播/场控账号；water_army_uids: 水军号；rooms: 生效直播间 roomId
// 文件缺失 = 不启用过滤（fail-open，全部按 audience 处理）
// =============================================

function loadAccounts() {
  try {
    const a = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf-8"));
    return {
      anchor_uids: Array.isArray(a.anchor_uids) ? a.anchor_uids.map(String) : [],
      water_army_uids: Array.isArray(a.water_army_uids) ? a.water_army_uids.map(String) : [],
      rooms: Array.isArray(a.rooms) ? a.rooms.map(String) : []
    };
  } catch (e) {
    return { anchor_uids: [], water_army_uids: [], rooms: [] };
  }
}

function getDanmakuRole(userId) {
  const uid = String(userId || "");
  if (!uid) return "audience";
  const acc = loadAccounts();
  if (acc.anchor_uids.includes(uid)) return "anchor";
  if (acc.water_army_uids.includes(uid)) return "water_army";
  return "audience";
}

// =============================================
// 腾讯云 ASR - 一句话识别（短 PCM 音频）
// 使用 TC3-HMAC-SHA256 签名，无需 SDK 依赖
// =============================================

const ASR_ENDPOINT = "asr.tencentcloudapi.com";

function sha256Hex(message) {
  return crypto.createHash("sha256").update(message, "utf8").digest("hex");
}

function hmacSHA256(key, message) {
  return crypto.createHmac("sha256", key).update(message, "utf8").digest();
}

function tc3Sign(creds, payload) {
  const service = "asr";
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const action = "SentenceRecognition";
  const version = "2019-06-14";

  // 1. 拼接规范请求串
  const httpRequestMethod = "POST";
  const canonicalUri = "/";
  const canonicalQueryString = "";
  // 腾讯云标准 TC3 示例只签 Content-Type 与 Host。
  const canonicalHeaders = "content-type:application/json; charset=utf-8\n" +
    `host:${ASR_ENDPOINT}\n`;
  const signedHeaders = "content-type;host";
  const hashedRequestPayload = sha256Hex(payload);

  const canonicalRequest = httpRequestMethod + "\n" +
    canonicalUri + "\n" +
    canonicalQueryString + "\n" +
    canonicalHeaders + "\n" +
    signedHeaders + "\n" +
    hashedRequestPayload;

  // 2. 拼接签名串
  const algorithm = "TC3-HMAC-SHA256";
  const credentialScope = date + "/" + service + "/tc3_request";
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = algorithm + "\n" +
    timestamp + "\n" +
    credentialScope + "\n" +
    hashedCanonicalRequest;

  // 3. 计算签名
  const secretDate = hmacSHA256(Buffer.from("TC3" + creds.secretKey, "utf8"), date);
  const secretService = hmacSHA256(secretDate, service);
  const secretSigning = hmacSHA256(secretService, "tc3_request");
  const signature = crypto.createHmac("sha256", secretSigning).update(stringToSign, "utf8").digest("hex");

  // 4. Authorization 头
  const authorization = algorithm + " " +
    "Credential=" + creds.secretId + "/" + credentialScope + ", " +
    "SignedHeaders=" + signedHeaders + ", " +
    "Signature=" + signature;

  return {
    authorization,
    timestamp,
    action,
    version
  };
}

function callSentenceRecognition(creds, pcmBuffer, sampleRate, seq, hotwordList) {
  return new Promise((resolve, reject) => {
    const audioBase64 = pcmBuffer.toString("base64");
    if (sampleRate !== 16000) {
      return reject(new Error("only 16kHz PCM is supported"));
    }
    const params = {
      EngSerViceType: "16k_zh",
      SourceType: 1,
      VoiceFormat: "pcm",
      ProjectId: 0,
      SubServiceType: 2,
      Data: audioBase64,
      DataLen: pcmBuffer.length
    };
    // 临时热词表（识别档案 + 本场关键词）；无热词时不传该参数
    if (hotwordList) params.HotwordList = hotwordList;
    const payload = JSON.stringify(params);

    const sign = tc3Sign(creds, payload);

    const options = {
      hostname: ASR_ENDPOINT,
      port: 443,
      path: "/",
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Host": ASR_ENDPOINT,
        "X-TC-Action": sign.action,
        "X-TC-Version": sign.version,
        "X-TC-Timestamp": String(sign.timestamp),
        "Authorization": sign.authorization
      }
    };

    const https = require("https");
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (result.Response) {
            if (result.Response.Error) {
              reject(new Error("ASR error: " + result.Response.Error.Code + " - " + result.Response.Error.Message));
            } else {
              resolve({
                text: result.Response.Result || "",
                requestId: result.Response.RequestId || "",
                audioDuration: result.Response.AudioDuration || 0
              });
            }
          } else {
            reject(new Error("ASR unexpected response format"));
          }
        } catch (e) {
          reject(new Error("ASR response parse error: " + e.message));
        }
      });
    });

    req.on("error", (e) => {
      reject(new Error("ASR network error: " + e.message));
    });

    req.setTimeout(30000, () => {
      req.destroy(new Error("ASR timeout (30s)"));
    });

    req.write(payload);
    req.end();
  });
}

function transcribeAudio(pcmBuffer, sampleRate, seq, ctx) {
  ctx = ctx || {};
  // 仅供自动化测试使用：测试进程显式开启，绝不会请求腾讯云或读取用户密钥。
  // [MOCK] 标记：日志与返回中明确标识，避免与真实转写混淆。
  if (process.env.LISTENER_TEST_MODE === "1") {
    return Promise.resolve({
      text: "模拟转写 #" + seq,
      requestId: "mock-request-" + seq,
      audioDuration: 1,
      mock: true,
      hotwordList: ctx.hotwordList || ""
    });
  }
  return callSentenceRecognition(loadCredentials(), pcmBuffer, sampleRate, seq, ctx.hotwordList);
}

// =============================================
// 会话管理
// =============================================

const activeSessions = new Map();

function assertSessionId(sessionId) {
  if (typeof sessionId !== "string" || !/^session_[A-Za-z0-9_-]{8,96}$/.test(sessionId)) {
    throw new Error("invalid sessionId");
  }
}

function persistSession(session) {
  fs.writeFileSync(path.join(session.dir, "session.json"), JSON.stringify(session.info, null, 2));
}

function createSession(sessionId, meta) {
  assertSessionId(sessionId);
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  // 识别档案快照：本场实际使用的档案 ID + 版本 + 本场临时关键词
  // 快照写入 session.json，事后可追溯；原始档案文件后续修改不影响已存快照
  const profile = getProfile(meta.profileId);
  const sessionKeywords = Array.isArray(meta.sessionKeywords)
    ? meta.sessionKeywords.map(String).slice(0, 64) : [];

  const sessionInfo = {
    sessionId,
    startTime: meta.startTime || Date.now(),
    endTime: null,
    tabId: meta.tabId || null,
    danmakuCount: 0,
    transcriptCount: 0,
    audioChunks: 0,
    profileSnapshot: {
      profileId: profile.id,
      profileName: profile.name,
      engine: profile.engine,
      hotwordCount: (profile.hotwords || []).length,
      sessionKeywords
    }
  };

  fs.writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify(sessionInfo, null, 2));
  // 创建空文件
  fs.writeFileSync(path.join(sessionDir, "danmaku.jsonl"), "");
  fs.writeFileSync(path.join(sessionDir, "transcript.jsonl"), "");
  fs.writeFileSync(path.join(sessionDir, "visual.jsonl"), "");
  fs.writeFileSync(path.join(sessionDir, "product.jsonl"), "");

  activeSessions.set(sessionId, { dir: sessionDir, info: sessionInfo });
  return activeSessions.get(sessionId);
}

function getSession(sessionId) {
  assertSessionId(sessionId);
  if (activeSessions.has(sessionId)) return activeSessions.get(sessionId);
  // 尝试从磁盘恢复
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  if (fs.existsSync(path.join(sessionDir, "session.json"))) {
    const info = JSON.parse(fs.readFileSync(path.join(sessionDir, "session.json"), "utf-8"));
    const session = { dir: sessionDir, info };
    activeSessions.set(sessionId, session);
    return session;
  }
  return null;
}

function appendDanmaku(sessionId, danmaku) {
  const session = getSession(sessionId);
  if (!session) return;
  // TASK-DANMAKU-001：server 端打标（供复盘分析用）；
  // 自动回复的跳过判定在浏览器 Service Worker 内做（见 service_worker.js）。
  const line = JSON.stringify({ ...danmaku, role: getDanmakuRole(danmaku.userId) }) + "\n";
  fs.appendFileSync(path.join(session.dir, "danmaku.jsonl"), line);
  session.info.danmakuCount++;
  persistSession(session);
}

function appendTranscript(sessionId, entry) {
  const session = getSession(sessionId);
  if (!session) return;
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(path.join(session.dir, "transcript.jsonl"), line);
  session.info.transcriptCount++;
  persistSession(session);
}

// TASK-VISUAL-TREND-001：画面/趋势快照追加
function appendVisual(sessionId, entry) {
  const session = getSession(sessionId);
  if (!session) return;
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(path.join(session.dir, "visual.jsonl"), line);
  session.info.visualCount = (session.info.visualCount || 0) + 1;
  persistSession(session);
}

// TASK-PRODUCT-001 修订版：讲解商品换品节点追加
function appendProduct(sessionId, entry) {
  const session = getSession(sessionId);
  if (!session) return;
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(path.join(session.dir, "product.jsonl"), line);
  session.info.productCount = (session.info.productCount || 0) + 1;
  persistSession(session);
}

function summarizePcm(pcmBuffer) {
  let peak = 0;
  let nonSilent = 0;
  let sumSquares = 0;
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    const magnitude = Math.abs(sample);
    peak = Math.max(peak, magnitude);
    if (magnitude > 64) nonSilent++;
    sumSquares += sample * sample;
  }
  const count = pcmBuffer.length / 2;
  return {
    peak,
    rms: count ? Math.round(Math.sqrt(sumSquares / count)) : 0,
    nonSilentPercent: count ? Math.round(nonSilent / count * 1000) / 10 : 0
  };
}

function finalizeSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;
  session.info.endTime = Date.now();
  persistSession(session);
  activeSessions.delete(sessionId);
}

// =============================================
// HTTP 服务器
// =============================================

const server = http.createServer(async (req, res) => {
  // 仅允许扩展页、本机复盘页或本机脚本调用；不向任意网页开放 CORS。
  // 注意：复盘页由本服务自身提供（同源），其 fetch 会带 Origin: http://127.0.0.1:PORT，
  // 必须放行，否则页面打不开 API。
  const origin = req.headers.origin;
  const selfOrigins = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`];
  const originOk = !origin || origin.startsWith("chrome-extension://") || selfOrigins.includes(origin);
  if (!originOk) {
    return sendJson(res, 403, { ok: false, error: "forbidden origin" });
  }

  // GET /health - 健康检查
  if (req.method === "GET" && req.url === "/health") {
    let asrReady = false;
    try { loadCredentials(); asrReady = true; } catch (e) {}
    return sendJson(res, 200, { ok: true, asrReady, port: PORT, host: HOST });
  }

  // GET /accounts - 账号名单（TASK-DANMAKU-001）
  // 供浏览器 Service Worker 同步，在发送前跳过主播号/水军号。
  // 仅本机 + 扩展来源可调用（走统一 Origin 校验）。
  if (req.method === "GET" && req.url === "/accounts") {
    return sendJson(res, 200, { ok: true, accounts: loadAccounts() });
  }

  // GET /profiles - 识别档案列表（调试/核对用，不含密钥）
  if (req.method === "GET" && req.url === "/profiles") {
    const profiles = loadProfiles();
    const list = Object.values(profiles).map(p => ({
      id: p.id, name: p.name, engine: p.engine,
      hotwordCount: (p.hotwords || []).length
    }));
    return sendJson(res, 200, { ok: true, profiles: list });
  }

  // POST /session/start
  if (req.method === "POST" && req.url === "/session/start") {
    try {
      const body = await readJsonBody(req);
      const session = createSession(body.sessionId, {
        startTime: body.startTime,
        tabId: body.tabId,
        profileId: body.profileId,
        sessionKeywords: body.sessionKeywords
      });
      console.log(`[Listener] 会话已创建: ${body.sessionId} (档案: ${session.info.profileSnapshot.profileId})`);
      return sendJson(res, 200, {
        ok: true,
        sessionId: body.sessionId,
        profileId: session.info.profileSnapshot.profileId
      });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // POST /session/stop
  if (req.method === "POST" && req.url === "/session/stop") {
    try {
      const body = await readJsonBody(req);
      finalizeSession(body.sessionId);
      console.log(`[Listener] 会话已结束: ${body.sessionId}`);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // POST /danmaku - 接收弹幕事件
  if (req.method === "POST" && req.url === "/danmaku") {
    try {
      const body = await readJsonBody(req);
      appendDanmaku(body.sessionId, {
        offsetMs: body.offsetMs,
        userName: body.userName,
        userId: body.userId,
        text: body.text,
        timestamp: body.timestamp
      });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // POST /audio - 接收 PCM 音频分片
  if (req.method === "POST" && req.url === "/audio") {
    try {
      const rawBuf = await readRawBody(req, MAX_AUDIO_BYTES);
      if (rawBuf.length < 5) throw new Error("invalid audio payload");
      // 解析协议: [4字节 header length][header JSON][PCM data]
      const headerLen = rawBuf.readUInt32LE(0);
      if (headerLen < 2 || headerLen > rawBuf.length - 4) throw new Error("invalid audio header");
      const headerJson = rawBuf.subarray(4, 4 + headerLen).toString("utf-8");
      const header = JSON.parse(headerJson);
      const pcmData = rawBuf.subarray(4 + headerLen);

      const { sessionId, sequence, sampleRate, audioStartMs } = header;
      assertSessionId(sessionId);
      if (!Number.isInteger(sequence) || sequence < 1) throw new Error("invalid sequence");
      if (sampleRate !== 16000 || pcmData.length === 0 || pcmData.length % 2 !== 0) throw new Error("invalid PCM chunk");
      if (!getSession(sessionId)) throw new Error("unknown session");

      const signal = summarizePcm(pcmData);
      console.log(`[Listener] 收到音频分片 #${sequence}, ${pcmData.length} bytes, 信号 RMS=${signal.rms}, 峰值=${signal.peak}, 非静音=${signal.nonSilentPercent}%, sessionId=${sessionId}`);

      // 调用腾讯云 ASR（带本场识别档案热词）
      let transcript = "";
      let asrError = null;
      try {
        const sess = getSession(sessionId);
        const snap = (sess && sess.info.profileSnapshot) || {};
        const profile = getProfile(snap.profileId);
        const hotwordList = buildHotwordList(profile, snap.sessionKeywords);

        const result = await transcribeAudio(pcmData, sampleRate, sequence, { hotwordList });
        transcript = result.text;
        const mockTag = result.mock ? "[MOCK] " : "";
        console.log(`[Listener] ${mockTag}ASR #${sequence}: "${transcript.slice(0, 60)}..."`);

        // "洗一遍"：本地别名清洗，原始文本永远保留在 text，清洗结果存 normText
        const washed = washText(transcript, profile.norm_terms || []);

        // 写入转写结果（带时间戳与诊断状态）
        // text = ASR 原始输出，永不覆盖；status: ok | empty | error
        appendTranscript(sessionId, {
          offsetMs: audioStartMs,
          sequence,
          text: transcript,
          normText: washed.replacements.length ? washed.text : null,
          normReplacements: washed.replacements,
          status: transcript ? "ok" : "empty",
          mock: !!result.mock,
          profileId: profile.id,
          durationMs: result.audioDuration || (pcmData.length / (sampleRate * 2) * 1000),
          requestId: result.requestId,
          timestamp: Date.now()
        });

        // 转写成功后删除原始音频（不长期保存）
        // PCM 数据在内存中，函数结束后自动释放
      } catch (asrErr) {
        asrError = asrErr.message;
        console.error(`[Listener] ASR #${sequence} 失败: ${safeError(asrErr)}`);
        // 记录失败（不含密钥内容）
        appendTranscript(sessionId, {
          offsetMs: audioStartMs,
          sequence,
          text: "",
          normText: null,
          normReplacements: [],
          status: "error",
          mock: false,
          error: asrError,
          timestamp: Date.now()
        });
      }

      // 更新会话统计
      const session = getSession(sessionId);
      if (session) {
        session.info.audioChunks++;
        persistSession(session);
      }

      return sendJson(res, 200, {
        ok: true,
        sequence,
        transcript: transcript || null,
        error: asrError || null
      });
    } catch (e) {
      console.error("[Listener] 音频处理错误:", safeError(e));
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // GET / - 本机复盘页（TASK-UI-001）
  if (req.method === "GET" && (req.url === "/" || req.url === "/review")) {
    try {
      const html = fs.readFileSync(path.join(__dirname, "review.html"), "utf-8");
      return sendHtml(res, 200, html);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "review page missing" });
    }
    return;
  }

  // GET /timeline.js - 全场总览时间轴组件（TASK-UI-003）
  if (req.method === "GET" && req.url === "/timeline.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "timeline.js"), "utf-8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(js);
      return;
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "timeline.js missing" });
    }
    return;
  }

  // GET /segment.js - 分段逻辑（TASK-SEGMENT-001，浏览器端与 Node 测试共用）
  if (req.method === "GET" && req.url === "/segment.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "segment.js"), "utf-8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(js);
      return;
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "segment.js missing" });
    }
    return;
  }

  // =============================================
  // 存储管理（TASK-STORAGE-001）
  // 只统计/清理本地会话目录；绝不触碰密钥、档案、名单、规则配置。
  // =============================================

  // GET /api/storage - 本机监听数据概览（只读）
  if (req.method === "GET" && req.url === "/api/storage") {
    try {
      return sendJson(res, 200, { ok: true, storage: getStorageOverview() });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // POST /session/clear-frames - 仅清理某已结束会话的截图
  // 删除 frames/ 目录；visual.jsonl 条目 framePath→null 并标记 frameCleared；
  // 转写/弹幕/商品/趋势记录保留。进行中的会话拒绝。
  if (req.method === "POST" && req.url === "/session/clear-frames") {
    try {
      const body = await readJsonBody(req);
      assertSessionId(body.sessionId);
      if (activeSessions.has(body.sessionId)) {
        throw new Error("session_active：请先停止监听后再清理截图");
      }
      const dir = path.join(SESSIONS_DIR, body.sessionId);
      let stat;
      try { stat = fs.statSync(dir); } catch (e) { throw new Error("unknown session"); }
      if (!stat.isDirectory()) throw new Error("unknown session");

      let cleared = 0;
      const framesDir = path.join(dir, "frames");
      try {
        cleared = fs.readdirSync(framesDir).filter(f => /^\d+_\d+\.jpg$/.test(f)).length;
        fs.rmSync(framesDir, { recursive: true, force: true });
      } catch (e) { /* 无截图目录 */ }

      const vPath = path.join(dir, "visual.jsonl");
      let lines = [];
      try { lines = readJsonLines(vPath); } catch (e) { /* 无 visual 记录 */ }
      const updated = lines.map(v => ({ ...v, framePath: null, frameCleared: true }));
      fs.writeFileSync(vPath, updated.map(v => JSON.stringify(v)).join("\n") + (updated.length ? "\n" : ""));
      console.log(`[Listener] 会话截图已清理: ${body.sessionId} (${cleared} 张)`);
      return sendJson(res, 200, { ok: true, clearedFrames: cleared });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // POST /sessions/batch-delete - 按日期批量删除已结束的旧会话
  // body: { before: <时间戳毫秒> }；仅删除 endTime 非空、非进行中、startTime < before 的会话。
  // 先整体校验再执行；任一异常则 400 且一个都不删。二次确认由前端完成。
  if (req.method === "POST" && req.url === "/sessions/batch-delete") {
    try {
      const body = await readJsonBody(req);
      const before = body.before;
      if (!Number.isFinite(before) || before <= 0) throw new Error("invalid before");
      const targets = [];
      for (const s of listSessions()) {
        if (activeSessions.has(s.sessionId)) continue;
        if (!s.endTime) continue; // 未正常结束的不碰
        if (!(s.startTime < before)) continue;
        const dir = path.join(SESSIONS_DIR, s.sessionId);
        let stat;
        try { stat = fs.statSync(dir); } catch (e) { continue; }
        if (!stat.isDirectory()) continue;
        targets.push({ sessionId: s.sessionId, dir, bytes: dirSizeBytes(dir) });
      }
      let freed = 0;
      const deletedIds = [];
      for (const t of targets) {
        if (activeSessions.has(t.sessionId)) continue; // 执行前复查：期间变为进行中的跳过
        fs.rmSync(t.dir, { recursive: true, force: true });
        freed += t.bytes;
        deletedIds.push(t.sessionId);
        console.log(`[Listener] 会话已批量删除: ${t.sessionId}`);
      }
      return sendJson(res, 200, { ok: true, deleted: deletedIds.length, freedBytes: freed,
        deletedIds });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // GET /api/sessions - 会话列表
  if (req.method === "GET" && req.url === "/api/sessions") {
    return sendJson(res, 200, { ok: true, sessions: listSessions() });
  }

  // GET /api/session?id=xxx - 会话详情（转写+弹幕时间轴）
  if (req.method === "GET" && req.url.startsWith("/api/session")) {
    try {
      const u = new URL(req.url, `http://${HOST}:${PORT}`);
      const detail = getSessionDetail(u.searchParams.get("id") || "");
      return sendJson(res, 200, { ok: true, ...detail });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // POST /visual - 画面/趋势快照（TASK-VISUAL-TREND-001）
  // JSON body：{ sessionId, sequence, offsetMs, timestamp, metrics, rawMetrics,
  //             matchedSelector, frameData(base64 JPEG，可空), frameError }
  if (req.method === "POST" && req.url === "/visual") {
    try {
      const body = await readRawBody(req, MAX_VISUAL_BYTES).then(raw => JSON.parse(raw.toString("utf-8")));
      const { sessionId, sequence, offsetMs } = body;
      assertSessionId(sessionId);
      if (!Number.isInteger(sequence) || sequence < 1) throw new Error("invalid sequence");
      if (!Number.isInteger(offsetMs) || offsetMs < 0 || offsetMs > 12 * 3600 * 1000) throw new Error("invalid offsetMs");
      const session = getSession(sessionId);
      if (!session) throw new Error("unknown session");

      let framePath = null;
      if (body.frameData) {
        const buf = Buffer.from(body.frameData, "base64");
        if (buf.length === 0 || buf.length > MAX_FRAME_BYTES) throw new Error("frame too large");
        if (buf[0] !== 0xFF || buf[1] !== 0xD8) throw new Error("invalid jpeg"); // JPEG 魔数校验
        const framesDir = path.join(session.dir, "frames");
        fs.mkdirSync(framesDir, { recursive: true });
        const fileName = `${offsetMs}_${sequence}.jpg`;
        fs.writeFileSync(path.join(framesDir, fileName), buf);
        framePath = `frames/${fileName}`;
      }

      appendVisual(sessionId, {
        timestamp: new Date(body.timestamp || Date.now()).toISOString(),
        offsetMs,
        sequence,
        framePath,
        frameError: body.frameError || null,
        metrics: body.metrics || { online: null, enter: null, leave: null },
        rawMetrics: body.rawMetrics || { online: null, enter: null, leave: null },
        matchedSelector: body.matchedSelector || null,
        debugHint: body.debugHint || null
      });
      return sendJson(res, 200, { ok: true, sequence, framePath });
    } catch (e) {
      console.error("[Listener] 画面快照错误:", safeError(e));
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // GET /api/frame?sessionId=&file= - 画面文件（白名单校验，防穿越）
  if (req.method === "GET" && req.url.startsWith("/api/frame")) {
    try {
      const u = new URL(req.url, `http://${HOST}:${PORT}`);
      const sessionId = u.searchParams.get("sessionId") || "";
      const file = u.searchParams.get("file") || "";
      assertSessionId(sessionId);
      if (!/^\d+_\d+\.jpg$/.test(file)) throw new Error("invalid file");
      const framesDir = path.resolve(SESSIONS_DIR, sessionId, "frames");
      const resolved = path.resolve(framesDir, file);
      if (!resolved.startsWith(framesDir + path.sep)) throw new Error("invalid file");
      const data = fs.readFileSync(resolved);
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      return res.end(data);
    } catch (e) {
      const code = /invalid|ENOENT/.test(e.message) ? (e.message === "invalid file" || e.message === "invalid sessionId" ? 400 : 404) : 400;
      return sendJson(res, code, { ok: false, error: safeError(e) });
    }
    return;
  }

  // POST /session/delete - 删除会话（含截图与 visual.jsonl，AC-VT-07）
  // Codex 评审必改：进行中的会话禁止删除（否则监听继续写入失败）
  if (req.method === "POST" && req.url === "/session/delete") {
    try {
      const body = await readJsonBody(req);
      assertSessionId(body.sessionId);
      if (activeSessions.has(body.sessionId)) {
        throw new Error("session_active：请先停止监听后再删除");
      }
      activeSessions.delete(body.sessionId);
      fs.rmSync(path.join(SESSIONS_DIR, body.sessionId), { recursive: true, force: true });
      console.log(`[Listener] 会话已删除: ${body.sessionId}`);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // POST /product - 讲解商品换品节点（TASK-PRODUCT-001 修订版）
  // JSON body：{ sessionId, offsetMs, timestamp, type: "product_switch", key,
  //             product: { id, link, name, price, seq, source }, matchedSelector, debugHint }
  // 注意：去重在 SW 侧（productKey 比对），服务端只做校验与落盘
  if (req.method === "POST" && req.url === "/product") {
    try {
      const body = await readJsonBody(req);
      assertSessionId(body.sessionId);
      if (!Number.isInteger(body.offsetMs) || body.offsetMs < 0 || body.offsetMs > 12 * 3600 * 1000) throw new Error("invalid offsetMs");
      const session = getSession(body.sessionId);
      if (!session) throw new Error("unknown session");
      const p = body.product || {};
      if (!p.name || typeof p.name !== "string") throw new Error("invalid product name");
      if (!body.key || typeof body.key !== "string") throw new Error("invalid product key");
      const nodeType = body.type || "product_switch";
      if (nodeType !== "product_switch" && nodeType !== "price_update") throw new Error("invalid product node type");
      appendProduct(body.sessionId, {
        timestamp: new Date(body.timestamp || Date.now()).toISOString(),
        offsetMs: body.offsetMs,
        type: nodeType,
        key: body.key,
        product: {
          id: p.id || null,
          link: p.link || null,
          name: p.name,
          price: p.price || null,
          priceText: p.priceText || null,
          seq: p.seq || null,
          source: "讲解商品卡",
          rawText: String(p.rawText || "").slice(0, 200)
        },
        matchedSelector: body.matchedSelector || null,
        debugHint: body.debugHint || null
      });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      console.error("[Listener] 换品记录错误:", safeError(e));
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // POST /diagnostic - 页面结构诊断结果（TASK-DOM-DIAGNOSTIC-001）
  if (req.method === "POST" && req.url === "/diagnostic") {
    try {
      const body = await readJsonBody(req);
      if (!body.diagnostic || typeof body.diagnostic !== "object") throw new Error("invalid diagnostic");
      const id = saveDiagnostic(body.diagnostic);
      console.log(`[Listener] 页面诊断已保存: ${id}`);
      return sendJson(res, 200, { ok: true, id });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // GET /api/diagnostics - 诊断报告列表
  if (req.method === "GET" && req.url === "/api/diagnostics") {
    try {
      return sendJson(res, 200, { ok: true, list: listDiagnostics() });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // GET /api/diagnostic?id= - 单份诊断报告详情
  if (req.method === "GET" && req.url.startsWith("/api/diagnostic")) {
    try {
      const u = new URL(req.url, `http://${HOST}:${PORT}`);
      const record = getDiagnostic(u.searchParams.get("id") || "");
      return sendJson(res, 200, { ok: true, diagnostic: record });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: safeError(e) });
    }
    return;
  }

  // 404
  return sendJson(res, 404, { error: "not found" });
});

// =============================================
// 页面结构诊断（TASK-DOM-DIAGNOSTIC-001）
// 只存本机 sessions/_diagnostic/（被 sessions/ 的 .gitignore 覆盖，不进 Git）。
// 诊断内容本身已在 content/diag.js 脱敏：仅结构 + 截断文本，无 cookie/弹幕/私信。
// =============================================

function saveDiagnostic(diag) {
  const dir = path.join(SESSIONS_DIR, "_diagnostic");
  fs.mkdirSync(dir, { recursive: true });
  const id = "diag_" + Date.now().toString(36);
  const record = { id, savedAt: new Date().toISOString(), ...(diag || {}) };
  fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(record, null, 2));
  return id;
}

function listDiagnostics() {
  const dir = path.join(SESSIONS_DIR, "_diagnostic");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => /^diag_[a-z0-9]+\.json$/.test(f)).sort().reverse();
  } catch (e) { return []; }
  return files.map(f => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      return {
        id: r.id,
        savedAt: r.savedAt,
        productFound: !!(r.productCard && r.productCard.found),
        onlineFound: !!(r.onlineCount && r.onlineCount.found)
      };
    } catch (e) { return null; }
  }).filter(Boolean);
}

function getDiagnostic(id) {
  if (!/^diag_[a-z0-9]+$/.test(id)) throw new Error("invalid id");
  const fp = path.resolve(SESSIONS_DIR, "_diagnostic", id + ".json");
  const dir = path.resolve(SESSIONS_DIR, "_diagnostic");
  if (!fp.startsWith(dir + path.sep)) throw new Error("invalid id");
  return JSON.parse(fs.readFileSync(fp, "utf-8"));
}

// =============================================
// 工具函数
// =============================================

function safeError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/(secret(?:id|key)?|authorization|token)\s*[=:]\s*[^,\s]+/gi, "$1=***")
    .slice(0, 200);
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// =============================================
// 复盘数据读取（TASK-UI-001）
// 只读 sessions 目录；绝不触碰密钥与原始音频。
// =============================================

function readJsonLines(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// ---- 存储管理 helpers（TASK-STORAGE-001）----

function dirSizeBytes(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeBytes(fp);
      else total += fs.statSync(fp).size;
    } catch (err) { /* 忽略单文件错误 */ }
  }
  return total;
}

function countFrames(sessionDir) {
  const framesDir = path.join(sessionDir, "frames");
  let files = [];
  try {
    files = fs.readdirSync(framesDir).filter(f => /^\d+_\d+\.jpg$/.test(f));
  } catch (e) { return { count: 0, bytes: 0 }; }
  let bytes = 0;
  for (const f of files) {
    try { bytes += fs.statSync(path.join(framesDir, f)).size; } catch (e) {}
  }
  return { count: files.length, bytes };
}

function getStorageOverview() {
  const items = [];
  let totalBytes = 0, totalFrames = 0, frameBytes = 0;
  let earliest = null, latest = null;
  for (const s of listSessions()) {
    const dir = path.join(SESSIONS_DIR, s.sessionId);
    const bytes = dirSizeBytes(dir);
    const fr = countFrames(dir);
    totalBytes += bytes;
    totalFrames += fr.count;
    frameBytes += fr.bytes;
    if (s.startTime) {
      if (earliest == null || s.startTime < earliest) earliest = s.startTime;
      if (latest == null || s.startTime > latest) latest = s.startTime;
    }
    items.push({
      sessionId: s.sessionId,
      startTime: s.startTime || null,
      endTime: s.endTime || null,
      active: activeSessions.has(s.sessionId),
      frameCount: fr.count,
      bytes
    });
  }
  items.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  return {
    sessionCount: items.length,
    frameCount: totalFrames,
    totalBytes,
    frameBytes,
    earliest,
    latest,
    sessions: items
  };
}

function listSessions() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch (e) { return []; }
  const list = [];
  for (const name of dirs) {
    // 目录名同样走 sessionId 白名单，防止异常目录
    if (!/^session_[A-Za-z0-9_-]{8,96}$/.test(name)) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name, "session.json"), "utf-8"));
      list.push({
        sessionId: info.sessionId || name,
        startTime: info.startTime || 0,
        endTime: info.endTime || null,
        danmakuCount: info.danmakuCount || 0,
        transcriptCount: info.transcriptCount || 0,
        audioChunks: info.audioChunks || 0,
        visualCount: info.visualCount || 0,
        productCount: info.productCount || 0,
        profileId: (info.profileSnapshot && info.profileSnapshot.profileId) || "general",
        profileName: (info.profileSnapshot && info.profileSnapshot.profileName) || "通用"
      });
    } catch (e) { /* session.json 缺失则跳过 */ }
  }
  list.sort((a, b) => b.startTime - a.startTime);
  return list;
}

function getSessionDetail(sessionId) {
  assertSessionId(sessionId); // 防路径穿越
  const dir = path.join(SESSIONS_DIR, sessionId);
  const info = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf-8"));
  const transcript = readJsonLines(path.join(dir, "transcript.jsonl"));
  const danmaku = readJsonLines(path.join(dir, "danmaku.jsonl"));
  const visual = readJsonLines(path.join(dir, "visual.jsonl"));
  const product = readJsonLines(path.join(dir, "product.jsonl"));
  // 合并时间轴：按 offsetMs 排序；缺失 offsetMs 的按 timestamp 兜底
  const timeline = [
    ...transcript.map(t => ({ kind: "transcript", at: t.offsetMs != null ? t.offsetMs : 0, data: t })),
    ...danmaku.map(d => ({ kind: "danmaku", at: d.offsetMs != null ? d.offsetMs : 0, data: d })),
    ...visual.map(v => ({ kind: "visual", at: v.offsetMs != null ? v.offsetMs : 0, data: v })),
    ...product.map(p => ({ kind: "product", at: p.offsetMs != null ? p.offsetMs : 0, data: p }))
  ].sort((a, b) => a.at - b.at);
  return { info, timeline, transcriptCount: transcript.length, danmakuCount: danmaku.length, visualCount: visual.length, productCount: product.length };
}

function readJsonBody(req) {
  return readRawBody(req, MAX_JSON_BYTES).then(raw => JSON.parse(raw.toString("utf-8")));
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let total = 0;
    req.on("data", c => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// =============================================
// 启动
// =============================================

// 确保会话目录存在
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

server.listen(PORT, HOST, () => {
  console.log(`[Listener] 本地监听服务已启动: http://${HOST}:${PORT}`);
  console.log(`[Listener] 会话目录: ${SESSIONS_DIR}`);
  let asrReady = false;
  try { loadCredentials(); asrReady = true; } catch (e) {
    console.warn(`[Listener] ASR 密钥未就绪: ${e.message}`);
    console.warn(`[Listener] 请在 ${SECRETS_PATH} 配置腾讯云 ASR 密钥`);
  }
  console.log(`[Listener] ASR 状态: ${asrReady ? "就绪" : "未配置"}`);
  console.log("[Listener] 仅监听 127.0.0.1，不暴露局域网端口");
});

// 优雅退出
process.on("SIGINT", () => {
  console.log("\n[Listener] 正在关闭...");
  for (const [sid] of activeSessions) {
    try { finalizeSession(sid); } catch (e) {}
  }
  server.close(() => {
    console.log("[Listener] 已关闭");
    process.exit(0);
  });
});
