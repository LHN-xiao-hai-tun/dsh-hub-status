# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] — 2026-11-07

首个**可以直接给别人用**的版本：不再依赖维护者本机上的任何路径或人名。

### Changed

- **聊天室日志路径不再硬编码**。解析顺序（高 → 低）：
  `config.chatHubFile` → 环境变量 `DSH_HUB_CHAT_FILE` → `<DSH_HOME>/hub.jsonl`
  （`DSH_HOME` 缺失时 `<用户主目录>/.dsh/hub.jsonl`）。
  新增 `resolveChatHubFile(config, env)` / `resolvePluginConfig(config, env)`，
  `env` 可注入，测试不碰真环境。
- **说话人 / 配色 / 署名改为配置**：`config.speakers`（`[{ name, color?, label? }]`，顺序决定
  默认配色）与 `config.selfNames`（靠右显示、发消息署名，取第一个）。
  默认值是中性的 `me` / `peer` 与 `["me"]` —— 仓库里不再有任何真名。
- **新增同源路由 `GET /dsh-hub-status/config`**：宿主把解析好的说话人 / 署名交给浏览器半边。
  为什么必须过宿主：浏览器半是另一份打包产物，读不到插件配置；两边必须用同一份，
  否则配色与署名会各说各话。
- `lib/client.js` 的 `CHAT_COLORS` 常量表 → `CHAT_PALETTE` 调色板 + 配置驱动的
  `chatColorsFrom(speakers)`；`chatColorOf(name, config)` / `chatIsSelf(name, config)`
  改为接收配置（React 状态，拉到配置后换对象触发重渲染）。发消息的 `from` 由
  `chatSelfNames(config)[0]` 决定，不再是一个写死的字符串。
- 宿主半边：`readChatTail(hubFile, limit)` 与 `appendChatMessage(text, from, { hubFile, selfNames })`
  带上了路径 / 署名参数；`createChatHandler({ hubFile, selfNames })`。

### Added

- `test/config.test.mjs` + `npm run test:config`：路径解析优先级、说话人与署名的默认值 /
  去重 / 非法项、聊天室尾部读取与坏行、缺文件时的人话、配置路由只读。**不连网、不碰真日志**
  （临时目录造假日志，跑完删掉）。
- `cordis.patch.yml` 顶部写明「配置怎么给」，并保留「为什么不要导出 `Config`」的原因。

### Fixed

- **聊天室文件不存在时不再冒原始 `ENOENT`**：现在回 `ok:false` + 一句人话
  「没找到聊天室文件：<路径>（可用环境变量 DSH_HUB_CHAT_FILE 或插件配置 chatHubFile 指定）」。
- `install.ps1` 的 CLI 探测列表去掉了维护者本机的一个绝对路径（别人机器上必然不存在）。
- `LICENSE` / `icon.svg` / 各文件注释里的维护者署名与个人原话全部移除或改写成中性表述
  （公开发布前做的一次彻底脱敏：本仓库历史上 `LICENSE` 与图标注释里带着真名）。

## [0.2.0] — 2026-11-06（补记）

这一版当时没有记 CHANGELOG，发 0.2.1 时一并补上。

### Added

- **第二个右侧栏页签「聊天室」**，与「Hub 状态」并列（独立的 tab 类型 —— 一个类型只能认领
  一个 body，挂两个 guide 条目会让第二个永远派发不到）。
- **全屏聊天室视图**：注册到 `conversation.view`（切过去占满会话区，两侧栏仍在），
  而不是 `shell.overlay`（会盖住两侧栏且不占布局）。
- 气泡式消息：自己的靠右、别人的靠左、每人一套配色；`via` 字段显示「· 经 xxx」。
- **坏行提示**：日志里有解析不了的行时显式提示条数与行号。
- 发送：`Ctrl+Enter` 发送 / `Enter` 换行；**点发送立刻清空输入框**，失败把内容放回去（不丢字）。
- 聊天室日志按 `{"seq","from","at","text"}` 单行 JSON 追加，`seq` 取「读到最大 + 1」。

## [0.1.3] — 2026-10-19

### Added

- **显示元数据（`locale/en.json` + `locale/zh.json` + `icon.svg`）**。插件管理器与设置页
  会在**不激活插件**的前提下读 `meta.title` / `meta.description` 与图标；此前本插件三样
  全无，管理器里只显示包名和英文 `description`，中文界面读不到中文名，也没有图标。
  依据 = 官方 `cordis-plugin-development` 技能 `references/host-plugin.md`
  「Display metadata and icon」小节（本地该技能旧版没有这一段，第 89 段已同步官方新版）。
- `package.json`：`exports` 增 `"./locale/*.json"` 与 `"./icon"`；`files` 增
  `locale/*.json` 与 `icon.svg`（否则打包会漏发，管理器读不到）。

## [0.1.2] — 2026-10-19

### Fixed

