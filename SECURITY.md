# 安全政策（Security Policy）

## 本插件的安全面（先说清楚它**不**做什么）

`dsh-hub-status` 是一个**只读**的 DSH 插件，它的全部网络行为是：

| 项 | 实际行为 |
|---|---|
| **连到哪里** | 仅 `http://127.0.0.1:18764/mcp`（**本机回环**的 agent-comm-hub MCP 端点） |
| **发什么** | 固定的三步只读 MCP 握手：`initialize` → `notifications/initialized` → `tools/call bridge_status` |
| **写什么** | **什么都不写** —— 从不调用 `DELETE /mcp`，不修改 Hub 的任何状态 |
| **上传什么** | **零上传** —— 没有遥测、没有崩溃上报、没有第三方服务调用 |
| **读什么** | 只读 Hub 的 `bridge_status` 返回（对等体 id / 连接态 / 队列深度 / 心跳时间） |
| **凭据** | 插件**不存储、不读取**任何 token 或密钥 |

刷新间隔固定 45 秒，可在 URL 上加 `?refresh=1` 手动强刷（见 `README.md`）。

## 已知边界（**不是漏洞，是设计取舍**）

- 端口 `18764` 写死在 `lib/index.js` 顶部的 `HUB_MCP_URL`。Hub 换端口需改这一行并发新版
  （原因：`cordis.patch.yml` 故意不带 config 键 —— 导出普通对象 `Config` 会让宿主在 profile 启动时报
  `reading 'validate'` 崩掉）。
- 面板数据来自 Hub 的 `bridge_status`，**其准确性取决于 Hub 自身的心跳**；插件不做额外校验。
- `test:live` 会真连本机 Hub；Hub 未启动时测试失败并打印原因（**属预期**，不是安全事件）。

## 支持范围

按**最新发布版本**提供安全修复。修复会发在下一个小版本里。

## 报告漏洞

**请勿开公开 Issue 报告安全问题。**

1. 用 GitHub 的 **私密漏洞报告**（Private Vulnerability Reporting）：在本仓库
   `Security` → `Report a vulnerability` 提交。
2. 或在能联系到维护者的渠道私信说明。

请在报告里包含：

- 复现步骤（Hub 是否在跑 · DSH 版本 · 插件版本）
- 期望行为 vs 实际行为
- 若涉及数据外泄：**具体是哪条数据、去了哪里**（本插件设计上零上传，任何外泄都是真缺陷）

维护者会在收到报告后确认，并在修复发布时致谢（除非你要求匿名）。
