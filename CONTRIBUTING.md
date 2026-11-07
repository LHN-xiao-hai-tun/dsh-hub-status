# 贡献指南（Contributing）

感谢愿意给 `dsh-hub-status` 出力。这个插件很小（两个 `lib` 文件 + 两个测试），**改动面窄但纪律硬**。

## 动手前必读：三条硬约束

### 1. 改完必跑三条命令，**一条都不能省**

```powershell
cd <本仓库>
npm run check          # 两个 node --check + JSON.parse（语法与清单合法性）
npm run test:config    # 配置解析与三条路由的离线测试（不连网）
npm run test:live      # 真连本机 Hub 的活体测试
```

| 命令 | 判据 |
|---|---|
| `npm run check` | **EXIT = 0** |
| `npm run test:config` | **EXIT = 0** 且输出含 `PASS` |
| `npm run test:live` | **EXIT = 0** 且输出含 `PASS  HUB_OK=true · PEERS=<n> >= 5 · 5 个家族全部可见` |

`test:live` 需要 **Hub 在跑**（`Get-NetTCPConnection -LocalPort 18764` 查 PID）。Hub 没启动时测试会失败并打印原因 —— **那是预期的，别把它当"我的改动挂了"**，先把 Hub 拉起来再跑。
`test:config` 不需要 Hub：它只在临时目录造一个假日志，跑完删掉。

> ⛔ **「看代码觉得对」不算通过** —— 必须看到上面三条 EXIT 0。

### 2. `files` 白名单别漏件

`package.json` 的 `files` 决定了 `npm pack` 时**哪些文件真的进包**。漏一件，装的人就缺东西：

```
lib / test / cordis.patch.yml / install.ps1 / enable.ps1 /
README.md / CHANGELOG.md / LICENSE / locale/*.json / icon.svg
```

**新增文件时先问：它需要进包吗？** 要进就往 `files` 里加；不要进（比如 `.github/`、开发用的临时脚本）就别加。
`locale\*.json` 和 `icon.svg` 尤其别漏 —— 漏了管理器就读不到中文名和图标。

同理，`exports` 里的 `"./locale/*.json"` 与 `"./icon"` **别删**（管理器靠它们取资源）。

### 3. ⛔ 别给插件加 `export const Config`

原因（踩过的）：导出普通对象 `Config`（而非 Standard Schema）会让宿主在 profile 启动时报
`reading 'validate'` 崩掉。

所以本插件的配置（`chatHubFile` / `speakers` / `selfNames`，见 README §4）是**容错读取**的：
`apply(ctx, config)` 拿到什么用什么，没给就用中性默认值，不做 schema 校验。
`cordis.patch.yml` 顶部注释写了配置怎么给（环境变量 / 装配层的 `config:` 键），**保留那段注释**。

同理，Hub 端口仍写死：换端口 = 改 `lib/index.js` 顶部 `HUB_MCP_URL` + 发新版。

## 目录里各文件是干什么的

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半边：三步 MCP 只读握手 + 三条同源路由 + 配置解析 |
| `lib/client.js` | 浏览器半边：右侧栏两个页签 + 全屏聊天室视图 |
| `cordis.patch.yml` | bundle 装配补丁（无 config 键，见上） |
| `locale\{zh,en}.json` | 插件名本地化 |
| `icon.svg` | 原创图标 64×64 |
| `install.ps1` | 一键安装（清旧 junction → `dsh plugin add file:` → 补 bundles） |
| `enable.ps1` | 只补 `dsh.profile.bundles`，幂等 |
| `test/config.test.mjs` | 离线测试：配置优先级 / 说话人 / 坏行 / 缺文件 / 配置路由 |
| `test/hub-fetch.test.mjs` | 活体测试：真连 Hub |

## 提交规范

- 一个提交一个主题；commit message 用祈使句
- 改了行为就同步 `CHANGELOG.md`（Keep a Changelog 体例）与 `README.md` 的「已知边界」节
- 版本号口径：`package.json` 是唯一权威；`CHANGELOG.md` / `README.md` 里的版本是副本，**改了 `package.json` 就要全查**
- ⛔ 提交前跑一次脱敏检查：任何本机绝对路径、用户名、局域网地址、私人昵称都不该出现在这个仓库里
  （包括 `LICENSE` 的版权行、`icon.svg` 的注释、代码注释里引用的聊天原话）

## 环境坑（Windows）

- `install.ps1` / `enable.ps1` 必须是 **UTF-8 with BOM** —— Windows PowerShell 5.1 按 GBK 读无 BOM 的中文字面量会乱码。
  如果你用会吃 BOM 的工具改过它们，跑之前先核前 3 字节是不是 `239,187,191`。
- 开发期 `node_modules\dsh-hub-status` 可能是一条 **Junction** 指向本目录 ⇒ 改源码即时到位，但**宿主要重启才重新加载组合**。