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

  result = await request("POST", "/session/start", { sessionId: "../../bad" });
  assert.equal(result.status, 400);

  result = await request("GET", "/health", undefined, { Origin: "https://untrusted.example" });
  assert.equal(result.status, 403);

  result = await request("POST", "/session/stop", { sessionId });
  assert.equal(result.status, 200);

  const sessionDir = path.join(dataDir, "sessions", sessionId);
  const info = JSON.parse(fs.readFileSync(path.join(sessionDir, "session.json"), "utf8"));
  assert.equal(info.danmakuCount, 1); assert.equal(info.transcriptCount, 1); assert.equal(info.audioChunks, 1);
  assert.ok(info.endTime);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, "transcript.jsonl"), "utf8")).text, "模拟转写 #1");
  assert.ok(!startupLog.includes("mock-secret-key"));
  console.log("✓ 本地服务真实启动、会话、弹幕、音频、转写模拟与安全边界：全部通过");
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (server && !server.killed) server.kill("SIGINT");
  fs.rmSync(dataDir, { recursive: true, force: true });
});