- **家族 peer id 漂移导致面板假 `missing`**：面板曾把四个家族 id 写死为
  `codex-mcp-client` / `claude-code` / `qoder-desktop-mcp-host` / `dsh-mcp-client`。
  Qoder CN 重新注册后 peer id 变成 `qoderclicn`，于是面板上 `qoder-desktop-mcp-host`
  永远显示 `missing`，而真正的 `qoderclicn` 被丢进「其他 peer」——**在线状态被报成了缺席**。
  现在每个家族带一组别名（`FAMILIES[].aliases`），谁在 Hub 名册里就用谁；面板仍显示
  规范 id，真用的是别名时行尾标 `（别名）`，`peerId` 字段带着真 id 供人工排查。
  两代 id 同时在册时只占一行，多出来的那代落进「其他 peer」，不会被静默吞掉。

### Added

- `antigravity-client` 补进家族名单（第 5 家）。它一直是 Hub 的 live peer，此前只能
  从「其他 peer」里看到，顶部「家族在线」计数不含它。
- 「家族在线 `n/5`」由 `FAMILY_IDS.length` 现算，不再写死 `/4`。
- 活体测试 `test/hub-fetch.test.mjs` 遍历 `FAMILIES` 断言每个家族都可见，失败时打印
  「该家族的全部别名都不在名册」，id 漂移会直接让测试变红而不是悄悄灰一行。

## [0.1.1] — 2026-10-19

### Added

- `package.json` 补 `engines.dsh`（`>=0.2.0-rc.1`）、`peerDependencies`
  （`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-client-ui-sidebar-right`，两者 `optional: true`）
  与 `scripts.check` / `scripts.test:live`。对齐同机参考件 `dsh-power-menu` 的 manifest 形态。
- `files` 白名单补 `install.ps1` / `enable.ps1` / `CHANGELOG.md` / `LICENSE`（原来只列 `lib` / `test` /
  `cordis.patch.yml` / `README.md`，打 tgz 时会把脚本与许可证漏掉）。
- `README.md` §3 安装节改成三条路（`install.ps1` 一条命令 / 分两步 / 装完自检）；
  §6 已知边界补第 6 条（`link:` 装的 `ERR_PNPM_EPERM` 代价）与第 7 条（Hub 端点端口写死在
  `lib/index.js` 顶部 `HUB_MCP_URL`，没有配置项）；§7 文件清单补四个新件。

- `install.ps1` — 一条命令完成安装：调用 DSH CLI 装包、把 `dsh-hub-status` 补进
  `dsh.profile.bundles`、提示重启。写 `package.json` 前先备份。
- `enable.ps1` — 只补 bundles 那一步的独立脚本。插件已经从别的途径装好（例如
  `link:` 或本地 tgz）但右侧栏没出现页签时用它，不必重装。
- `LICENSE` — MIT 正文。`package.json` 里早写了 `"license": "MIT"`，但仓库里一直没有正文。
- 本 CHANGELOG。此前变更只散落在 README §9，现在集中到这里，README 只留最近一条。

### Fixed

- `install.ps1` / `enable.ps1` 落盘为 **UTF-8 带 BOM**：不带 BOM 时 Windows
  PowerShell 5.1 会按 GBK 读中文 console 文案，输出变乱码。

## [0.1.0] — 2026-10-11

### Added

- 首发。宿主半边 `lib/index.js` 注册同源只读路由 `GET /dsh-hub-status/status`，
  走三步 MCP 握手（`initialize` → `notifications/initialized` → `tools/call bridge_status`）
  取本机 agent-comm-hub 的状态；浏览器半边 `lib/client.js` 在右侧栏注册「Hub 状态」页签。
  对 Hub 的唯一业务调用是只读的 `bridge_status`；浏览器半边唯一的网络调用是同源 GET。
- 失败一律以 **HTTP 200 + `{ ok: false, error }`** 返回，故障在面板上可见，
  而不是伪装成「空列表」。
- 宿主半边对结果做 5 秒缓存，面板 45 秒刷新一次，可 `?refresh=1` 强刷。
- `test/hub-fetch.test.mjs` 活体测试：真连本机 Hub，断言 peers ≥ 5 且四家 agent 家族全部可见。

### Fixed

- 页签注册补 `guide` 条目 —— **现象**：宿主路由早已 HTTP 200，右侧栏却看不到页签。
  **根因**：右侧栏的「引导页」是按各已注册类型贡献的 `guide` 条目画入口胶囊的，
  类型注册了但没有 `guide` 就等于没有入口可以点。修法 = `register` 加
  `keepMounted: true` 与 `guide: [{ id, order, title, description }]`。
  **出处**：`@deepseek-ai/dsh-client-ui-sidebar-right` README 的「Tab 类型注册表」与
  「引导页」两节；同机旁证 = `dsh-plugin-wallpaper-engine` 的 `lib/client.js` 同样写了 `guide`。
- 指纹：改前 `lib/client.js` = 9,086 B / `7CCFB83096214C7D9DD996C20D61F6D6`
  ⇒ 改后 9,471 B / `56BE6C8C75869E905D19D09E3876B77E`（无 BOM · 纯 LF · `node --check` 通过）。
  前像留在 `备份\前像_Hub面板guide入口_20261011\client_pre_guide.js`。
