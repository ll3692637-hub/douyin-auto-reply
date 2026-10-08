// =============================================
// 抖音直播 WS Patch v3 — MAIN 世界
// 用 postMessage 跨世界通信（CustomEvent 不行！）
// =============================================

(function() {
  if (window.__douyin_ws_patched) return;
  window.__douyin_ws_patched = true;
  window.__douyin_chat_messages = [];

  console.log("[DouyinWS] WebSocket 拦截已就绪 (v3 postMessage)");

  const OrigWebSocket = window.WebSocket;
  let msgLogCount = 0;

  window.WebSocket = function(url, protocols) {
    const ws = arguments.length === 2
      ? new OrigWebSocket(url, protocols)
      : new OrigWebSocket(url);

    const isChatWs = typeof url === 'string' && url.includes('webcast');

    if (isChatWs) {
      console.log('[DouyinWS] ★ 聊天WebSocket:', (url || '').slice(0, 80));

      ws.addEventListener = function(type, listener, options) {
        if (type === 'message') {
          const wrapped = function(event) {
            processMessage(event.data, 'chat-ws');
            return listener.call(this, event);
          };
          return EventTarget.prototype.addEventListener.call(this, type, wrapped, options);
        }
        return EventTarget.prototype.addEventListener.call(this, type, listener, options);
      };

      let _onmessage = null;
      Object.defineProperty(ws, 'onmessage', {
        get() { return _onmessage; },
        set(fn) {
          if (typeof fn !== 'function') { _onmessage = fn; return; }
          _onmessage = function(event) {
            processMessage(event.data, 'chat-ws-onmessage');
            return fn.call(this, event);
          };
          EventTarget.prototype.addEventListener.call(ws, 'message', _onmessage);
        },
        configurable: true, enumerable: true
      });
    }

    return ws;
  };

  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = 0;
  window.WebSocket.OPEN = 1;
  window.WebSocket.CLOSING = 2;
  window.WebSocket.CLOSED = 3;

  function processMessage(data, source) {
    msgLogCount++;

    if (msgLogCount <= 20) {
      let type = typeof data;
      let size = 0;
      if (data instanceof ArrayBuffer) { type = 'ArrayBuffer'; size = data.byteLength; }
      else if (data instanceof Blob) { type = 'Blob'; size = data.size; }
      else if (data instanceof Uint8Array) { type = 'Uint8Array'; size = data.length; }
      else if (typeof data === 'string') size = data.length;
      console.log(`[DouyinWS] 消息#${msgLogCount} [${source}] type=${type} size=${size}`);
    }

    if (typeof data === 'string') {
      try {
        const obj = JSON.parse(data);
        const chat = digChatData(obj);
        if (chat && chat.content) {
          console.log('[DouyinWS] ✓ JSON聊天:', chat.user, chat.content.slice(0, 30));
          emitChat(chat);
        }
      } catch(e) {}
      return;
    }

    // Blob → ArrayBuffer
    if (data instanceof Blob) {
      data.arrayBuffer().then(buf => processBinary(new Uint8Array(buf), source)).catch(() => {});
      return;
    }

    // ArrayBuffer / Uint8Array
    if (data instanceof ArrayBuffer) { processBinary(new Uint8Array(data), source); return; }
    if (data instanceof Uint8Array) { processBinary(data, source); return; }
  }

  function processBinary(bytes, source) {
    const texts = extractTexts(bytes);
    if (msgLogCount <= 20 && texts.length > 0) {
      console.log(`[DouyinWS] 消息#${msgLogCount} 提取 ${texts.length} 段:`, texts.slice(0, 10).map(s => s.slice(0, 30)));
    }
    for (const t of texts) {
      if (t.length >= 2) {
        emitChat({ user: '', content: t });
      }
    }
  }

  function extractTexts(bytes) {
    const results = [];
    let start = -1;

    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const isChar = (b >= 0x20 && b < 0x7F) || (b >= 0xC0);
      if (isChar && start === -1) start = i;
      else if (!isChar && start !== -1) {
        tryDecode(bytes, start, i, results);
        start = -1;
      }
    }
    if (start !== -1) tryDecode(bytes, start, bytes.length, results);
    return results;
  }

  function tryDecode(bytes, start, end, results) {
    if (end - start < 3) return;
    const slice = bytes.slice(start, end);
    try {
      const str = new TextDecoder('utf-8', { fatal: true }).decode(slice);
      const printable = str.replace(/[\x00-\x1F\x7F-\x9F]/g, '').length;
      if (str.length >= 2 && printable / str.length > 0.5) {
        results.push(str);
      }
    } catch(e) {}
  }

  function digChatData(obj, depth) {
    if (!obj || typeof obj !== 'object') return null;
    if (depth === undefined) depth = 0;
    if (depth > 12) return null;

    const content = obj.content || obj.message || obj.text || obj.msg
      || obj.body || obj.comment || obj.chat || obj.speech || obj.data;
    const user = obj.user || obj.nickname || obj.nick || obj.name
      || obj.sender || obj.author || obj.from_user || obj.display_name
      || obj.uniqueId || obj.sec_uid;

    if (typeof content === 'string' && content.length >= 1 && content.length < 1000) {
      let uname = '';
      if (typeof user === 'string') uname = user;
      else if (typeof user === 'object' && user !== null) {
        uname = user.nickname || user.nick || user.name || user.uniqueId || '';
      }
      return { user: uname, content };
    }

    const priority = ['common', 'extra', 'payload', 'data', 'body',
      'msg', 'message', 'content', 'response', 'result', 'params',
      'event', 'eventData', 'd', 'm', 'push_frame'];
    for (const key of priority) {
      if (obj[key] !== undefined) {
        const r = digChatData(obj[key], depth + 1);
        if (r) return r;
      }
    }

    for (const key in obj) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        const r = digChatData(obj[key], depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  // ★ 关键修复：用 postMessage 替代 CustomEvent
  function emitChat(chat) {
    chat._time = Date.now();
    window.__douyin_chat_messages.push(chat);
    window.postMessage({
      source: 'douyin-auto-reply',
      type: 'chat-message',
      user: chat.user || '',
      content: chat.content || ''
    }, '*');
  }
})();
