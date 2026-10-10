// =============================================
// Offscreen Audio Processor
// 负责：tabCapture 音频采集 → 16kHz/mono/16bit PCM → 分片发送到本地服务
// 同时把音频回放到扬声器，确保直播声音不消失
// =============================================

const LOCAL_SERVER = "http://127.0.0.1:17842";
// 分片时长配置位置（TASK-ASR-002）：改这里即可调整，单位毫秒。
// 约 18 秒一片：时间定位更细、长句混杂更少；代价是 API 调用量约为 45 秒分片的 2.5 倍。
const CHUNK_INTERVAL_MS = 18000;

let audioCtx = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let silenceGain = null;

let pcmBuffer = []; // Array of Int16Array chunks
let bufferSampleCount = 0;
let chunkSeq = 0;
let sessionId = null;
let sessionStartTime = 0;
let chunkTimer = null;
let isCapturing = false;

// ---- 消息处理 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "OFFSCREEN_START_CAPTURE") {
    startCapture(msg.streamId, msg.sessionId, msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: safeErr(err) }));
    return true;
  }
  if (msg.type === "OFFSCREEN_STOP_CAPTURE") {
    stopCapture()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: safeErr(err) }));
    return true;
  }
  if (msg.type === "OFFSCREEN_STATUS") {
    sendResponse({
      capturing: isCapturing,
      sessionId,
      chunksSent: chunkSeq,
      bufferedSamples: bufferSampleCount
    });
    return false;
  }
});

function safeErr(err) {
  // 返回不含敏感信息的错误描述
  const msg = (err && err.message) ? err.message : String(err || "unknown");
  // 过滤可能的 URL / token 信息
  return msg.replace(/(secretId|secretKey|appId)[^,\s]*/gi, "$1:***");
}

function reportCaptureError(err) {
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_CAPTURE_ERROR",
    sessionId,
    error: safeErr(err)
  }).catch(() => {});
}

// ---- 启动采集 ----
async function startCapture(streamId, sid, tabId) {
  if (isCapturing) {
    throw new Error("already capturing");
  }

  sessionId = sid;
  sessionStartTime = Date.now();
  chunkSeq = 0;
  pcmBuffer = [];
  bufferSampleCount = 0;

  // 1. 用 streamId 获取 tab 音频流
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });

  // 2. 创建 AudioContext，要求浏览器输出 16kHz PCM。
  audioCtx = new AudioContext({ sampleRate: 16000 });
  if (audioCtx.sampleRate !== 16000) {
    await audioCtx.close();
    audioCtx = null;
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
    throw new Error("浏览器无法提供 16kHz 音频采样");
  }
  await audioCtx.resume();
  if (audioCtx.state !== "running") {
    await audioCtx.close();
    audioCtx = null;
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
    throw new Error("浏览器未能启动音频播放，已取消监听以避免静音");
  }
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);

  // 3. ScriptProcessorNode 处理音频 (1 进 1 出, 单声道)
  const BUFFER_SIZE = 4096;
  processorNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);

  processorNode.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0); // Float32Array, 单声道, 16kHz
    const pcm = float32ToInt16(input);
    pcmBuffer.push(pcm);
    bufferSampleCount += pcm.length;

    // 处理节点本身不负责回放；音源会直接连接到 destination。
    const output = e.outputBuffer.getChannelData(0);
    for (let i = 0; i < output.length; i++) output[i] = 0;
  };

  // 4. 同一音源分两路：一路继续播放，另一路仅用于转写采样。
  //    这样 tabCapture 不会把直播声音静音，也不会产生重复声音。
  sourceNode.connect(audioCtx.destination);
  sourceNode.connect(processorNode);
  // Keep the processor graph alive without sending a second audible signal.
  silenceGain = audioCtx.createGain();
  silenceGain.gain.value = 0;
  processorNode.connect(silenceGain);
  silenceGain.connect(audioCtx.destination);

  isCapturing = true;
  console.log("[Offscreen] 采集已启动, sessionId:", sid);

  // 6. 定时发送分片
  chunkTimer = setInterval(() => {
    flushChunk().catch(err => {
      console.error("[Offscreen] 发送分片失败:", safeErr(err));
      reportCaptureError(err);
    });
  }, CHUNK_INTERVAL_MS);
}

// ---- 停止采集 ----
async function stopCapture() {
  if (chunkTimer) {
    clearInterval(chunkTimer);
    chunkTimer = null;
  }

  // 发送最后的缓冲数据
  if (bufferSampleCount > 0) {
    try {
      await flushChunk();
    } catch (e) {
      console.warn("[Offscreen] 最后分片发送失败:", safeErr(e));
      reportCaptureError(e);
    }
  }

  isCapturing = false;

  if (processorNode) { processorNode.disconnect(); processorNode = null; }
  if (silenceGain) { silenceGain.disconnect(); silenceGain = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (audioCtx) { await audioCtx.close(); audioCtx = null; }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  console.log("[Offscreen] 采集已停止, 共发送", chunkSeq, "段");
}

// ---- 发送 PCM 分片到本地服务 ----
async function flushChunk() {
  if (!isCapturing || bufferSampleCount === 0) return;

  // 合并缓冲
  const merged = mergeInt16Arrays(pcmBuffer);
  pcmBuffer = [];
  bufferSampleCount = 0;

  chunkSeq++;
  const offsetMs = (Date.now() - sessionStartTime);
  const audioStartMs = offsetMs - (merged.length / 16); // 16kHz → ms

  const payload = {
    sessionId,
    sequence: chunkSeq,
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    audioStartMs: Math.max(0, audioStartMs),
    timestamp: Date.now()
  };

  // 用 multipart 发送：JSON header + binary PCM body
  const header = JSON.stringify(payload);
  const headerBytes = new TextEncoder().encode(header);
  const headerLen = new Uint32Array([headerBytes.length]).buffer; // 4 字节长度前缀

  // 拼接: [4字节 header length][header json][pcm data]
  const combined = new Uint8Array(4 + headerBytes.length + merged.byteLength);
  combined.set(new Uint8Array(headerLen), 0);
  combined.set(headerBytes, 4);
  combined.set(new Uint8Array(merged.buffer), 4 + headerBytes.length);

  const resp = await fetch(`${LOCAL_SERVER}/audio`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: combined.buffer
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`server ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const result = await resp.json().catch(() => ({}));
  chrome.runtime.sendMessage({ type: "OFFSCREEN_CHUNK_SENT", sessionId, sequence: chunkSeq }).catch(() => {});
  console.log(`[Offscreen] 分片 #${chunkSeq} 已发送, ${merged.length} samples (${(merged.length/16).toFixed(1)}s), ASR: ${result.transcript ? result.transcript.slice(0, 40) + "..." : "pending"}`);
}

// ---- 工具函数 ----
function float32ToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

function mergeInt16Arrays(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const merged = new Int16Array(total);
  let offset = 0;
  for (const a of arrays) {
    merged.set(a, offset);
    offset += a.length;
  }
  return merged;
}

console.log("[Offscreen] offscreen audio processor 已就绪");
