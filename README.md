# dsh-hub-status

DSH 插件包（bundle）：在 Web GUI 的**右侧栏**加两个页签 ——「**Hub 状态**」与「**聊天室**」。

- 版本：`0.2.1`
- 仓库：<https://github.com/LHN-xiao-hai-tun/dsh-hub-status>（Release 见 [releases](https://github.com/LHN-xiao-hai-tun/dsh-hub-status/releases)）
- 形态：一个 bundle，**两半** —— 宿主半边（`lib/index.js`）+ 浏览器半边（`lib/client.js`）
- 依赖：**零运行时依赖**（只用宿主自带的 `fetch` 与宿主注入的 `webServer` / `react`）
- 两个页签：
  1. **Hub 状态** —— `agent-comm-hub` 是否可达、每个 agent 家族的在线 / 队列 / 挂起。
     **只读观测**：不发送消息、不建组、不派任务、不改任何 Hub 状态。
  2. **聊天室** —— 一条多台设备共用的**只追加** JSONL 日志：看最近 30 条，也能直接说一句。
     （这个页签**有写操作**，写只有一条：追加一行。没有编辑、没有删除、没有撤回。）
- 另外注册了一个**全屏聊天室**视图（`conversation.view`），内容与右侧栏那个页签同一套面板。

---

## 1. 取数原理（为什么必须由宿主半边去取）

Hub 的 MCP 端点是 `http://127.0.0.1:18764/mcp`（无鉴权，仅回环）。它的 MCP 会话依赖  
**响应头 `Mcp-Session-Id`**，而该头**不对跨源调用者暴露** ⇒ 浏览器 `fetch` 永远拿不到会话 id，  
无法完成握手。

因此分工是：

| 半边                    | 职责                                                                |
| --------------------- | ----------------------------------------------------------------- |
| 宿主半边 `lib/index.js`   | 在 Node 里对 Hub 做**只读三步握手**，并把结果挂到**同源**路由 `/dsh-hub-status/status` |
| 浏览器半边 `lib/client.js` | 只请求**同源**路由渲染面板；**绝不**直接联系 Hub                                   |

宿主半边对 Hub 的调用序列（严格只读）：

1. `POST /mcp` → `initialize` → `200`，从响应头读 `Mcp-Session-Id`
2. `POST /mcp` → `notifications/initialized` → `202`
3. `POST /mcp` → `tools/call`，**工具名只有 `bridge_status`** → `200`，取 `result.content[0].text`（JSON）

`DELETE /mcp`（会关闭会话）**从不调用**。

失败策略：任何失败（Hub 未启动、超时、结构异常）都以 **HTTP 200 + `{ "ok": false, "error": … }`**  
返回，这样面板会把故障**显示出来**，而不是伪装成「空列表」。

宿主半边对结果做 **5 秒缓存**；面板每 **45 秒**刷新一次，并可点「重试」立即强刷（`?refresh=1`）。

### 1.1 三条同源路由

| 路由 | 方法 | 干什么 |
|---|---|---|
| `/dsh-hub-status/status` | `GET` / `HEAD` | 读 Hub 状态（只读 `tools/call bridge_status`） |
| `/dsh-hub-status/chat` | `GET` / `HEAD` / `POST` | `GET` 读聊天室日志尾部（`?limit=n`，默认 30，上限 200）；`POST` 追加一条 |
| `/dsh-hub-status/config` | `GET` / `HEAD` | 把解析好的说话人 / 配色 / 署名交给浏览器半 |

## 2. 面板显示什么

### 2.1 Hub 状态页签

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

### 2.2 聊天室页签

- 顶部：总条数、最新 `#seq`、刷新按钮
- 消息按**气泡**展示：自己发的靠右（`selfNames` 里那些人），别人的靠左；每人一套配色
- 每条气泡头：说话人、时间（当天只显示 `HH:MM`）、`#seq`；行里带 `via` 时补「· 经 xxx」
- **坏行提示**：日志里若有解析不了的行，面板显式提示「⚠️ 跳过 N 行坏行（行号 …）」，
  不静默吞掉 —— 只追加的日志被外部工具写坏时，这个提示就是唯一线索
