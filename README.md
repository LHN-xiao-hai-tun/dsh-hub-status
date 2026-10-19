# dsh-hub-status

DSH 插件包（bundle）：在 Web GUI 的**右侧栏**加一个只读的「**Hub 状态**」页签，显示本机  
agent-comm-hub 的 peer 清单与队列概况。

- 版本：`0.1.3`
- 仓库：<https://github.com/LHN-xiao-hai-tun/dsh-hub-status>（Release 见 [releases](https://github.com/LHN-xiao-hai-tun/dsh-hub-status/releases)）
- 形态：一个 bundle，**两半** —— 宿主半边（`lib/index.js`）+ 浏览器半边（`lib/client.js`）
- 依赖：**零运行时依赖**（只用宿主自带的 `fetch` 与宿主注入的 `webServer` / `react`）
- 性质：**只读观测**。本插件不发送消息、不建组、不派任务、不改任何 Hub 状态。

---

## 1. 取数原理（为什么必须由宿主半边去取）

Hub 的 MCP 端点是 `http://127.0.0.1:18764/mcp`（无鉴权，仅回环）。它的 MCP 会话依赖  
**响应头 `mcp-session-id`**，而该头**不对跨源调用者暴露** ⇒ 浏览器 `fetch` 永远拿不到会话 id，  
无法完成握手。

因此分工是：

| 半边                    | 职责                                                                |
| --------------------- | ----------------------------------------------------------------- |
| 宿主半边 `lib/index.js`   | 在 Node 里对 Hub 做**只读三步握手**，并把结果挂到**同源**路由 `/dsh-hub-status/status` |
| 浏览器半边 `lib/client.js` | 只请求该**同源**路由渲染面板；**绝不**直接联系 Hub                                   |

宿主半边对 Hub 的调用序列（严格只读）：

1. `POST /mcp` → `initialize` → `200`，从响应头读 `mcp-session-id`
2. `POST /mcp` → `notifications/initialized` → `202`
3. `POST /mcp` → `tools/call`，**工具名只有 `bridge_status`** → `200`，取 `result.content[0].text`（JSON）

`DELETE /mcp`（会关闭会话）**从不调用**。

失败策略：任何失败（Hub 未启动、超时、结构异常）都以 **HTTP 200 + `{ "ok": false, "error": … }`**  
返回，这样面板会把故障**显示出来**，而不是伪装成「空列表」。

宿主半边对结果做 **5 秒缓存**；面板每 **45 秒**刷新一次，并可点「重试」立即强刷（`?refresh=1`）。

## 2. 面板显示什么

- 顶部：Hub 可达状态、在线 peer 数、家族在线数（`n/5`）、队列合计、队列上限、Hub 版本与历史上限
- **agent 家族**（固定顺序，缺失显示 `missing`）：  
  `codex-mcp-client`、`claude-code`、`qoderclicn`、`antigravity-client`、`dsh-mcp-client`
- **家族别名**：GUI-only 的家族重装或重新注册后 peer id 会变（Qoder 早先是
  `qoder-desktop-mcp-host`，现在是 `qoderclicn`）。每个家族带一组别名，谁在 Hub 名册里
  就用谁，面板仍显示上面那个规范 id，行不会跳位；真用的是别名时，行尾额外标 `（别名）`。
  两代 id 同时在册时只占一行，多出来的那代落进「其他 peer」—— 陈旧注册必须看得见。
- `hub-admin`（Hub 自身管理 peer）
- 「其他 peer」（不在上述名单里的 peer）
- 「本插件自身」（本插件注册的观测者 peer，**不计入家族**）
- 每行：状态点（online / offline / missing）、peer id、`队列 n`、`挂起 n`、最后活动时间

> `挂起 n` 来自 Hub `bridge_status` 的**只读挂起计数**字段；宿主半边把它规范化成面板契约名 `pending`  
> 后再交给客户端半边，因此浏览器半边的源码里不会出现任何写侧工具名的字样（便于用朴素子串检索直接证明只读）。

## 3. 安装

安装会改动 DSH profile，**须先取得用户明确同意**（本插件建件时并未安装）。

### 3.1 一条命令（从 GitHub 仓库装）

⚠️ 安装会改动 DSH profile（写 `dsh.profile.bundles`），**须先取得用户明确同意**。

```powershell
dsh plugin --profile desktop add github:LHN-xiao-hai-tun/dsh-hub-status
powershell -ExecutionPolicy Bypass -File .\enable.ps1 -Profile desktop
```

