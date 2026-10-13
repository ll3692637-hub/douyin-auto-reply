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
  assert.equal(parseOnlineText("31").value, 31); // 2026-10-11 实机：data-e2e 纯数字
  assert.equal(parseOnlineText("1,234").value, 1234);
  assert.strictEqual(parseOnlineText("今天很开心"), null);
  assert.strictEqual(parseOnlineText(""), null);

  // readVisualMetrics：用假 DOM 验证"在线观众"标签模式（兄弟节点/同元素/无标签）
  const readVisualMetrics = metricsCtx.readVisualMetrics;
  const fakeEl = (text, next, parent) => ({
    innerText: text, nextElementSibling: next || null, parentElement: parent || null
  });
  const numEl = fakeEl("1.2万");
  const labelEl = fakeEl("在线观众", numEl, null);
  const r1 = readVisualMetrics({
    querySelector: () => null,
    querySelectorAll: () => [fakeEl("弹幕很多很长很长"), labelEl, numEl]
  });
  assert.equal(r1.metrics.online, 12000);
  assert.equal(r1.rawMetrics.online, "1.2万");
  assert.equal(r1.matchedSelector, "text-pattern:在线");
  const r2 = readVisualMetrics({
    querySelector: () => null,
    querySelectorAll: () => [fakeEl("在线观众860人")]
  });
  assert.equal(r2.metrics.online, 860);
  const r3 = readVisualMetrics({
    querySelector: () => null,
    querySelectorAll: () => [fakeEl("今天很开心")]
  });
  assert.strictEqual(r3.metrics.online, null);
  assert.strictEqual(r3.matchedSelector, null);
  // 2026-10-11 实机 pin：data-e2e="live-room-audience" 纯数字
  const r4 = readVisualMetrics({
    querySelector: (sel) => sel === '[data-e2e="live-room-audience"]' ? fakeEl("31") : null,
    querySelectorAll: () => []
  });
  assert.equal(r4.metrics.online, 31);
  assert.equal(r4.rawMetrics.online, "31");
  assert.equal(r4.matchedSelector, '[data-e2e="live-room-audience"]');

  // TASK-PRODUCT-001 修订版：商品卡解析 / 稳定标识 / 换品判定（vm 加载 content/product_parse.js）
  const productCtx = {};
  vm.createContext(productCtx);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "..", "content", "product_parse.js"), "utf8"),
    productCtx
  );
  const { parseProductCard, productKey, shouldRecordSwitch, decideProductNode, extractPrice } = productCtx;
  const cardEl = (text, href) => ({
    innerText: text,
    querySelector: (sel) => (sel === "a[href]" && href ? { href } : null)
  });
  const fakeCardDoc = (el) => ({ querySelector: () => el, querySelectorAll: () => [] });
  // 讲解中卡片：名称/价格/序号/链接
  const pr1 = parseProductCard(fakeCardDoc(cardEl(
    "讲解中\n桑蚕丝拉绒围巾\n¥199\n1号\n去购买",
    "https://www.douyin.com/product/12345?x=1"
  )));
  assert.equal(pr1.product.name, "桑蚕丝拉绒围巾");
  assert.equal(pr1.product.price, "199");
  assert.equal(pr1.product.seq, "1");
  assert.equal(pr1.product.id, "12345");
  assert.equal(productKey(pr1.product), "id:12345");
  // 无 ID/链接时用名称＋价格
  const pr2 = parseProductCard(fakeCardDoc(cardEl("讲解中\n羊毛披肩\n¥239")));
  assert.equal(productKey(pr2.product), "np:羊毛披肩|239");
  // 名称缺失 → 不可靠，不产生 key（不判为换品）
  const pr3 = parseProductCard(fakeCardDoc(cardEl("讲解中\n¥199")));
  assert.strictEqual(pr3.product, null);
  assert.strictEqual(productKey({ name: "围巾", price: null }), null);
  assert.strictEqual(productKey({ name: null, price: "199" }), null);
  assert.strictEqual(productKey(null), null);
  // 锁价/占位：??9元 → priceText 保留原文，price 为 null；有 ID 时换品仍可生成
  const pr4 = parseProductCard(fakeCardDoc(cardEl(
    "讲解中\n桑蚕丝拉绒围巾\n??9元\n去购买",
    "https://www.douyin.com/product/12345"
  )));
  assert.equal(pr4.product.name, "桑蚕丝拉绒围巾");
  assert.equal(pr4.product.priceText, "??9元");
  assert.strictEqual(pr4.product.price, null);
  assert.equal(productKey(pr4.product), "id:12345");
  assert.equal(shouldRecordSwitch(null, productKey(pr4.product)), true);
  // 明确数值：¥199 → priceText 与 price 都填
  assert.equal(pr1.product.priceText, "¥199");
  assert.equal(pr1.product.price, "199");
  // 待公布类
  const pr5 = parseProductCard(fakeCardDoc(cardEl("讲解中\n羊毛披肩\n到手价待公布")));
  assert.equal(pr5.product.priceText, "到手价待公布");
  assert.strictEqual(pr5.product.price, null);
  // 券后价前缀保留进 priceText
  const ep3 = extractPrice("券后价¥149");
  assert.equal(ep3.priceText, "券后价¥149");
  assert.equal(ep3.price, "149");
  // parseProductCard：讲解中图片锚点（2026-10-11 实机 DOM 结构）
  const priceDiv = { innerText: "券后价¥149", parentElement: null, querySelector: () => null };
  const cardRoot = {
    innerText: "【羊绒中方巾】枳实原创100%山羊绒方巾小众时尚穿搭保暖巾\n券后价¥149\n抢",
    parentElement: null,
    querySelector: () => null
  };
  priceDiv.parentElement = cardRoot;
  const badge = { parentElement: priceDiv };
  const pr6 = parseProductCard({
    querySelector: (sel) => (sel.includes("jiangjiezhong") ? badge : null),
    querySelectorAll: () => []
  });
  assert.equal(pr6.product.name, "【羊绒中方巾】枳实原创100%山羊绒方巾小众时尚穿搭保暖巾");
  assert.equal(pr6.product.priceText, "券后价¥149");
  assert.equal(pr6.product.price, "149");
  assert.equal(pr6.matchedSelector, 'img[src*="jiangjiezhong"]');
  assert.equal(productKey(pr6.product),
    "np:【羊绒中方巾】枳实原创100%山羊绒方巾小众时尚穿搭保暖巾|149");
  // 价格状态补丁：同卡 ¥199 与 ??3元 共存时锁价优先
  const ep1 = extractPrice("桑蚕丝围巾 ¥199 ??3元 去购买");
  assert.equal(ep1.priceText, "??3元");
  assert.strictEqual(ep1.price, null);
  const ep2 = extractPrice("到手价 ¥199");
  assert.equal(ep2.priceText, "¥199");
  assert.equal(ep2.price, "199");
  // decideProductNode 验收场景
  const seq = (steps) => {
    let lastKey = null, lastPT = null;
    return steps.map(([k, pt]) => {
      const t = decideProductNode(lastKey, lastPT, k, pt);
      if (t === "product_switch") { lastKey = k; lastPT = pt; }
      else if (t === "price_update") { lastPT = pt; }
      return t;
    });
  };
  // A 锁价重复 5 次 → 1 条 product_switch
  assert.deepEqual(seq([["id:1", "??3元"], ["id:1", "??3元"], ["id:1", "??3元"], ["id:1", "??3元"], ["id:1", "??3元"]]),
    ["product_switch", null, null, null, null]);
  // A 锁价 → A 实价重复 3 次 → 1 条 switch + 1 条 price_update
  assert.deepEqual(seq([["id:1", "??3元"], ["id:1", "¥199"], ["id:1", "¥199"], ["id:1", "¥199"]]),
    ["product_switch", "price_update", null, null]);
  // A → B 锁价 → A：3 条换品；A 重新出现时记录当时价格状态
  assert.deepEqual(seq([["id:1", "??3元"], ["id:2", "??8元"], ["id:1", "??3元"]]),
    ["product_switch", "product_switch", "product_switch"]);
  assert.deepEqual(seq([["id:1", "??3元"], ["id:2", "??8元"], ["id:1", "¥199"], ["id:1", "¥199"]]),
    ["product_switch", "product_switch", "product_switch", null]); // 切回 A 已在换品节点记下 ¥199
  // 价格节点暂时从 DOM 消失不是价格更新；恢复原价也不应重复记录。
  assert.deepEqual(seq([["id:1", "¥199"], ["id:1", null], ["id:1", "¥199"]]),
    ["product_switch", null, null]);
  // 卡片消失场景（补丁）：SW 在卡片消失的轮询中直接返回，不碰 lastKey/lastPriceText
  function swSim(polls) {
    let lastKey = null, lastPT = null;
    const nodes = [];
    for (const p of polls) {
      if (!p) continue; // 卡片消失：无 product，不调用判定，状态保持
      const t = decideProductNode(lastKey, lastPT, p[0], p[1]);
      if (t === "product_switch") { lastKey = p[0]; lastPT = p[1]; }
      else if (t === "price_update") { lastPT = p[1]; }
      if (t) nodes.push(t);
    }
    return nodes;
  }
  // A 出现 → 消失 2 分钟（4 轮空）→ A 再出现：只保留 1 条 A 换品
  assert.deepEqual(
    swSim([["id:1", "??3元"], null, null, null, null, ["id:1", "??3元"]]),
    ["product_switch"]);
  // A 出现 → 消失 → B 出现：只在 B 首次识别时产生换品
  assert.deepEqual(
    swSim([["id:1", "??3元"], null, null, ["id:2", "??8元"]]),
    ["product_switch", "product_switch"]);
  // 标识不可靠 / 无变化 → null
  assert.strictEqual(decideProductNode("id:1", "??3元", null, "??3元"), null);
  assert.strictEqual(decideProductNode(null, null, null, null), null);
  // 换品判定 AC：同一商品 10 次只 1 条；A→B→A 共 3 条
  const kA = "id:111", kB = "id:222";
  let lastKey = null, switches = 0;
  for (let i = 0; i < 10; i++) {
    if (shouldRecordSwitch(lastKey, kA)) { switches++; lastKey = kA; }
  }
  assert.equal(switches, 1);
  lastKey = null; switches = 0;
  for (const k of [kA, kB, kA]) {
    if (shouldRecordSwitch(lastKey, k)) { switches++; lastKey = k; }
  }
  assert.equal(switches, 3);
  assert.equal(shouldRecordSwitch(kA, kA), false);
  assert.equal(shouldRecordSwitch(kA, null), false);

  // POST /product：落盘 + 时间轴 + 校验
  const prodPayload = (offsetMs, key, name, price) => ({
    sessionId, offsetMs, timestamp: Date.now(), type: "product_switch", key,
    matchedSelector: "text-pattern:讲解中", debugHint: null,
    product: { id: null, link: null, name, price, seq: "1", source: "讲解商品卡", rawText: name + " " + price }
  });
  result = await request("POST", "/product", prodPayload(1000, "id:111", "桑蚕丝拉绒围巾", "199"));
  assert.equal(result.status, 200);
  result = await request("POST", "/product", prodPayload(2000, "id:222", "羊毛披肩", "239"));
  assert.equal(result.status, 200);
  result = await request("POST", "/product", { sessionId, offsetMs: 3000, key: "id:333", product: {} });
  assert.equal(result.status, 400); // 无名称
  result = await request("POST", "/product", { sessionId, offsetMs: 3000, product: { name: "x" } });
  assert.equal(result.status, 400); // 无 key
  result = await request("POST", "/product", { sessionId: "../../bad", offsetMs: 1, key: "k", product: { name: "x" } });
  assert.equal(result.status, 400);
  const pLines = fs.readFileSync(path.join(visualDir, "product.jsonl"), "utf8").trim().split("\n");
  assert.equal(pLines.length, 2);
  const pEntry = JSON.parse(pLines[0]);
  assert.equal(pEntry.type, "product_switch");
  assert.equal(pEntry.product.name, "桑蚕丝拉绒围巾");
  // priceText 落盘
  result = await request("POST", "/product", {
    sessionId, offsetMs: 2500, timestamp: Date.now(), type: "product_switch", key: "id:999",
    product: { id: "999", link: null, name: "锁价围巾", price: null, priceText: "??9元", seq: null, source: "讲解商品卡", rawText: "??9元" }
  });
  assert.equal(result.status, 200);
  const pLines2 = fs.readFileSync(path.join(visualDir, "product.jsonl"), "utf8").trim().split("\n");
  const pLocked = JSON.parse(pLines2[pLines2.length - 1]);
  assert.equal(pLocked.product.priceText, "??9元");
  assert.strictEqual(pLocked.product.price, null);
  // type=price_update 落盘；非法 type 拒绝
  result = await request("POST", "/product", {
    sessionId, offsetMs: 2600, timestamp: Date.now(), type: "price_update", key: "id:111",
    product: { id: "111", name: "桑蚕丝拉绒围巾", price: "199", priceText: "¥199", source: "讲解商品卡", rawText: "¥199" }
  });
  assert.equal(result.status, 200);
  result = await request("POST", "/product", {
    sessionId, offsetMs: 2700, type: "bogus", key: "id:111",
    product: { name: "x" }
  });
  assert.equal(result.status, 400);
  result = await request("GET", "/api/session?id=" + encodeURIComponent(sessionId));
  const detail3 = JSON.parse(result.body);
  assert.ok(detail3.timeline.some(x => x.kind === "product"));
  assert.ok(detail3.timeline.some(x => x.kind === "product" && x.data.type === "price_update"));
  assert.equal(detail3.productCount, 4);

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
  // （sessionId3 先 stop，否则进行中保护会拒绝删除）
  result = await request("POST", "/session/stop", { sessionId: sessionId3 });
  assert.equal(result.status, 200);
  result = await request("POST", "/session/delete", { sessionId: sessionId3 });
  assert.equal(result.status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, "sessions", sessionId3)));
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", sessionId)));
  result = await request("POST", "/session/delete", { sessionId: "../../bad" });
  assert.equal(result.status, 400);

  // TASK-DOM-DIAGNOSTIC-001：诊断端点
  result = await request("POST", "/diagnostic", { diagnostic: {
    timestamp: new Date().toISOString(), url: "live.douyin.com/",
    productCard: { found: true, suggestedSelector: 'img[src*="jiangjiezhong"]' },
    onlineCount: { found: true, suggestedSelector: '[data-e2e="live-room-audience"]' }
  }});
  assert.equal(result.status, 200);
  const diagId = JSON.parse(result.body).id;
  assert.ok(/^diag_[a-z0-9]+$/.test(diagId));
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", "_diagnostic", diagId + ".json")));
  result = await request("GET", "/api/diagnostics");
  assert.ok(JSON.parse(result.body).list.some(d => d.id === diagId));
  result = await request("GET", "/api/diagnostic?id=" + diagId);
  assert.equal(JSON.parse(result.body).diagnostic.productCard.suggestedSelector, 'img[src*="jiangjiezhong"]');
  result = await request("GET", "/api/diagnostic?id=..%2f..%2fx");
  assert.equal(result.status, 400);
  result = await request("POST", "/diagnostic", { nope: 1 });
  assert.equal(result.status, 400);
  // 诊断目录不污染会话列表
  result = await request("GET", "/api/sessions");
  assert.ok(!JSON.parse(result.body).sessions.some(s => s.sessionId.includes("diag")));

  // runPageDiagnostic：vm 按 manifest 顺序加载三个 content 脚本 + 注入假 DOM
  const diagCtx = {};
  vm.createContext(diagCtx);
  for (const f of ["metrics_parse.js", "product_parse.js", "diag.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "..", "content", f), "utf8"), diagCtx);
  }
  const dPriceDiv = { innerText: "券后价¥149", parentElement: null };
  const dCard = { nodeType: 1, tagName: "DIV", className: "g7Yo4AYK", id: "",
    innerText: "商品标题文本 券后价¥149", parentElement: null, attributes: [],
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [] };
  dPriceDiv.parentElement = dCard;
  const dBadge = { nodeType: 1, tagName: "IMG", parentElement: dPriceDiv,
    getAttribute: (n) => (n === "src" ? "https://x/jiangjiezhongs.png" : null), attributes: [] };
  const dOnline = { nodeType: 1, tagName: "DIV", className: "ClV317pr", id: "", innerText: "1679",
    parentElement: null, attributes: [{ name: "data-e2e", value: "live-room-audience" }],
    getAttribute: (n) => (n === "data-e2e" ? "live-room-audience" : null) };
  diagCtx.document = {
    querySelector: (sel) => {
      if (sel.includes("jiangjiezhong")) return dBadge;
      if (sel === '[data-e2e="live-room-audience"]') return dOnline;
      return null;
    },
    querySelectorAll: () => []
  };
  diagCtx.location = { hostname: "live.douyin.com", pathname: "/" };
  const diagRes = diagCtx.runPageDiagnostic();
  assert.equal(diagRes.productCard.found, true);
  assert.equal(diagRes.productCard.suggestedSelector, "div.g7Yo4AYK");
  assert.equal(diagRes.productCard.badge.suggestedSelector, 'img[src*="jiangjiezhong"]');
  assert.equal(diagRes.onlineCount.found, true);
  assert.equal(diagRes.onlineCount.hitSelector, '[data-e2e="live-room-audience"]');
  assert.equal(diagRes.onlineCount.suggestedSelector, '[data-e2e="live-room-audience"]');
  // 脱敏断言：无 cookie/localStorage 痕迹，文本被截断
  const diagStr = JSON.stringify(diagRes);
  assert.ok(!/cookie|localStorage/i.test(diagStr));
  assert.ok(diagRes.productCard.text.length <= 120);

  // TASK-SEGMENT-001：buildSegments
  const { buildSegments } = require("../segment.js");
  const segTl = (at, kind, data) => ({ kind, at, data });
  const prodNode = (at, type, name, priceText) => segTl(at, "product", {
    offsetMs: at, type, key: "id:" + name,
    product: { name, priceText, price: null, source: "讲解商品卡" }
  });
  const info0 = { startTime: 1000000, endTime: 1000000 + 300000 };
  // A(60s) → A价格更新(90s) → B(150s)：3 个片段（00:00–01:00 为未识别），价格更新归 A
  let stl = [
    segTl(10000, "transcript", { offsetMs: 10000, text: "t1" }),
    prodNode(60000, "product_switch", "A商品", "??3元"),
    segTl(70000, "danmaku", { offsetMs: 70000, text: "d1" }),
    prodNode(90000, "price_update", "A商品", "¥199"),
    segTl(120000, "transcript", { offsetMs: 120000, text: "t2" }),
    prodNode(150000, "product_switch", "B商品", "??8元"),
    segTl(200000, "visual", { offsetMs: 200000, metrics: {} })
  ];
  let segs = buildSegments(stl, info0);
  assert.equal(segs.length, 3);
  assert.strictEqual(segs[0].product, null);
  assert.deepEqual([segs[0].startMs, segs[0].endMs], [0, 60000]);
  assert.deepEqual(segs[0].items.map(x => x.at), [10000]);
  assert.equal(segs[1].product.product.name, "A商品");
  assert.deepEqual([segs[1].startMs, segs[1].endMs], [60000, 150000]);
  assert.equal(segs[1].priceUpdates.length, 1);
  assert.equal(segs[1].priceUpdates[0].product.priceText, "¥199");
  assert.deepEqual(segs[1].items.map(x => x.at), [70000, 120000]);
  assert.equal(segs[2].product.product.name, "B商品");
  assert.deepEqual([segs[2].startMs, segs[2].endMs], [150000, 300000]);
  assert.deepEqual(segs[2].items.map(x => x.at), [200000]);
  // Codex 评审：30 秒的转写不得进入 60 秒才识别到的 A 商品段
  stl = [
    segTl(30000, "transcript", { offsetMs: 30000, text: "开场白" }),
    prodNode(60000, "product_switch", "A商品", "??3元"),
    segTl(90000, "transcript", { offsetMs: 90000, text: "讲 A" })
  ];
  segs = buildSegments(stl, info0);
  assert.equal(segs.length, 2);
  assert.strictEqual(segs[0].product, null);
  assert.deepEqual(segs[0].items.map(x => x.data.text), ["开场白"]);
  assert.equal(segs[1].product.product.name, "A商品");
  assert.deepEqual(segs[1].items.map(x => x.data.text), ["讲 A"]);
  // A → B → A：4 个片段（00:00–01:00 为未识别）
  stl = [prodNode(60000, "product_switch", "A", null), prodNode(120000, "product_switch", "B", null), prodNode(180000, "product_switch", "A", null)];
  segs = buildSegments(stl, info0);
  assert.equal(segs.length, 4);
  assert.strictEqual(segs[0].product, null);
  assert.deepEqual(segs.slice(1).map(s => s.product.product.name), ["A", "B", "A"]);
  assert.deepEqual(segs.map(s => s.startMs), [0, 60000, 120000, 180000]);
  // 无商品节点：1 个未识别片段，含全部证据
  stl = [segTl(5000, "transcript", { offsetMs: 5000, text: "t" }), segTl(9000, "danmaku", { offsetMs: 9000, text: "d" })];
  segs = buildSegments(stl, info0);
  assert.equal(segs.length, 1);
  assert.strictEqual(segs[0].product, null);
  assert.equal(segs[0].items.length, 2);
  assert.equal(segs[0].endMs, 300000);
  // 进行中会话：endMs 为 null
  segs = buildSegments(stl, { startTime: 1000000, endTime: null });
  assert.strictEqual(segs[0].endMs, null);
  // 缺 type 的旧数据视为 switch
  stl = [segTl(60000, "product", { offsetMs: 60000, key: "id:1", product: { name: "旧" } })];
  segs = buildSegments(stl, info0);
  assert.equal(segs.length, 2);
  assert.strictEqual(segs[0].product, null);
  assert.equal(segs[1].product.product.name, "旧");
  // 卡片消失不能结束片段：A(60s) 出现，120s/180s 无卡片（无节点），A 片段仍只有 1 个
  stl = [
    prodNode(60000, "product_switch", "A商品", "??3元"),
    segTl(120000, "transcript", { offsetMs: 120000, text: "消失期间转写" }),
    segTl(180000, "danmaku", { offsetMs: 180000, text: "消失期间弹幕" })
  ];
  segs = buildSegments(stl, info0);
  assert.equal(segs.length, 2);
  assert.strictEqual(segs[0].product, null);
  assert.equal(segs[1].product.product.name, "A商品");
  assert.equal(segs[1].items.length, 2);
  // A → 消失 → B：A 片段结束于 B 首次识别时间（UI 已注：非主播实际换品精确时刻）
  stl = [
    prodNode(60000, "product_switch", "A商品", "??3元"),
    segTl(120000, "transcript", { offsetMs: 120000, text: "空档转写" }),
    prodNode(180000, "product_switch", "B商品", "??8元")
  ];
  segs = buildSegments(stl, info0);
  assert.equal(segs.length, 3);
  assert.strictEqual(segs[0].product, null);
  assert.equal(segs[1].endMs, 180000);
  assert.deepEqual(segs[1].items.map(x => x.at), [120000]);
  // GET /segment.js 可 served
  result = await request("GET", "/segment.js");
  assert.equal(result.status, 200);
  assert.ok(result.body.includes("buildSegments"));

  // Codex 评审必改：进行中的会话禁止删除
  const activeSessId = "session_deletblock01";
  result = await request("POST", "/session/start", { sessionId: activeSessId });
  assert.equal(result.status, 200);
  result = await request("POST", "/session/delete", { sessionId: activeSessId });
  assert.equal(result.status, 400);
  assert.ok(JSON.parse(result.body).error.includes("请先停止监听后再删除"));
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", activeSessId))); // 文件夹还在
  // 停止后可删除
  result = await request("POST", "/session/stop", { sessionId: activeSessId });
  assert.equal(result.status, 200);
  result = await request("POST", "/session/delete", { sessionId: activeSessId });
  assert.equal(result.status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, "sessions", activeSessId)));

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

  // TASK-STORAGE-001：存储管理
  const tinyJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]).toString("base64");
  const stSessA = "session_storageA01"; // 40 天前，已结束，2 张截图
  const stSessB = "session_storageB01"; // 1 天前，已结束，1 张截图
  const stSessC = "session_storageC01"; // 进行中
  const nowMs = Date.now();
  result = await request("POST", "/session/start", { sessionId: stSessA, startTime: nowMs - 40 * 86400 * 1000 });
  assert.equal(result.status, 200);
  result = await request("POST", "/session/start", { sessionId: stSessB, startTime: nowMs - 86400 * 1000 });
  assert.equal(result.status, 200);
  result = await request("POST", "/session/start", { sessionId: stSessC });
  assert.equal(result.status, 200);
  for (const [sid, seq, ms] of [[stSessA, 1, 1000], [stSessA, 2, 2000], [stSessB, 1, 1000]]) {
    result = await request("POST", "/visual", { sessionId: sid, sequence: seq, offsetMs: ms, frameData: tinyJpeg });
    assert.equal(result.status, 200);
  }
  result = await request("POST", "/danmaku", { sessionId: stSessA, offsetMs: 1500, userName: "u", userId: "1", text: "hello" });
  assert.equal(result.status, 200);
  result = await request("POST", "/session/stop", { sessionId: stSessA });
  assert.equal(result.status, 200);
  result = await request("POST", "/session/stop", { sessionId: stSessB });
  assert.equal(result.status, 200);

  // AC-ST-01：统计与实际目录一致
  result = await request("GET", "/api/storage");
  assert.equal(result.status, 200);
  const st = JSON.parse(result.body).storage;
  const itemA = st.sessions.find(s => s.sessionId === stSessA);
  assert.ok(itemA);
  assert.equal(itemA.frameCount, 2);
  assert.equal(itemA.active, false);
  let expectedBytes = 0;
  const walkSize = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walkSize(fp); else expectedBytes += fs.statSync(fp).size;
    }
  };
  walkSize(path.join(dataDir, "sessions", stSessA));
  assert.equal(itemA.bytes, expectedBytes);
  assert.ok(st.sessionCount >= 3);
  assert.ok(st.frameCount >= 3);
  assert.ok(st.totalBytes >= expectedBytes);
  assert.ok(st.earliest <= nowMs - 40 * 86400 * 1000);

  // AC-ST-05：进行中会话禁止清截图
  result = await request("POST", "/session/clear-frames", { sessionId: stSessC });
  assert.equal(result.status, 400);
  // 路径穿越
  result = await request("POST", "/session/clear-frames", { sessionId: "../../etc" });
  assert.equal(result.status, 400);
  result = await request("POST", "/session/clear-frames", { sessionId: "session_nope12345" });
  assert.equal(result.status, 400);

  // AC-ST-02：清单场截图后时间线可读，画面条目标记已清理
  result = await request("POST", "/session/clear-frames", { sessionId: stSessA });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).clearedFrames, 2);
  assert.ok(!fs.existsSync(path.join(dataDir, "sessions", stSessA, "frames")));
  const stVLines = fs.readFileSync(path.join(dataDir, "sessions", stSessA, "visual.jsonl"), "utf-8")
    .trim().split("\n").map(l => JSON.parse(l));
  assert.equal(stVLines.length, 2);
  assert.ok(stVLines.every(v => v.framePath === null && v.frameCleared === true));
  assert.ok(stVLines.every(v => v.metrics !== undefined)); // 趋势记录保留
  result = await request("GET", "/api/session?id=" + stSessA);
  const detailA = JSON.parse(result.body);
  assert.ok(detailA.timeline.some(x => x.kind === "danmaku")); // 弹幕仍可查看
  assert.ok(detailA.timeline.filter(x => x.kind === "visual").every(x => x.data.frameCleared === true));

  // AC-ST-04：批量仅删除所选日期之前且已结束的（40 天前 < 10 天 < 1 天；C 进行中不受影响）
  result = await request("POST", "/sessions/batch-delete", { before: nowMs - 10 * 86400 * 1000 });
  assert.equal(result.status, 200);
  const batch = JSON.parse(result.body);
  assert.ok(batch.deletedIds.includes(stSessA));
  assert.ok(!batch.deletedIds.includes(stSessB));
  assert.ok(!batch.deletedIds.includes(stSessC));
  assert.ok(!fs.existsSync(path.join(dataDir, "sessions", stSessA)));
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", stSessB)));
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", stSessC)));
  // 非法 before → 400 且不删任何东西
  result = await request("POST", "/sessions/batch-delete", { before: "昨天" });
  assert.equal(result.status, 400);
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", stSessB)));

  // AC-ST-03：删单场后目录消失，其他会话不受影响
  result = await request("POST", "/session/delete", { sessionId: stSessB });
  assert.equal(result.status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, "sessions", stSessB)));
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", stSessC)));
  result = await request("POST", "/session/stop", { sessionId: stSessC });
  assert.equal(result.status, 200);
  console.log("✓ TASK-STORAGE-001（存储管理）：全部通过");

  // TASK-AI-002：单片段 AI 分析（mock 模式，不调用真实接口）
  await testAI002();
}

