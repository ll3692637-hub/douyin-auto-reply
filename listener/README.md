# LiveRoomListener（本机监听服务）

这是扩展的本机配套服务：只接收本机浏览器传来的弹幕与直播页音频，并调用腾讯云 ASR 做转写。它只监听 `127.0.0.1`，不会对局域网开放。

## 启动

在此目录执行：

```bash
npm start
```

密钥只放在：

```text
~/Library/Application Support/LiveRoomListener/asr-secrets.json
```

不要把密钥复制到本项目、聊天记录或 GitHub。

## 自检

```bash
npm test
```

测试会使用临时目录和模拟转写，不读取密钥、不请求腾讯云、不会产生费用。

## 数据位置

每次监听的弹幕与转写结果保存在：

```text
~/Library/Application Support/LiveRoomListener/sessions/
```

停止监听后，本服务不保存原始音频，只保留弹幕和转写文本。