- 输入框：`Ctrl+Enter` 发送、`Enter` 换行；**点发送立刻清空输入框**（失败会把内容放回去，不丢字），
  因为人判断「发出去没有」靠的是输入框空没空，不是按钮转没转
- 页脚常驻「只追加 · 发出去不能撤」

聊天室日志的行格式（与既有的 python 写入器一致，⛔ 别加字段）：

```json
{"seq": 12, "from": "me", "at": "2026-01-01 09:30:00", "text": "一行正文"}
```

## 3. 安装

安装会改动 DSH profile（写 `dsh.profile.bundles`），**须先取得用户明确同意**。

### 3.1 从 GitHub 仓库装

```powershell
dsh plugin --profile desktop add github:LHN-xiao-hai-tun/dsh-hub-status
powershell -ExecutionPolicy Bypass -File .\enable.ps1 -Profile desktop
```

**两步都要跑。** 第二步不是可选的：DSH 插件管理器只写 `dependencies`，**不写
`dsh.profile.bundles`**，不补的话插件卡片在但功能 404（宿主行为，非插件 bug）。
`enable.ps1` 是幂等的 —— 已经在 bundles 里就不写盘、不设备份。

> `enable.ps1` 用 `$PSScriptRoot` 定位，要从**仓库目录**里跑。

### 3.2 从 Release 的 `.tgz` 装（推荐 · 避开 pnpm 的 `ERR_PNPM_GIT_RESOLVE_FAILED`）

```powershell
# 1) 下载 https://github.com/LHN-xiao-hai-tun/dsh-hub-status/releases 里 v0.2.1 那个 .tgz
#    （releases 里暂时只有 v0.1.3 的包时，用上面 3.1 的 GitHub 装法，别装旧包）
# 2) 解压，然后：
dsh plugin --profile desktop add file:<解压目录的绝对路径>
powershell -ExecutionPolicy Bypass -File <解压目录>\enable.ps1 -Profile desktop
```

### 3.3 本地目录一条命令

在**本目录**里跑：

```
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

它做四件事：移除旧的 junction 残留 → 调 `dsh plugin --profile desktop add file:<本目录>`
→ 把 `dsh-hub-status` 补进 `dsh.profile.bundles`（写前备份 `package.json`）→ 提示重启。
路径由 `$PSScriptRoot` 自己算，在哪个目录执行都行。

| 参数 | 用途 |
|---|---|
| `-Profile <name>` | 装到哪个 profile，默认 `desktop` |
| `-Link` | 用 `link:` 装，源目录改动即时生效（适合边改边调）；代价见 §7 第 6 条 |
| `-EnableOnly` | 只补 `dsh.profile.bundles`，不装包（包已装好但页签不出现时用） |

### 3.4 装完

- **需要重启宿主**（bundle 的宿主半边与客户端半边都在启动时装配）才生效。
- 生效后：右侧栏引导页出现「Hub 状态」与「聊天室」两个入口；
  宿主侧三条路由（见 §1.1）可用。
- 自检：`npm run check` · `npm run test:config` · `npm run test:live`
  （`test:live` 会真连本机 Hub，Hub 未启动时失败属预期）。

## 4. 配置

三项都可选，**都不填时用中性默认值** —— 别人装完直接能用，不会读到你机器上的任何私人路径或名字。

| 配置键 | 环境变量 | 默认值 | 作用 |
|---|---|---|---|
| `chatHubFile` | `DSH_HUB_CHAT_FILE` | `<DSH_HOME>/hub.jsonl`（`DSH_HOME` 缺失时 `<用户主目录>/.dsh/hub.jsonl`） | 聊天室日志的**绝对路径** |
| `speakers` | — | `[{"name":"me"},{"name":"peer"}]` | 聊天室里的说话人；**顺序决定默认配色** |
| `selfNames` | — | `["me"]`（不填时取 `speakers` 的第一个名字） | 谁的消息**靠右**显示；发消息时署**第一个**名字 |

### 4.1 聊天室路径：优先级从高到低

1. 插件配置 `chatHubFile`
2. 环境变量 `DSH_HUB_CHAT_FILE`
3. `<DSH_HOME>/hub.jsonl`，`DSH_HOME` 不存在时 `<用户主目录>/.dsh/hub.jsonl`

**路径不存在不会崩**：面板显示

```
没找到聊天室文件：<解析出来的绝对路径>（可用环境变量 DSH_HUB_CHAT_FILE 或插件配置 chatHubFile 指定）
```

（`ok:false` + 一句人话，和 Hub 不可达时同一个策略：故障看得见，而不是一个空的成功。）

### 4.2 说话人与署名

```jsonc
{
  "speakers": [
    { "name": "me",   "color": "#60a5fa" },   // color 可省：省了按位置取内置调色板
    { "name": "peer", "label": "对方" }       // label 可省：气泡头上显示「label（name）」
  ],
  "selfNames": ["me"]
}
```

- `name` 必须与日志里的 `from` **逐字相等**才配上色。
  设备 id（`pc` / `phone` / `tablet` 之类）想单独上色，就把它也写进 `speakers`。
- `color` 只认 `#rrggbb`；认不出／不填时按**它在数组里的位置**取调色板（6 色循环）。
- `selfNames` 里的人在面板上靠右，发消息时用**第一个**署名（免去每次手填）。
- 传配置的两种方式写在 `cordis.patch.yml` 顶部注释里（环境变量 / 装配层的 `config:`）。

