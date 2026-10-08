# 直播自动回复助手 — Chrome 扩展 v2.0

抖音 + 视频号双平台直播间公屏弹幕关键词自动回复工具，支持规则管理、智能匹配、防刷屏。

---

## 目录

- [安装方法](#安装方法)
- [使用方法](#使用方法)
- [项目结构](#项目结构)
- [架构设计](#架构设计)
- [核心模块说明](#核心模块说明)
- [调试指南](#调试指南)
- [版本历史](#版本历史)
- [免责声明](#免责声明)

---

## 安装方法

### 步骤 1：打开扩展管理页

在 Chrome 地址栏输入 `chrome://extensions/`，回车。

### 步骤 2：开启开发者模式

点击右上角「**开发者模式**」开关。

### 步骤 3：加载扩展

点击「**加载已解压的扩展程序**」→ 选择本目录（`douyin-auto-reply` 文件夹）。

### 步骤 4：固定到工具栏（推荐）

点击右上角拼图图标，找到「直播自动回复助手」，点图钉固定。

---

## 使用方法

### 抖音

1. 打开任意抖音直播间 (`live.douyin.com/...`)
2. 右下角出现绿色「自动回复开启」提示即就绪
3. 点击工具栏图标查看状态和最近回复记录

### 视频号

1. 打开视频号助手后台 (`channels.weixin.qq.com/.../liveBuild`)
2. F12 控制台出现 `[📺视频号] ★★ V2重写版已加载 ★★` 即就绪
3. 页面顶部会出现绿色圆点状态指示灯（💬）
4. 评论扫描和回复自动运行

### 规则配置

- 快捷：点击工具栏图标 → 查看规则
- 完整管理：点击「管理规则 ↗」进入选项页（options/options.html）
- 数据导出：选项页支持规则 JSON 导入/导出

---

## 项目结构

```
douyin-auto-reply/
├── manifest.json                  # 扩展配置 (MV3)
├── background/
│   └── service_worker.js          # 规则引擎、去重、限速、消息路由
├── content/
│   ├── ws-patch.js                # 抖音 WebSocket 拦截（注入 MAIN world）
│   ├── content.js                 # 抖音直播间 content script
│   └── content_channels.js        # 视频号助手 content script
├── popup/
│   ├── popup.html                 # 工具栏弹出面板
│   └── popup.js                   # 面板逻辑
├── options/
│   ├── options.html               # 规则管理/历史/设置页
│   ├── options.js                 # 页面逻辑
│   └── diagnose.html              # 诊断工具页
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── gen_icons.py               # 图标生成脚本
└── README.md                      # 本文件
```

---

## 架构设计

```
┌─────────────────────────────────────────────────┐
│                   浏览器                          │
│  ┌──────────────┐  ┌──────────────┐             │
│  │ 抖音直播间    │  │ 视频号助手    │  (多标签页)  │
│  │ content.js   │  │content_chann │             │
│  │ DOM扫描+WS   │  │ DOM扫描      │             │
│  └──────┬───────┘  └──────┬───────┘             │
│         │                 │                      │
│         │   chrome.runtime.sendMessage           │
│         │   {type:"NEW_DANMAKU", data:{text,     │
│         │    userName, userId}}                   │
│         │                 │                      │
│         └────────┬────────┘                      │
│                  ▼                                │
│  ┌──────────────────────────────┐                │
│  │  Service Worker              │                │
│  │  - matchRules()   规则匹配   │                │
│  │  - pickReply()    回复选择   │                │
│  │  - dedupCache     去重      │                │
│  │  - rateWindow     限速      │                │
│  │  - storage        持久化    │                │
│  └──────────┬───────────────────┘                │
│             │ chrome.tabs.sendMessage             │
│             │ {type:"DO_REPLY", text: "回复内容"} │
│             ▼                                     │
│  ┌──────────────────────────────┐                │
│  │  Content Script (对应tab)     │                │
│  │  - 找到输入框填文字            │                │
│  │  - 点击发送按钮               │                │
│  └──────────────────────────────┘                │
└─────────────────────────────────────────────────┘
```

### 关键设计决策

| 决策 | 说明 |
|------|------|
| **DOM 轮询而非事件监听** | DOM 元素复杂多变，轮询扫描更稳定，每 1.5s（抖音）/ 2s（视频号）扫描一次 |
| **抖音双通道** | DOM 扫描（主通道）+ WebSocket 拦截（ws-patch.js，辅助），确保不丢弹幕 |
| **共享 Service Worker** | 抖音和视频号共用同一套规则引擎、去重、限速逻辑 |
| **位置过滤** | 通过 `getBoundingClientRect()` 只扫描右侧评论区域的文本 |
| **Content Script 路由** | 根据 `innerWidth/visible` 决定是否扫描，页面隐藏时跳过位置过滤（v11） |

---

## 核心模块说明

### 1. Service Worker（background/service_worker.js）

**职责**：规则匹配引擎 + 去重限速 + 数据持久化

**数据结构**：
```
chrome.storage.local:
├── profiles[]      # 主播配置（v5+ 多主播模式）
│   ├── id          # 唯一标识
│   ├── name        # 主播名称
│   ├── enabled     # 是否启用
│   └── rules[]     # 该主播的规则列表
├── settings        # 全局设置
│   ├── enabled     # 总开关
│   ├── replyDelay  # 回复延迟 {min, max} (ms)
│   ├── dedupWindow # 去重窗口 (秒)
│   ├── maxRepliesPerMinute  # 每分钟最大回复数
│   ├── atMention   # @用户名回复
│   ├── logHistory  # 是否记录历史
│   └── historyLimit # 历史记录上限
├── stats           # 统计数据 {total, matched, replied}
├── history[]       # 回复历史
└── danmakuLog[]    # 公屏留言日志
```

**匹配模式**：
- `fuzzy`（模糊）：弹幕包含关键词即触发（默认）
- `exact`（精确）：弹幕完全等于关键词

**回复模式**：
- `random`：从回复列表中随机选一条
- `sequential`：按顺序轮询

**防刷屏**：
- 去重：同一用户 + 同一规则，dedupWindow 秒内只回复一次
- 限速：每分钟最多 maxRepliesPerMinute 条（默认 10）
- 延迟：replyDelay 范围内随机延迟后发送

### 2. 抖音 Content Script（content/content.js）

- **扫描策略**：DOM 轮询 + `getBoundingClientRect()` 位置过滤（左侧区域，left < vw*0.45）
- **弹幕格式**：解析"用户名：消息内容"冒号格式
- **UI 过滤**：内置 100+ 抖音 UI 关键词黑名单，过滤系统消息、礼物通知、数据面板
- **辅助通道**：ws-patch.js 在 MAIN world 拦截 WebSocket 数据包

### 3. 视频号 Content Script（content/content_channels.js）

- **扫描策略**：DOM 轮询 + 位置过滤（右侧区域，left > vw*0.5）
- **弹幕格式**：同冒号格式解析"用户名：消息内容"
- **UI 过滤**：视频号专用黑名单（控制台、开播、选品、数据、粉丝等）
- **自回复过滤**：跳过用户名含"助手"的消息，防止自循环（v12.4）
- **iframe 支持**：搜索 Wujie 微前端 iframe + Shadow DOM
- **诊断模式**：首次调用 sendReply 时打印输入框全面诊断（v12.3）

**输入框定位**：
- 优先匹配 `placeholder="助手发言"` 的 textarea
- 发送按钮搜索逻辑：先找含"发送"文字的 DIV/SPAN 内的可点击子元素
- 发送方式：PointerEvent + click + Enter 键三重保障

### 4. 弹窗面板（popup/）

- 统计面板：实时显示弹幕数、匹配数、回复数
- 规则列表：快速查看/切换规则开关
- 历史记录：最近回复的弹幕和回复内容
- 平台标签：自动识别当前 tab 是抖音还是视频号

### 5. 选项页（options/）

- 多主播管理：创建/编辑/启用/禁用主播配置
- 规则编辑：添加/修改/删除规则，支持 JSON 导入导出
- 历史记录：查看所有回复历史，搜索过滤，CSV 导出
- 全局设置：延迟、限速、去重窗口等

---

## 调试指南

### 页面控制台（F12）

- 抖音日志前缀：`[🎯抖音]`
- 视频号日志前缀：`[📺视频号]`
- 内置 `diagnoseDOM()` 函数可在控制台手动调用查看 DOM 状态

### Service Worker 控制台

1. 打开 `chrome://extensions/`
2. 找到「直播自动回复助手」，点击「Service Worker」旁边的蓝色链接"检查视图"
3. 日志前缀：`[AutoReply SW]`

### 常见问题

**Q：右下角没有出现「自动回复开启」提示？**

A：页面可能还在加载，等待几秒刷新。确认是否在正确的直播间/助手页面。

**Q：能检测到评论但没回复？**

A：检查 Service Worker 控制台看是否匹配规则。如果 `reason: "no_match"`，说明评论不含关键词。

**Q：回复了但没发出去？**

A：检查 Service Worker 控制台看是否有 `发送失败` 日志。可能是输入框选择器变化。

**Q：一直在重复发送？**

A：v12.4 已修复自回复循环。如果仍有问题，确认已刷新扩展。

---

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v1-v4 | 2026-06-05 | 抖音弹幕监听、规则匹配、基本回复 |
| v5 | 2026-06-06 | 多主播管理模式（profiles） |
| v6 | 2026-06-06 | 规则管理页面完善 |
| v7-v8 | 2026-06-06 | 掩码用户名过滤、系统消息过滤 |
| v9 | 2026-06-07 | ~（PiP 保活已移除） |
| v10 | 2026-06-09 | 独立用户名检测（standalone username） |
| v11 | 2026-06-15 | 页面隐藏时跳过位置过滤 |
| v12.0 | 2026-06-17 | 视频号直播助手支持（多平台） |
| v12.1 | 2026-06-18 | 视频号 DOM 诊断模式 |
| v12.2 | 2026-06-18 | 视频号扫描重写（基于抖音方案） |
| v12.3 | 2026-06-18 | 发送按钮修复（PointerEvent + Enter）+ 全面诊断 |
| v12.4 | 2026-06-18 | 自回复循环修复（/助手/ 过滤） |

### 备份目录

```
douyin-auto-reply-backup-v5.0/
douyin-auto-reply-backup-v6.0/
douyin-auto-reply-backup-v7.0/
douyin-auto-reply-backup-v8.0/
douyin-auto-reply-backup-v9.0/
douyin-auto-reply-backup-v10.0/
douyin-auto-reply-backup-v11.0/
douyin-auto-reply-backup-v12.0/
douyin-auto-reply-backup-v12.3/
```

---

## 技术栈

- **Manifest V3** Chrome 扩展规范
- **Service Worker** 后台逻辑（无持久后台页）
- **Content Script** 页面注入
- **chrome.storage.local** 本地数据持久化
- **MutationObserver** / **setTimeout 轮询** DOM 变化监听
- **纯原生 JavaScript**，零外部依赖

---

## 免责声明

本工具仅供个人直播效率提升使用。请合理设置回复频率，遵守平台规则，避免过度使用影响用户体验。
