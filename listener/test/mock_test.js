// 实际启动本地服务的自动测试：不读取用户密钥，也不请求腾讯云。
const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = 17843;
const HOST = "127.0.0.1";
const root = path.join(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "LiveRoomListener-test-"));
const sessionId = "session_testlistener01";
let server;

function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const req = http.request({ hostname: HOST, port: PORT, path: route, method, headers: {
      ...(payload ? { "Content-Length": payload.length } : {}),
      ...(Buffer.isBuffer(body) ? { "Content-Type": "application/octet-stream" } : (body === undefined ? {} : { "Content-Type": "application/json" })),
      ...headers
    }}, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    try {
      const result = await request("GET", "/health");
      if (result.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

function pcmPayload() {
  const header = Buffer.from(JSON.stringify({ sessionId, sequence: 1, sampleRate: 16000, audioStartMs: 0 }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(header.length, 0);
  return Buffer.concat([prefix, header, Buffer.alloc(32000)]);
}

async function run() {
  server = childProcess.spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, LISTENER_PORT: String(PORT), LISTENER_DATA_DIR: dataDir, LISTENER_TEST_MODE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let startupLog = "";
  server.stdout.on("data", chunk => { startupLog += chunk; });
  server.stderr.on("data", chunk => { startupLog += chunk; });
  await waitForHealth();

  let result = await request("POST", "/session/start", { sessionId, startTime: 123, tabId: 9 });
  assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).ok, true);

  result = await request("POST", "/danmaku", { sessionId, offsetMs: 12, userName: "测试用户", text: "怎么买", timestamp: 456 });
  assert.equal(result.status, 200);

  result = await request("POST", "/audio", pcmPayload());
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).transcript, "模拟转写 #1");

  // TASK-ASR-002: 识别档案 + 本场关键词 + 快照
  const sessionId2 = "session_testprofile02";
  result = await request("POST", "/session/start", {
    sessionId: sessionId2, profileId: "apparel-scarf", sessionKeywords: ["测试词|9", "普通词"]
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).profileId, "apparel-scarf");
  const info2 = JSON.parse(fs.readFileSync(path.join(dataDir, "sessions", sessionId2, "session.json"), "utf8"));
  assert.equal(info2.profileSnapshot.profileId, "apparel-scarf");
  assert.ok(info2.profileSnapshot.sessionKeywords.includes("测试词|9"));

  // 无档案时退回通用识别
  const sessionId3 = "session_testprofile03";
  result = await request("POST", "/session/start", { sessionId: sessionId3, profileId: "not-exist" });
  assert.equal(JSON.parse(result.body).profileId, "general");

  // 超长关键词被跳过（不进 HotwordList，不截断）
  const sessionId4 = "session_testprofile04";
  const longWord = "这是一段被用户误粘进来的完整话术句子肯定超过十个汉字了";
  result = await request("POST", "/session/start", {
    sessionId: sessionId4, profileId: "apparel-scarf", sessionKeywords: ["正常词", longWord]
  });
  assert.equal(result.status, 200);
  const header4 = Buffer.from(JSON.stringify({ sessionId: sessionId4, sequence: 1, sampleRate: 16000, audioStartMs: 0 }));
  const prefix4 = Buffer.alloc(4); prefix4.writeUInt32LE(header4.length, 0);
  result = await request("POST", "/audio", Buffer.concat([prefix4, header4, Buffer.alloc(3200)]));
  assert.equal(result.status, 200);
  assert.ok(startupLog.includes("跳过超长热词"));

  // 档案列表接口（不含密钥）
  result = await request("GET", "/profiles");
  assert.equal(result.status, 200);
  const profiles = JSON.parse(result.body).profiles;
  assert.ok(profiles.some(p => p.id === "apparel-scarf" && p.hotwordCount > 0));
  assert.ok(!JSON.stringify(profiles).includes("secret"));

  // 账号名单接口（测试环境无 accounts.json → 空名单，fail-open）
  result = await request("GET", "/accounts");
  assert.equal(result.status, 200);
  const accounts = JSON.parse(result.body).accounts;
  assert.deepEqual(accounts.anchor_uids, []);
  assert.deepEqual(accounts.water_army_uids, []);

  // 弹幕打标：无名单时全部按 audience
  result = await request("POST", "/danmaku", { sessionId, offsetMs: 13, userName: "u", userId: "uid_1", text: "你好", timestamp: 457 });
  assert.equal(result.status, 200);
  const dmLines = fs.readFileSync(path.join(dataDir, "sessions", sessionId, "danmaku.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(dmLines[dmLines.length - 1]).role, "audience");

  // TASK-UI-001：复盘页与会话 API
  result = await request("GET", "/");
  assert.equal(result.status, 200);
  assert.ok(result.body.includes("直播复盘"));

  result = await request("GET", "/api/sessions");
  assert.equal(result.status, 200);
  const sessList = JSON.parse(result.body).sessions;
  assert.ok(sessList.some(s => s.sessionId === sessionId));
  assert.ok(!JSON.stringify(sessList).includes("secret"));

  result = await request("GET", "/api/session?id=" + encodeURIComponent(sessionId));
  assert.equal(result.status, 200);
  const detail = JSON.parse(result.body);
  assert.ok(Array.isArray(detail.timeline));
  assert.ok(detail.timeline.some(x => x.kind === "transcript"));
  assert.ok(detail.timeline.some(x => x.kind === "danmaku"));

  // 会话详情防穿越
  result = await request("GET", "/api/session?id=" + encodeURIComponent("../../etc/passwd"));
  assert.equal(result.status, 400);

  // 本机 Origin 放行（复盘页同源 fetch），恶意 Origin 仍拒绝
  result = await request("GET", "/api/sessions", undefined, { Origin: `http://${HOST}:${PORT}` });
  assert.equal(result.status, 200);
  result = await request("GET", "/api/sessions", undefined, { Origin: "https://evil.example" });
  assert.equal(result.status, 403);
  const { washText } = require("../textnorm");
  const washed = washText("这个三蚕丝围巾是上还故事的", [
    { correct: "桑蚕丝", aliases: ["三蚕丝"] },
    { correct: "上海故事", aliases: ["上还故事"] }
  ]);
  assert.equal(washed.text, "这个桑蚕丝围巾是上海故事的");
  assert.equal(washed.replacements.length, 2);
  assert.equal(washText("原文无错别字", []).text, "原文无错别字");

  // TASK-VISUAL-TREND-001：parseOnlineText 单元测试（vm 加载 content/metrics_parse.js，保证与浏览器端同一份逻辑）
  const visualDir = path.join(dataDir, "sessions", sessionId); // sessionDir 在后文定义，此处用局部变量
  const vm = require("vm");
  const metricsCtx = {};
  vm.createContext(metricsCtx);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "..", "content", "metrics_parse.js"), "utf8"),
    metricsCtx
  );
  const parseOnlineText = metricsCtx.parseOnlineText;
  assert.equal(parseOnlineText("1.2万人在看").value, 12000);
  assert.equal(parseOnlineText("1.2万人在看").raw, "1.2万人在看");
  assert.equal(parseOnlineText("860人").value, 860);
  assert.equal(parseOnlineText("2.5万").value, 25000);
  assert.strictEqual(parseOnlineText("今天很开心"), null);
  assert.strictEqual(parseOnlineText(""), null);

  // POST /visual：带图快照
  const fakeJpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(1000), Buffer.from([0xFF, 0xD9])]);
  result = await request("POST", "/visual", {
    sessionId, sequence: 1, offsetMs: 45000, timestamp: Date.now(),
    metrics: { online: 120, enter: null, leave: null },
    rawMetrics: { online: "1.2万人在看", enter: null, leave: null },
    matchedSelector: "text-pattern:人在看",
    frameData: fakeJpeg.toString("base64"), frameError: null
  });
  assert.equal(result.status, 200);
  assert.ok(JSON.parse(result.body).framePath);
  const vLines = fs.readFileSync(path.join(visualDir, "visual.jsonl"), "utf8").trim().split("\n");
  const vEntry = JSON.parse(vLines[0]);
  assert.equal(vEntry.metrics.online, 120);
  assert.equal(vEntry.rawMetrics.online, "1.2万人在看");
  assert.ok(fs.existsSync(path.join(visualDir, vEntry.framePath)));

  // POST /visual：无图快照（截图失败仍写快照）
  result = await request("POST", "/visual", {
    sessionId, sequence: 2, offsetMs: 90000, timestamp: Date.now(),
    metrics: { online: null, enter: null, leave: null },
    rawMetrics: { online: null, enter: null, leave: null },
    matchedSelector: null, frameData: null, frameError: "tab_not_active"
  });
  assert.equal(result.status, 200);
  assert.strictEqual(JSON.parse(result.body).framePath, null);

  // /visual 参数校验
  result = await request("POST", "/visual", { sessionId: "../../bad", sequence: 1, offsetMs: 1 });
  assert.equal(result.status, 400);
  result = await request("POST", "/visual", { sessionId, sequence: 1, offsetMs: -5 });
  assert.equal(result.status, 400);
  result = await request("POST", "/visual", {
    sessionId, sequence: 3, offsetMs: 135000,
    frameData: Buffer.from([0x00, 0x01, 0x02]).toString("base64") // 非 JPEG 魔数
  });
  assert.equal(result.status, 400);

  // GET /api/frame：正常与穿越
  const frameFile = vEntry.framePath.split("/").pop();
  result = await request("GET", `/api/frame?sessionId=${sessionId}&file=${frameFile}`);
  assert.equal(result.status, 200);
  result = await request("GET", `/api/frame?sessionId=${sessionId}&file=${encodeURIComponent("../../x.jpg")}`);
  assert.equal(result.status, 400);
  result = await request("GET", `/api/frame?sessionId=${sessionId}&file=nope.png`);
  assert.equal(result.status, 400);

  // 会话详情时间轴包含 visual
  result = await request("GET", "/api/session?id=" + encodeURIComponent(sessionId));
  const detail2 = JSON.parse(result.body);
  assert.ok(detail2.timeline.some(x => x.kind === "visual"));
  assert.equal(detail2.visualCount, 2);

  // POST /session/delete：连带删除截图与 visual.jsonl，其他会话不受影响
  result = await request("POST", "/session/delete", { sessionId: sessionId3 });
  assert.equal(result.status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, "sessions", sessionId3)));
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", sessionId)));
  result = await request("POST", "/session/delete", { sessionId: "../../bad" });
  assert.equal(result.status, 400);

  result = await request("POST", "/session/start", { sessionId: "../../bad" });
  assert.equal(result.status, 400);

  result = await request("GET", "/health", undefined, { Origin: "https://untrusted.example" });
  assert.equal(result.status, 403);

  result = await request("POST", "/session/stop", { sessionId });
  assert.equal(result.status, 200);

  const sessionDir = path.join(dataDir, "sessions", sessionId);
  const info = JSON.parse(fs.readFileSync(path.join(sessionDir, "session.json"), "utf8"));
  assert.equal(info.danmakuCount, 2); assert.equal(info.transcriptCount, 1); assert.equal(info.audioChunks, 1);
  assert.ok(info.endTime);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, "transcript.jsonl"), "utf8")).text, "模拟转写 #1");
  // AC-ASR-07: mock 日志带 [MOCK] 标记；转写条目带 mock/status/profileId 诊断字段
  assert.ok(startupLog.includes("[MOCK]"));
  const tEntry = JSON.parse(fs.readFileSync(path.join(sessionDir, "transcript.jsonl"), "utf8"));
  assert.equal(tEntry.mock, true);
  assert.equal(tEntry.status, "ok");
  assert.equal(tEntry.profileId, "general");
  assert.ok(!startupLog.includes("mock-secret-key"));
  console.log("✓ 本地服务真实启动、会话、弹幕、音频、转写模拟与安全边界：全部通过");
  console.log("✓ TASK-ASR-002（识别档案/热词/快照/洗一遍/[MOCK]）与 TASK-DANMAKU-001（账号名单/弹幕打标）：全部通过");
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (server && !server.killed) server.kill("SIGINT");
  fs.rmSync(dataDir, { recursive: true, force: true });
});