async function testAI002() {
  const Analysis = require("../analysis");
  const aiSess = "session_ai002test1";
  const aiDir = path.join(dataDir, "sessions", aiSess);
  fs.mkdirSync(aiDir, { recursive: true });
  const jl = (f, arr) => fs.writeFileSync(path.join(aiDir, f),
    arr.map(o => JSON.stringify(o)).join("\n") + "\n");
  fs.writeFileSync(path.join(aiDir, "session.json"), JSON.stringify({
    sessionId: aiSess, startTime: 1000000, endTime: 2000000,
  }));
  // 转写 3 条（含 1 条 mock）、弹幕 2 条（同一秒 2 条，测 ref 唯一性）
  jl("transcript.jsonl", [
    { offsetMs: 100000, text: "这个花色真的绝了", mock: false, status: "ok" },
    { offsetMs: 120000, text: "模拟话术一条", mock: true, status: "ok" },
    { offsetMs: 150000, text: "现在拍是这个价格", status: "ok" },
  ]);
  jl("danmaku.jsonl", [
    { offsetMs: 110000, userName: "用户A", text: "求链接", tag: "audience" },
    { offsetMs: 110000, userName: "用户B", text: "多少钱", tag: "audience" },
  ]);
  // 商品：0 秒换品，50 秒价格更新；分析范围 100-180 秒 → 起点商品应带最新价格
  jl("product.jsonl", [
    { offsetMs: 0, type: "product_switch", product: { name: "测试围巾", priceText: "¥299" } },
    { offsetMs: 50000, type: "price_update", product: { name: "测试围巾", priceText: "券后价¥279" } },
  ]);
  jl("visual.jsonl", [
    { offsetMs: 100000, metrics: { online: 100 }, framePath: null },
    { offsetMs: 160000, metrics: { online: 120 }, framePath: null },
  ]);

  // AI-02：起点商品含最新价格
  const { evidence, evidenceHash } = Analysis.collectEvidence(aiDir, 100000, 180000);
  assert.equal(evidence.contextProduct.name, "测试围巾");
  assert.equal(evidence.contextProduct.priceText, "券后价¥279");
  assert.ok(evidence.contextProduct.note.includes("最近识别到"));
  // AI-02b：同一秒两条弹幕 ref 唯一
  const dRefs = evidence.danmaku.map(d => d.ref);
  assert.equal(new Set(dRefs).size, 2);
  // 弹幕用户名默认不发送
  assert.ok(!("userName" in evidence.danmaku[0]) && !("user" in evidence.danmaku[0]));
  // 质量标记
  assert.equal(evidence.transcripts.find(t => t.quality === "mock").quality, "mock");
  assert.equal(evidence.transcripts.find(t => t.quality === "real").quality, "real");

  // AI-04：preview 返回条数与缺失项
  let result = await request("POST", "/api/analysis/preview",
    { sessionId: aiSess, rangeStartMs: 100000, rangeEndMs: 180000 });
  assert.equal(result.status, 200);
  const preview = JSON.parse(result.body).preview;
  assert.equal(preview.counts.transcript, 3);
  assert.equal(preview.counts.danmaku, 2);
  assert.equal(preview.evidenceHash, evidenceHash);
  assert.equal(preview.hasAnalyzable, true);

  // AI-04b：空范围 → hasAnalyzable=false，analyze 不调用
  result = await request("POST", "/api/analysis/preview",
    { sessionId: aiSess, rangeStartMs: 500000, rangeEndMs: 600000 });
  const emptyPreview = JSON.parse(result.body).preview;
  assert.equal(emptyPreview.hasAnalyzable, false);
  result = await request("POST", "/api/analyze",
    { sessionId: aiSess, rangeStartMs: 500000, rangeEndMs: 600000, evidenceHash: emptyPreview.evidenceHash });
  assert.equal(result.status, 400);
  assert.ok(JSON.parse(result.body).error.includes("无转写"));

  // Codex 评审修2：不传 evidenceHash → HASH_REQUIRED
  result = await request("POST", "/api/analyze",
    { sessionId: aiSess, rangeStartMs: 100000, rangeEndMs: 180000 });
  assert.equal(result.status, 400);
  assert.equal(JSON.parse(result.body).code, "HASH_REQUIRED");

  // AI-07：mock 分析（测试模式），MOCK 明示
  result = await request("POST", "/api/analyze",
    { sessionId: aiSess, rangeStartMs: 100000, rangeEndMs: 180000, evidenceHash });
  assert.equal(result.status, 200);
  const an1 = JSON.parse(result.body).analysis;
  assert.equal(an1.mock, true);
  assert.ok(an1.result.summary && an1.result.evidence && an1.result.suggestions && an1.result.verification);
  assert.ok(an1.analysisId.startsWith("an_"));

  // AI-06：缓存命中不重复调用
  result = await request("POST", "/api/analyze",
    { sessionId: aiSess, rangeStartMs: 100000, rangeEndMs: 180000, evidenceHash });
  assert.equal(JSON.parse(result.body).analysis.cached, true);

  // AI-01/04c：证据变化 → 409 要求重新确认
  jl("danmaku.jsonl", [
    { offsetMs: 110000, userName: "用户A", text: "求链接", tag: "audience" },
    { offsetMs: 110000, userName: "用户B", text: "多少钱", tag: "audience" },
    { offsetMs: 130000, userName: "用户C", text: "新弹幕", tag: "audience" },
  ]);
  result = await request("POST", "/api/analyze",
    { sessionId: aiSess, rangeStartMs: 100000, rangeEndMs: 180000, evidenceHash });
  assert.equal(result.status, 409);
  assert.equal(JSON.parse(result.body).code, "EVIDENCE_CHANGED");

  // AI-03：引用校验 — 不存在的 ref / 时间不一致 / 引文不一致
  const byRef = Analysis.buildEvidenceByRef(evidence);
  let v = Analysis.validateModelOutput({
    summary: "s", verification: "v",
    evidence: [{ ref: "t_9999", atMs: 1, quote: "x" }],
    suggestions: [],
  }, byRef);
  assert.equal(v.ok, false);
  v = Analysis.validateModelOutput({
    summary: "s", verification: "v",
    evidence: [{ ref: "t_0001", atMs: 999999, quote: "这个花色真的绝了" }],
    suggestions: [],
  }, byRef);
  assert.equal(v.ok, false); // 时间不一致
  v = Analysis.validateModelOutput({
    summary: "s", verification: "v",
    evidence: [{ ref: "t_0001", atMs: 100000, quote: "这个花色真的绝了" }],
    suggestions: [{ text: "多讲卖点", basedOn: ["t_0001"] }],
  }, byRef);
  assert.equal(v.ok, true);

  // AI-07b：反馈独立文件保存
  result = await request("POST", "/api/analysis/feedback",
    { sessionId: aiSess, analysisId: an1.analysisId, type: "useful", note: "靠谱" });
  assert.equal(result.status, 200);
  const fbFile = path.join(aiDir, "analysis", "feedback", an1.analysisId + ".jsonl");
  assert.ok(fs.existsSync(fbFile));
  assert.ok(fs.readFileSync(fbFile, "utf8").includes("靠谱"));
  // 反馈不嵌入分析结果文件
  const saved = JSON.parse(fs.readFileSync(
    path.join(aiDir, "analysis", an1.analysisId + ".json"), "utf8"));
  assert.ok(!saved.feedback);

  // AI-05：删除并发 — 会话删除后分析不复活目录
  const aiSess2 = "session_ai002test2";
  const aiDir2 = path.join(dataDir, "sessions", aiSess2);
  fs.mkdirSync(aiDir2, { recursive: true });
  fs.writeFileSync(path.join(aiDir2, "session.json"), JSON.stringify({ sessionId: aiSess2, startTime: 1 }));
  fs.writeFileSync(path.join(aiDir2, "transcript.jsonl"),
    JSON.stringify({ offsetMs: 1000, text: "你好", status: "ok" }) + "\n");
  const { evidenceHash: hash2 } = Analysis.collectEvidence(aiDir2, 0, 60000);
  // 模拟删除发生在保存前：直接调 analyzeRange，期间删除目录
  const p = Analysis.analyzeRange({
    sessionDir: aiDir2, sessionId: aiSess2,
    rangeStartMs: 0, rangeEndMs: 60000, evidenceHash: hash2,
    secrets: null, rulesPath: path.join(root, "analysis-rules-v1.md"), mockMode: true,
  });
  fs.rmSync(aiDir2, { recursive: true, force: true }); // 并发删除
  let goneErr = null;
  try { await p; } catch (e) { goneErr = e; }
  assert.ok(goneErr && goneErr.code === "SESSION_GONE");
  assert.ok(!fs.existsSync(aiDir2), "删除后不应重建目录");

  // 非法 analysisId → 400
  result = await request("POST", "/api/analysis/feedback",
    { sessionId: aiSess, analysisId: "../../x", type: "useful" });
  assert.equal(result.status, 400);

  // ---- Codex 评审 5 项回归 ----
  // 修1：正常模式无密钥 → 中文报错，不自动 mock
  let noKeyErr = null;
  const fresh = Analysis.collectEvidence(aiDir, 100000, 180000);
  try {
    await Analysis.analyzeRange({
      sessionDir: aiDir, sessionId: aiSess,
      rangeStartMs: 100000, rangeEndMs: 180000, evidenceHash: fresh.evidenceHash,
      secrets: null, rulesPath: path.join(root, "analysis-rules-v1.md"), mockMode: false,
    });
  } catch (e) { noKeyErr = e; }
  assert.ok(noKeyErr && noKeyErr.code === "NO_API_KEY");
  assert.ok(noKeyErr.message.includes("analysis-secrets.json"));

  // 修3：引用严格校验
  const strictByRef = Analysis.buildEvidenceByRef(evidence);
  // 引文追加编造内容 → 不通过
  v = Analysis.validateModelOutput({
    summary: "s", verification: "v",
    evidence: [{ ref: "t_0001", atMs: 100000, quote: "这个花色真的绝了然后成交暴涨十倍" }],
    suggestions: [{ text: "多讲卖点", basedOn: ["t_0001"] }],
  }, strictByRef);
  assert.equal(v.ok, false);
  // 缺 atMs → 不通过
  v = Analysis.validateModelOutput({
    summary: "s", verification: "v",
    evidence: [{ ref: "t_0001", quote: "这个花色真的绝了" }],
    suggestions: [{ text: "多讲卖点", basedOn: ["t_0001"] }],
  }, strictByRef);
  assert.equal(v.ok, false);
  // 建议无依据 → 不通过
  v = Analysis.validateModelOutput({
    summary: "s", verification: "v",
    evidence: [{ ref: "t_0001", atMs: 100000, quote: "这个花色真的绝了" }],
    suggestions: [{ text: "多讲卖点", basedOn: [] }],
  }, strictByRef);
  assert.equal(v.ok, false);
  // 畸形条目（null）→ 返回失败而非抛异常
  v = Analysis.validateModelOutput({
    summary: "s", verification: "v",
    evidence: [null], suggestions: [],
  }, strictByRef);
  assert.equal(v.ok, false);
  // 空 evidence 数组 → 不通过
  v = Analysis.validateModelOutput({
    summary: "s", verification: "v",
    evidence: [], suggestions: [],
  }, strictByRef);
  assert.equal(v.ok, false);

  // 修5：会话隔离 — 两会话相同证据，并发结果不串 sessionId
  const aiSess3 = "session_ai002test3";
  const aiDir3 = path.join(dataDir, "sessions", aiSess3);
  fs.mkdirSync(aiDir3, { recursive: true });
  fs.writeFileSync(path.join(aiDir3, "session.json"), JSON.stringify({ sessionId: aiSess3, startTime: 1 }));
  fs.writeFileSync(path.join(aiDir3, "transcript.jsonl"),
    JSON.stringify({ offsetMs: 1000, text: "你好", status: "ok" }) + "\n");
  const { evidenceHash: hash3 } = Analysis.collectEvidence(aiDir3, 0, 60000);
  // 与 aiSess2 相同内容（aiSess2 已被删除，这里重建一个同内容会话做隔离测试太复杂；
  // 直接验证 inflight 键包含 sessionId：同时发起两个不同会话的请求）
  const aiSess4 = "session_ai002test4";
  const aiDir4 = path.join(dataDir, "sessions", aiSess4);
  fs.mkdirSync(aiDir4, { recursive: true });
  fs.writeFileSync(path.join(aiDir4, "session.json"), JSON.stringify({ sessionId: aiSess4, startTime: 1 }));
  fs.writeFileSync(path.join(aiDir4, "transcript.jsonl"),
    JSON.stringify({ offsetMs: 1000, text: "你好", status: "ok" }) + "\n");
  const { evidenceHash: hash4 } = Analysis.collectEvidence(aiDir4, 0, 60000);
  assert.equal(hash3, hash4); // 证据相同，hash 相同
  const [r3, r4] = await Promise.all([
    Analysis.analyzeRange({
      sessionDir: aiDir3, sessionId: aiSess3, rangeStartMs: 0, rangeEndMs: 60000,
      evidenceHash: hash3, secrets: null,
      rulesPath: path.join(root, "analysis-rules-v1.md"), mockMode: true,
    }),
    Analysis.analyzeRange({
      sessionDir: aiDir4, sessionId: aiSess4, rangeStartMs: 0, rangeEndMs: 60000,
      evidenceHash: hash4, secrets: null,
      rulesPath: path.join(root, "analysis-rules-v1.md"), mockMode: true,
    }),
  ]);
  assert.equal(r3.sessionId, aiSess3);
  assert.equal(r4.sessionId, aiSess4);
  assert.notEqual(r3.analysisId, r4.analysisId);

  console.log("✓ TASK-AI-002（单片段 AI 分析 mock）：全部通过");
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (server && !server.killed) server.kill("SIGINT");
  fs.rmSync(dataDir, { recursive: true, force: true });
});
