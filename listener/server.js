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

// 路径常量
const APP_SUPPORT = process.env.LISTENER_DATA_DIR
  ? path.resolve(process.env.LISTENER_DATA_DIR)
  : path.join(os.homedir(), "Library", "Application Support", "LiveRoomListener");
const SECRETS_PATH = path.join(APP_SUPPORT, "asr-secrets.json");
const SESSIONS_DIR = path.join(APP_SUPPORT, "sessions");

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

function callSentenceRecognition(creds, pcmBuffer, sampleRate, seq) {
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

function transcribeAudio(pcmBuffer, sampleRate, seq) {
  // 仅供自动化测试使用：测试进程显式开启，绝不会请求腾讯云或读取用户密钥。
  if (process.env.LISTENER_TEST_MODE === "1") {
    return Promise.resolve({ text: "模拟转写 #" + seq, requestId: "mock-request-" + seq, audioDuration: 1 });
  }
  return callSentenceRecognition(loadCredentials(), pcmBuffer, sampleRate, seq);
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

  const sessionInfo = {
    sessionId,
    startTime: meta.startTime || Date.now(),
    endTime: null,
    tabId: meta.tabId || null,
    danmakuCount: 0,
    transcriptCount: 0,
    audioChunks: 0
  };

  fs.writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify(sessionInfo, null, 2));
  // 创建空文件
  fs.writeFileSync(path.join(sessionDir, "danmaku.jsonl"), "");
  fs.writeFileSync(path.join(sessionDir, "transcript.jsonl"), "");

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
  const line = JSON.stringify(danmaku) + "\n";
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
  // 仅允许扩展页或本机脚本调用；不向任意网页开放 CORS。
  const origin = req.headers.origin;
  if (origin && !origin.startsWith("chrome-extension://")) {
    return sendJson(res, 403, { ok: false, error: "forbidden origin" });
  }

  // GET /health - 健康检查
  if (req.method === "GET" && req.url === "/health") {
    let asrReady = false;
    try { loadCredentials(); asrReady = true; } catch (e) {}
    return sendJson(res, 200, { ok: true, asrReady, port: PORT, host: HOST });
  }

  // POST /session/start
  if (req.method === "POST" && req.url === "/session/start") {
    try {
      const body = await readJsonBody(req);
      const session = createSession(body.sessionId, { startTime: body.startTime, tabId: body.tabId });
      console.log(`[Listener] 会话已创建: ${body.sessionId}`);
      return sendJson(res, 200, { ok: true, sessionId: body.sessionId });
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

      // 调用腾讯云 ASR
      let transcript = "";
      let asrError = null;
      try {
        const result = await transcribeAudio(pcmData, sampleRate, sequence);
        transcript = result.text;
        console.log(`[Listener] ASR #${sequence}: "${transcript.slice(0, 60)}..."`);

        // 写入转写结果（带时间戳）
        appendTranscript(sessionId, {
          offsetMs: audioStartMs,
          sequence,
          text: transcript,
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

  // 404
  return sendJson(res, 404, { error: "not found" });
});

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
