/**
 * 生成 4 小时模拟会话（TASK-UI-003 验收用）
 * 用法：cd listener && node test/gen_4h_session.js
 * 输出：sessions/session_4h_demo_<ts>/（本机 sessions 目录，gitignore）
 * 数据全部为模拟，session.json 标记 mock:true
 */
const fs = require("fs");
const path = require("path");

const SESSIONS_DIR = process.env.LISTENER_DATA_DIR
  ? path.join(process.env.LISTENER_DATA_DIR, "sessions")
  : path.join(__dirname, "..", "sessions");

const HOUR = 3600000;
const DURATION = 4 * HOUR;

const PRODUCTS = [
  { name: "桑蚕丝围巾·墨韵东方", priceText: "券后价¥199", price: "199" },
  { name: "羊绒方巾·米白格纹", priceText: "¥299", price: "299" },
  { name: "真丝拉绒披肩·落日熔金", priceText: "??99元", price: null },
  { name: "双面印花丝巾·锦鱼绘", priceText: "¥359", price: "359" },
  { name: "针织披肩·燕麦色", priceText: "券后价¥149", price: "149" },
  { name: "羊毛围巾·藏青条纹", priceText: "¥259", price: "259" },
  { name: "桑蚕丝小方巾·樱花粉", priceText: "??3元", price: null },
  { name: "披肩·墨绿提花", priceText: "¥399", price: "399" },
];

const PHRASES = [
  "这个花色真的绝了，姐妹们看一下这个光泽",
  "100%桑蚕丝，摸上去滑滑的，一点都不扎",
  "现在拍是这个价格，过完今天就没有了",
  "这条可以当披肩也可以当围巾，一巾两用",
  "我们家用到的全部都是真丝，百分之百的",
  "想要的直接去拍，3号链接，3号链接",
  "这个颜色很衬肤色，黄皮也能驾驭",
  "手工抽须的流苏，每一条都是师傅手工做的",
];

function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function main() {
  const sessionId = "session_4h_demo_" + Date.now().toString(36);
  const dir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });

  const startTime = Date.now() - DURATION;
  const endTime = startTime + DURATION;

  // 转写：每 ~18 秒一条
  const transcripts = [];
  for (let t = 0; t < DURATION; t += 18000) {
    transcripts.push({
      timestamp: new Date(startTime + t).toISOString(),
      offsetMs: t,
      text: pick(PHRASES) + `（模拟${Math.floor(t / 60000)}分）`,
      mock: true, status: "ok", profileId: "general"
    });
  }

  // 弹幕：随机 300 条
  const danmaku = [];
  for (let i = 0; i < 300; i++) {
    const t = Math.floor(rand(0, DURATION));
    danmaku.push({
      timestamp: new Date(startTime + t).toISOString(),
      offsetMs: t,
      userName: "模拟用户" + (i % 50),
      userId: "mock_" + (i % 50),
      text: pick(["求链接", "这个多少钱", "已拍", "好看", "主播讲一下材质", "有其他颜色吗"]),
      tag: "audience",
      mock: true
    });
  }
  danmaku.sort((a, b) => a.offsetMs - b.offsetMs);

  // 商品：每 30 分钟换品，共 8 个；中途穿插价格更新
  const products = [];
  PRODUCTS.forEach((p, i) => {
    const t = i * 30 * 60000;
    products.push({
      timestamp: new Date(startTime + t).toISOString(),
      offsetMs: t,
      type: "product_switch",
      key: "np:" + p.name + "|" + (p.price || p.priceText),
      product: { ...p, seq: String(i + 1), source: "讲解商品卡" },
      matchedSelector: "mock",
      mock: true
    });
    // 该商品讲解 15 分钟后价格更新一次
    if (i % 2 === 0) {
      const pt = t + 15 * 60000;
      const newPriceText = p.price ? "券后价¥" + (Number(p.price) - 20) : p.priceText;
      products.push({
        timestamp: new Date(startTime + pt).toISOString(),
        offsetMs: pt,
        type: "price_update",
        key: "np:" + p.name + "|" + (p.price || p.priceText),
        product: { ...p, priceText: newPriceText, source: "讲解商品卡" },
        matchedSelector: "mock",
        mock: true
      });
    }
  });
  products.sort((a, b) => a.offsetMs - b.offsetMs);

  // 画面/在线：每 5 分钟一个采样点，在线数在 800-1500 波动，个别点无数据
  const visuals = [];
  let seq = 0;
  for (let t = 0; t < DURATION; t += 5 * 60000) {
    seq++;
    const hasData = Math.random() > 0.12;
    const online = hasData ? Math.floor(rand(800, 1500)) : null;
    visuals.push({
      timestamp: new Date(startTime + t).toISOString(),
      offsetMs: t,
      sequence: seq,
      framePath: hasData ? `frames/${t}_${seq}.jpg` : null,
      frameError: hasData ? null : "mock_no_frame",
      frameCleared: false,
      metrics: { online, enter: null, leave: null },
      rawMetrics: { online: online == null ? null : String(online), enter: null, leave: null },
      matchedSelector: hasData ? '[data-e2e="live-room-audience"]' : null,
      mock: true
    });
  }
  // 生成占位截图文件（1x1 JPEG 太小会被拒？直接写最小合法 JPEG 魔数，服务端不校验复盘读取）
  const framesDir = path.join(dir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  const tinyJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
  visuals.forEach(v => {
    if (v.framePath) fs.writeFileSync(path.join(dir, v.framePath), tinyJpeg);
  });

  const writeJsonl = (name, arr) =>
    fs.writeFileSync(path.join(dir, name), arr.map(o => JSON.stringify(o)).join("\n") + "\n");
  writeJsonl("transcript.jsonl", transcripts);
  writeJsonl("danmaku.jsonl", danmaku);
  writeJsonl("product.jsonl", products);
  writeJsonl("visual.jsonl", visuals);

  const info = {
    sessionId, startTime, endTime,
    transcriptCount: transcripts.length,
    danmakuCount: danmaku.length,
    audioChunks: Math.floor(DURATION / 18000),
    visualCount: visuals.length,
    productCount: products.filter(p => p.type === "product_switch").length,
    mock: true,
    profileSnapshot: { profileId: "general", profileName: "通用" }
  };
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(info, null, 2));

  console.log("4h 模拟会话已生成:", sessionId);
  console.log(`转写 ${transcripts.length} · 弹幕 ${danmaku.length} · 换品 ${info.productCount} · 画面 ${visuals.length}`);
}

main();