> ⛔ **不要给插件加 `export const Config`**。导出普通对象（而非 Standard Schema）会让宿主在
> profile 启动时报 `reading 'validate'` 并起不来 —— 这是实测过的启动崩溃。本插件因此**不做
> schema 校验**，只做容错读取：给了就用，没给就用默认值。

## 5. 卸载与回滚

```
plugin_manager(action="remove_bundle", target="dsh-hub-status")
```

回滚 = 卸载 bundle + 重启宿主。若只想临时停用，可用  
`plugin_manager(action="set_bundle", target="dsh-hub-status", enabled=false)`。

本插件**不写入** profile 之外的任何位置（唯一的写是聊天室日志那一条追加）。
卸载后磁盘上只留下装它的那个目录（GitHub 装法下是 `node_modules\dsh-hub-status`，
`file:` 装法下是你指定的目录），可整目录删除。

## 6. 只读保证（针对 Hub 那一半）

- 宿主半边对 Hub 的**唯一**业务调用 = `tools/call` → `bridge_status`。
- Hub 状态页在浏览器里的**唯一**网络调用 = 同源 `GET /dsh-hub-status/status`。
- 宿主路由只接受 `GET` / `HEAD`（`chat` 另有 `POST`，只追加本地日志，**不碰 Hub**）。
- 本插件不订阅、不发送、不确认、不派发任何 Hub 消息；不建组；不改 peer 状态。

## 7. 已知边界

1. **Hub 未启动**：面板显示错误态与原因（宿主路由返回 `ok:false`），不崩、不重试风暴。
2. **本插件自身**：安装后 Hub 会多出一个本插件的观测 peer；面板把它单列，不计入家族。
3. **需重启宿主生效**：热装 bundle 不会立刻出现页签。
4. **仅回环**：只连 `127.0.0.1`，不做任何外网访问。
5. **多会话**：宿主半边每次取数会向 Hub 建立一次 MCP 会话（5 秒缓存把频率压到很低）。
6. **`link:` 装的代价**：`node_modules\dsh-hub-status` 会是指向源码目录的 junction。
   改动即时生效（不用重装），但插件管理器「升级/重装」这个包时 pnpm 会报
   `ERR_PNPM_EPERM: rename … -> node_modules\dsh-hub-status`（界面显示为「没有写入权限」）。
   处置：先 `cmd /c rmdir "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-hub-status"` 再重装。
   `install.ps1` 每次运行都会先检测并清掉这个 junction。
7. **Hub 端口仍写死**：端点常量在 `lib/index.js` 顶部 `HUB_MCP_URL = 'http://127.0.0.1:18764/mcp'`，
   Hub 换端口要改这一行（聊天室路径与说话人已可配置，Hub 端点还没做成配置项）。
