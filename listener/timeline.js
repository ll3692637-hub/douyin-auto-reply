/**
 * Timeline - 全场总览时间轴（TASK-UI-003）
 * Canvas 自绘：四轨道（商品区间 / 价格更新 / 在线采样 / 截图位置）
 * 交互：横向拖拽平移、滚轮缩放、Shift+拖拽框选范围、点击节点
 * 数据只做聚合标记绘制，不渲染逐条转写/弹幕（长直播性能）
 */
(function (global) {
  "use strict";

  const TRACKS = [
    { key: "products", label: "商品", y: 8, h: 30 },
    { key: "prices", label: "价格", y: 44, h: 22 },
    { key: "online", label: "在线", y: 72, h: 44 },
    { key: "shots", label: "截图", y: 122, h: 22 },
  ];
  const AXIS_H = 22;
  const HEIGHT = 152 + AXIS_H;

  function Timeline(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.data = { durationMs: 0, products: [], prices: [], online: [], shots: [] };
    this.view = { start: 0, end: 1 };
    this.sel = null; // {start, end} 框选范围（ms）
    this.cursor = null; // 定位线（ms）
    this.onRangeSelect = null;
    this.onNodeClick = null;
    this.onPointClick = null; // 点击空白处：查看该时间点前后证据
    this._nodes = []; // 本次绘制的节点（命中测试用）
    this._drag = null;
    this._selectMode = false;
    this._bind();
  }

  Timeline.prototype.setData = function (data) {
    this.data = data;
    const dur = Math.max(data.durationMs || 0, 60000);
    this.view = { start: 0, end: dur };
    this.sel = null;
    this.cursor = null;
    this.render();
  };

  Timeline.prototype.setView = function (startMs, endMs) {
    const dur = Math.max(this.data.durationMs || 0, 60000);
    let s = Math.max(0, startMs), e = Math.min(dur, endMs);
    if (e - s < 5000) { const m = (s + e) / 2; s = m - 2500; e = m + 2500; }
    this.view = { start: Math.max(0, s), end: Math.min(dur, e) };
    this.render();
  };

  // 快捷视图：full | 30m | 10m
  Timeline.prototype.quickView = function (preset) {
    const dur = Math.max(this.data.durationMs || 0, 60000);
    if (preset === "full") { this.setView(0, dur); return; }
    const span = preset === "30m" ? 30 * 60000 : 10 * 60000;
    const c = this.cursor != null ? this.cursor
      : (this.sel ? (this.sel.start + this.sel.end) / 2
      : (this.view.start + this.view.end) / 2);
    this.setView(c - span / 2, c + span / 2);
  };

  Timeline.prototype.setSelection = function (startMs, endMs) {
    this.sel = { start: startMs, end: endMs };
    this.render();
  };

  Timeline.prototype.setCursor = function (atMs) {
    this.cursor = atMs;
    // 定位点不在视窗内时平移视窗
    if (atMs < this.view.start || atMs > this.view.end) {
      const span = this.view.end - this.view.start;
      this.setView(atMs - span / 2, atMs + span / 2);
    } else {
      this.render();
    }
  };

  Timeline.prototype._x = function (ms) {
    const w = this.cv.clientWidth;
    return ((ms - this.view.start) / (this.view.end - this.view.start)) * w;
  };

  Timeline.prototype._ms = function (x) {
    const w = this.cv.clientWidth;
    return this.view.start + (x / w) * (this.view.end - this.view.start);
  };

  Timeline.prototype._bind = function () {
    const cv = this.cv, self = this;
    cv.style.cursor = "grab";
    cv.addEventListener("mousedown", (e) => {
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      // 先做节点命中测试
      const hit = self._hitNode(x, y);
      if (hit && !e.shiftKey) {
        if (self.onNodeClick) self.onNodeClick(hit);
        return;
      }
      self._drag = { x0: x, ms0: self._ms(x), select: e.shiftKey, moved: false };
      cv.style.cursor = e.shiftKey ? "crosshair" : "grabbing";
    });
    cv.addEventListener("mousemove", (e) => {
      if (!self._drag) return;
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (Math.abs(x - self._drag.x0) > 3) self._drag.moved = true;
      if (self._drag.select) {
        const a = self._ms(Math.min(self._drag.x0, x));
        const b = self._ms(Math.max(self._drag.x0, x));
        self.sel = { start: a, end: b };
        self.render();
      } else {
        const dxMs = self._ms(x) - self._drag.ms0;
        const span = self.view.end - self.view.start;
        const dur = Math.max(self.data.durationMs || 0, 60000);
        let s = self.view.start - dxMs, en = self.view.end - dxMs;
        if (s < 0) { en -= s; s = 0; }
        if (en > dur) { s -= (en - dur); en = dur; }
        if (s < 0) s = 0;
        self.view = { start: s, end: en };
        self._drag.ms0 = self._ms(x);
        self.render();
      }
    });
    cv.addEventListener("mouseup", (e) => {
      const d = self._drag;
      self._drag = null;
      cv.style.cursor = "grab";
      if (!d) return;
      if (d.select && d.moved && self.sel && self.onRangeSelect) {
        self.onRangeSelect({ start: Math.round(self.sel.start), end: Math.round(self.sel.end) });
      } else if (!d.moved && !d.select && self.onPointClick) {
        // 纯点击时间轴空白处：定位该时间，回调由调用方决定展示范围
        const rect = cv.getBoundingClientRect();
        self.onPointClick(Math.round(self._ms(e.clientX - rect.left)));
      }
    });
    cv.addEventListener("mouseleave", () => {
      if (self._drag && self._drag.select && self._drag.moved && self.sel && self.onRangeSelect) {
        self.onRangeSelect({ start: Math.round(self.sel.start), end: Math.round(self.sel.end) });
      }
      self._drag = null;
      cv.style.cursor = "grab";
    });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const atMs = self._ms(x);
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      const span = (self.view.end - self.view.start) * factor;
      const dur = Math.max(self.data.durationMs || 0, 60000);
      const clamped = Math.min(Math.max(span, 10000), dur);
      const ratio = (atMs - self.view.start) / (self.view.end - self.view.start);
      let s = atMs - clamped * ratio, en = s + clamped;
      if (s < 0) { en -= s; s = 0; }
      if (en > dur) { s -= (en - dur); en = dur; }
      self.view = { start: Math.max(0, s), end: en };
      self.render();
    }, { passive: false });
  };

  Timeline.prototype._hitNode = function (x, y) {
    for (let i = this._nodes.length - 1; i >= 0; i--) {
      const n = this._nodes[i];
      if (x >= n.x0 && x <= n.x1 && y >= n.y0 && y <= n.y1) return n.ref;
    }
    return null;
  };

  function fmtAxis(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${p(h)}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
  }

  Timeline.prototype.render = function () {
    const cv = this.cv, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = HEIGHT;
    if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this._nodes = [];

    const X = (ms) => this._x(ms);
    const span = this.view.end - this.view.start;

    // 背景 + 轨道分隔线
    ctx.fillStyle = "#fafbfc";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#eee";
    ctx.lineWidth = 1;
    TRACKS.forEach(t => {
      ctx.beginPath(); ctx.moveTo(0, t.y + t.h + 4); ctx.lineTo(w, t.y + t.h + 4); ctx.stroke();
      ctx.fillStyle = "#bbb"; ctx.font = "11px sans-serif";
      ctx.fillText(t.label, 4, t.y + 12);
    });

    // 框选范围高亮
    if (this.sel) {
      ctx.fillStyle = "rgba(33,150,243,0.12)";
      ctx.fillRect(X(this.sel.start), 0, X(this.sel.end) - X(this.sel.start), h - AXIS_H);
      ctx.strokeStyle = "#2196F3";
      ctx.strokeRect(X(this.sel.start) + .5, .5, X(this.sel.end) - X(this.sel.start), h - AXIS_H - 1);
    }

    // 轨道1：商品区间
    this.data.products.forEach(p => {
      const x0 = Math.max(0, X(p.startMs)), x1 = Math.min(w, X(p.endMs));
      if (x1 <= 0 || x0 >= w) return;
      const t = TRACKS[0];
      ctx.fillStyle = p.type === "unrecognized" ? "#e0e0e0" : "#c8e6c9";
      ctx.strokeStyle = p.type === "unrecognized" ? "#bdbdbd" : "#66bb6a";
      const bw = Math.max(2, x1 - x0);
      ctx.fillRect(x0, t.y, bw, t.h);
      ctx.strokeRect(x0 + .5, t.y + .5, bw - 1, t.h - 1);
      if (bw > 60 && p.name) {
        ctx.fillStyle = "#333"; ctx.font = "11px sans-serif";
        ctx.fillText(p.name.slice(0, Math.floor(bw / 7)), x0 + 4, t.y + 19, bw - 8);
      }
      this._nodes.push({ x0, x1: x0 + bw, y0: t.y, y1: t.y + t.h, ref: { type: "product", data: p } });
    });

    // 轨道2：价格更新（菱形）
    this.data.prices.forEach(pr => {
      const x = X(pr.atMs);
      if (x < 0 || x > w) return;
      const t = TRACKS[1], cy = t.y + t.h / 2;
      ctx.fillStyle = "#ff9800";
      ctx.beginPath();
      ctx.moveTo(x, cy - 7); ctx.lineTo(x + 7, cy); ctx.lineTo(x, cy + 7); ctx.lineTo(x - 7, cy);
      ctx.closePath(); ctx.fill();
      this._nodes.push({ x0: x - 8, x1: x + 8, y0: t.y, y1: t.y + t.h, ref: { type: "price", data: pr } });
    });

    // 轨道3：在线采样（只连真实采样点，无数据处断开）
    const t3 = TRACKS[2];
    const pts = this.data.online
      .filter(o => o.atMs >= this.view.start - span && o.atMs <= this.view.end + span && o.online != null);
    if (pts.length) {
      const vals = pts.map(o => o.online);
      const mn = Math.min(...vals), mx = Math.max(...vals);
      const pad = Math.max(1, (mx - mn) * 0.1);
      const Y = (v) => t3.y + t3.h - 4 - ((v - mn + pad * 0) / (mx - mn + pad * 2)) * (t3.h - 8);
      ctx.strokeStyle = "#2196F3"; ctx.lineWidth = 1.5;
      ctx.fillStyle = "#2196F3";
      let prev = null;
      // 按时间排序后，只连接相邻且间隔合理的点（>10分钟断开，避免把无数据处连起来）
      const sorted = pts.slice().sort((a, b) => a.atMs - b.atMs);
      sorted.forEach(o => {
        const x = X(o.atMs), y = Y(o.online);
        if (x < -20 || x > w + 20) { prev = null; return; }
        if (prev && o.atMs - prev.atMs < 10 * 60000) {
          ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
        prev = { x, y, atMs: o.atMs };
      });
      if (mx !== mn) {
        ctx.fillStyle = "#999"; ctx.font = "10px sans-serif";
        ctx.fillText(String(mx), 34, t3.y + 10);
        ctx.fillText(String(mn), 34, t3.y + t3.h - 2);
      }
    } else {
      ctx.fillStyle = "#ccc"; ctx.font = "11px sans-serif";
      ctx.fillText("本视窗无在线采样", 40, t3.y + t3.h / 2 + 4);
    }

    // 轨道4：截图位置
    this.data.shots.forEach(s => {
      const x = X(s.atMs);
      if (x < 0 || x > w) return;
      const t = TRACKS[3];
      ctx.fillStyle = "#9c27b0";
      ctx.fillRect(x - 1.5, t.y, 3, t.h);
      ctx.beginPath(); ctx.arc(x, t.y + 4, 3, 0, Math.PI * 2); ctx.fill();
      this._nodes.push({ x0: x - 6, x1: x + 6, y0: t.y, y1: t.y + t.h, ref: { type: "shot", data: s } });
    });

    // 定位线
    if (this.cursor != null) {
      const x = X(this.cursor);
      if (x >= 0 && x <= w) {
        ctx.strokeStyle = "#f44336"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - AXIS_H); ctx.stroke();
      }
    }

    // 时间轴
    const ay = h - AXIS_H;
    ctx.strokeStyle = "#ccc";
    ctx.beginPath(); ctx.moveTo(0, ay + .5); ctx.lineTo(w, ay + .5); ctx.stroke();
    ctx.fillStyle = "#888"; ctx.font = "10px sans-serif";
    const targetTicks = Math.max(2, Math.floor(w / 90));
    const rawStep = span / targetTicks;
    const step = niceStep(rawStep);
    const first = Math.ceil(this.view.start / step) * step;
    for (let ms = first; ms <= this.view.end; ms += step) {
      const x = X(ms);
      ctx.beginPath(); ctx.moveTo(x, ay); ctx.lineTo(x, ay + 5); ctx.stroke();
      ctx.fillText(fmtAxis(ms), x + 3, ay + 16);
    }
  };

  function niceStep(raw) {
    const steps = [5000, 10000, 30000, 60000, 300000, 600000, 1800000, 3600000, 7200000];
    for (const s of steps) if (s >= raw) return s;
    return 14400000;
  }

  global.Timeline = Timeline;
})(typeof window !== "undefined" ? window : this);