**两步都要跑。** 第二步不是可选的：DSH 插件管理器只写 `dependencies`，**不写
`dsh.profile.bundles`**，不补的话插件卡片在但功能 404（宿主行为，非插件 bug）。
`enable.ps1` 是幂等的 —— 已经在 bundles 里就不写盘、不设备份。

> `enable.ps1` 要从**仓库目录**里跑（它用 `$PSScriptRoot` 定位），在哪个目录执行都行。

### 3.1b 从 Release 的 `.tgz` 装（推荐 · 避开 pnpm 的 `ERR_PNPM_GIT_RESOLVE_FAILED`）

```powershell
# 1) 下载 https://github.com/LHN-xiao-hai-tun/dsh-hub-status/releases/latest 里的 .tgz
# 2) 解压，然后：
dsh plugin --profile desktop add file:<解压目录的绝对路径>
powershell -ExecutionPolicy Bypass -File <解压目录>\enable.ps1 -Profile desktop
```

| 参数 | 用途 |
|---|---|
| `-Profile <name>` | 装到哪个 profile，默认 `desktop` |
| `-Link` | 用 `link:` 装，源目录改动即时生效（适合边改边调）；代价见 §6 第 6 条 |
| `-EnableOnly` | 只补 `dsh.profile.bundles`，不装包（包已装好但页签不出现时用） |

### 3.2 分两步（想自己控制时）

```
plugin_manager(action="install_bundle", target="github:LHN-xiao-hai-tun/dsh-hub-status")
powershell -ExecutionPolicy Bypass -File .\enable.ps1 -Profile desktop
```

`enable.ps1` 只做第二步：把插件名补进 `dsh.profile.bundles`。它是幂等的 —— 已经在
bundles 里就不写盘、不设备份。

### 3.3 装完

- **需要重启宿主**（bundle 的宿主半边与客户端半边都在启动时装配）才生效。
- 生效后：右侧栏的引导页出现「Hub 状态」入口；宿主侧路由 `GET /dsh-hub-status/status` 可用。
- 自检：`node --check lib/index.js` · `node --check lib/client.js` · `node test/hub-fetch.test.mjs`
  （最后一条会真连本机 Hub，Hub 未启动时失败属预期）。

## 4. 卸载与回滚

```
plugin_manager(action="remove_bundle", target="dsh-hub-status")
```

回滚 = 卸载 bundle + 重启宿主。若只想临时停用，可用  
`plugin_manager(action="set_bundle", target="dsh-hub-status", enabled=false)`。

本插件**不写入** profile 之外的任何位置；卸载后磁盘上只留下装它的那个目录
（GitHub 装法下是 `node_modules\dsh-hub-status`，`file:` 装法下是你指定的目录），
可整目录删除。

## 5. 只读保证

- 宿主半边对 Hub 的**唯一**业务调用 = `tools/call` → `bridge_status`。
- 浏览器半边的**唯一**网络调用 = 同源 `GET /dsh-hub-status/status`。
- 宿主路由只接受 `GET` / `HEAD`，其余方法返回 `405`。
- 本插件不订阅、不发送、不确认、不派发任何消息；不建组；不改 peer 状态。

## 6. 已知边界

1. **Hub 未启动**：面板显示错误态与原因（宿主路由返回 `ok:false`），不崩、不重试风暴。
2. **本插件自身**：安装后 Hub 会多出一个本插件的观测 peer；面板把它单列，不计入家族。
3. **需重启宿主生效**：热装 bundle 不会立刻出现页签。
4. **仅回环**：只连 `127.0.0.1`，不做任何外网访问。
5. **多会话**：宿主半边每次取数会向 Hub 建立一次 MCP 会话（5 秒缓存把频率压到很低）。
6. **`link:` 装的代价**：`node_modules\dsh-hub-status` 会是指向源码目录的 junction。
   改动即时生效（不用重装），但插件管理器「升级/重装」这个包时 pnpm 会报
   `ERR_PNPM_EPERM: rename … -> node_modules\dsh-hub-status`（界面显示为「没有写入权限」）。
   处置：先 `cmd /c rmdir "C:\Users\QQ306\.dsh\profiles\desktop\node_modules\dsh-hub-status"` 再重装。
   `install.ps1` 每次运行都会先检测并清掉这个 junction。