8. **并发写入可能撞号**：两台同时发言时 `seq` 可能相同。撞号不丢消息（单行原子追加），
   读侧按行序展示、不按 `seq` 排序，所以不影响可读性；本插件不引入跨设备锁。

## 8. 文件清单

```
dsh-hub-status/
├── package.json           # manifest：main = 宿主半边；dsh.bundle.patch；dsh.client（web）
├── cordis.patch.yml       # bundle 装配补丁（insert id/name；配置怎么给写在这里）
├── install.ps1            # 一键安装：清 junction + 装包 + 补 bundles（UTF-8 BOM）
├── enable.ps1             # 只补 dsh.profile.bundles（幂等 · UTF-8 BOM）
├── icon.svg               # 插件图标（原创 · 64×64 · 面板与商店卡片用）
├── locale/
│   ├── en.json            # 显示元数据（英文）：meta.title + meta.description
│   └── zh.json            # 显示元数据（中文）
├── README.md              # 本文件
├── CHANGELOG.md           # 变更日志（Keep a Changelog 体例）
├── LICENSE                # MIT
├── SECURITY.md            # 安全政策（只读面 / 报告漏洞渠道）
├── CONTRIBUTING.md        # 贡献指南（改完必跑 check + test:config + test:live）
├── lib/
│   ├── index.js           # 宿主半边：只读握手 + 三条同源路由 + 配置解析
│   └── client.js          # 浏览器半边：两个右侧栏页签 + 全屏聊天室视图
└── test/
    ├── config.test.mjs    # 配置解析 / 聊天室尾部读取 / 缺文件人话 / 配置路由（不连网）
    └── hub-fetch.test.mjs # 活体测试：真跑 Hub，断言 PEERS≥5 且 5 个家族全部可见
```

`locale/*.json` 与 `icon.svg` 是**显示元数据**：插件管理器与设置页读它们的
`meta.title` / `meta.description` 和图标，**不需要先激活插件**。这条要求来自
官方 `cordis-plugin-development` 技能的 `references/host-plugin.md`
「Display metadata and icon」小节；没有这两样，插件在管理器里只显示包名和一行
英文 `description`，中文界面也读不到中文名。

## 9. 自检

```
npm run check          # node --check lib/index.js + lib/client.js + JSON 清单
npm run test:config    # 配置与路由的离线测试（不连网、不碰真日志）
npm run test:live      # 活体测试：真连本机 Hub
```

`test:live` 会真连本机 Hub；Hub 未启动时它会失败并打印原因（这是预期行为）。
`test:config` 只在一个临时目录里造假日志，跑完删掉。

## 10. 变更记录

### 2026-10-11 · `lib/client.js` 补 `guide` 入口（面板可见性）

- **现象**：宿主半边早已实证可用（`GET /dsh-hub-status/status` = HTTP 200），但右侧栏里**看不到**这个页签。
- **根因**：本插件原先只做了「两段注册」的前半（`sidebarRightTabs.register` 的类型 + `sidebar.right.pane.tab` 的正文），  
  **没有**在类型注册里给 `guide` 条目。右侧栏的「引导页」是**按各已注册类型贡献的 `guide` 条目**画入口胶囊的  
  （点击胶囊才 `openTab(entry.kind, …)`）⇒ 类型注册了却没有入口可以点，页签只能靠程序化 `openTab` 出现。
- **出处**：`@deepseek-ai/dsh-client-ui-sidebar-right`（宿主包，位于 `app.asar` 内）README 的  
  「Tab 类型注册表」与「引导页」两节 —— 签名 `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })`，  
  原文「`guide` 列出引导页的入口框；选中一个即把贡献它的类型作为页打开」。  
- **修法**：给 `register` 加 `keepMounted: true` 与  
  `guide: [{ id: 'hub', order: 120, title: () => 'Hub 状态', description: () => 'agent-comm-hub 在线状态与队列' }]`。
- **生效方式**：浏览器半边随界面加载 ⇒ 刷新窗口（或重启 DSH）后，右侧栏的引导页里会出现「Hub 状态」入口。

完整历史见 [`CHANGELOG.md`](./CHANGELOG.md)。