7. **端口写死**：Hub 端点常量在 `lib/index.js` 顶部 `HUB_MCP_URL = 'http://127.0.0.1:18764/mcp'`。
   Hub 换端口时要改这一行（本插件没有暴露配置项 —— 见 `cordis.patch.yml` 里为什么不加 Config）。

## 7. 文件清单

```
dsh-hub-status/
├── package.json           # manifest：main = 宿主半边；dsh.bundle.patch；dsh.client（web）
├── cordis.patch.yml       # bundle 装配补丁（insert id/name；故意不带 config 键）
├── install.ps1            # 本地一键安装：清 junction + 装包 + 补 bundles（UTF-8 BOM · 5,387 B）
├── enable.ps1             # 只补 dsh.profile.bundles（幂等 · UTF-8 BOM · 3,613 B）
├── icon.svg               # 插件图标（原创 · 64×64 · 面板与商店卡片用）
├── locale/
│   ├── en.json            # 显示元数据（英文）：meta.title + meta.description
│   └── zh.json            # 显示元数据（中文）
├── README.md              # 本文件
├── CHANGELOG.md           # 变更日志（Keep a Changelog 体例）
├── LICENSE                # MIT
├── SECURITY.md            # 安全政策（只读面 / 报告漏洞渠道）
├── CONTRIBUTING.md        # 贡献指南（改完必跑 check + test:live）
├── .gitignore
├── lib/
│   ├── index.js           # 宿主半边：只读握手 + 同源路由
│   └── client.js          # 浏览器半边：右侧栏页签与面板
└── test/
    └── hub-fetch.test.mjs # 活体测试：真跑 Hub，断言 PEERS≥5 且 5 个家族全部可见
```

`locale/*.json` 与 `icon.svg` 是**显示元数据**：插件管理器与设置页读它们的
`meta.title` / `meta.description` 和图标，**不需要先激活插件**。这条要求来自
官方 `cordis-plugin-development` 技能的 `references/host-plugin.md`
「Display metadata and icon」小节；没有这两样，插件在管理器里只显示包名和一行
英文 `description`，中文界面也读不到中文名。

## 8. 自检

```
node --check lib/index.js
node --check lib/client.js
node test/hub-fetch.test.mjs
```

`test/hub-fetch.test.mjs` 会真连本机 Hub；Hub 未启动时它会失败并打印原因（这是预期行为）。

## 9. 变更记录

### 2026-10-11 · `lib/client.js` 补 `guide` 入口（面板可见性）

- **现象**：宿主半边早已实证可用（`GET /dsh-hub-status/status` = HTTP 200），但右侧栏里**看不到**这个页签。
- **根因**：本插件原先只做了「两段注册」的前半（`sidebarRightTabs.register` 的类型 + `sidebar.right.pane.tab` 的正文），  
  **没有**在类型注册里给 `guide` 条目。右侧栏的「引导页」是**按各已注册类型贡献的 `guide` 条目**画入口胶囊的  
  （点击胶囊才 `openTab(entry.kind, …)`）⇒ 类型注册了却没有入口可以点，页签只能靠程序化 `openTab` 出现。
- **出处**：`@deepseek-ai/dsh-client-ui-sidebar-right`（宿主包，位于 `app.asar` 内）README 的  
  「Tab 类型注册表」与「引导页」两节 —— 签名 `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })`，  
  原文「`guide` 列出引导页的入口框；选中一个即把贡献它的类型作为页打开」。  
  同机旁证 = `dsh-plugin-wallpaper-engine` 的 `lib/client.js`（同一公开路径，且注册了 `guide: [{…}]`）。
- **修法**：给 `register` 加 `keepMounted: true` 与  
  `guide: [{ id: 'hub', order: 120, title: () => 'Hub 状态', description: () => 'agent-comm-hub 在线状态与队列' }]`。
- **指纹**：改前 `lib/client.js` = 9,086 B / `7CCFB83096214C7D9DD996C20D61F6D6` ⇒ 改后 9,471 B / `56BE6C8C75869E905D19D09E3876B77E`  
  （无 BOM · 纯 LF · `node --check` 通过）；前像 = `备份\前像_Hub面板guide入口_20261011\client_pre_guide.js`（md5 与改前逐字符一致）。
- **生效方式**：浏览器半边随界面加载 ⇒ 刷新窗口（或重启 DSH）后，右侧栏的引导页里会出现「Hub 状态」入口。
