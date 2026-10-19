# 贡献指南（Contributing）

感谢愿意给 `dsh-hub-status` 出力。这个插件很小（两个 `lib` 文件 + 一个测试），**改动面窄但纪律硬**。

## 动手前必读：三条硬约束

### 1. 改完必跑两条命令，**一条都不能省**

```powershell
cd <本仓库>
npm run check          # 三个 node --check + JSON.parse（语法与清单合法性）
npm run test:live      # 真连本机 Hub 的活体测试
```

| 命令 | 判据 |
|---|---|
| `npm run check` | **EXIT = 0** |
| `npm run test:live` | **EXIT = 0** 且输出含 `PASS  HUB_OK=true · PEERS=7 >= 5 · 5 个家族全部可见` |

`test:live` 需要 **Hub 在跑**（`Get-NetTCPConnection -LocalPort 18764` 查 PID）。Hub 没启动时测试会失败并打印原因 —— **那是预期的，别把它当"我的改动挂了"**，先把 Hub 拉起来再跑。

> ⛔ **「看代码觉得对」不算通过** —— 必须看到上面两条 EXIT 0。

### 2. `files` 白名单别漏件

`package.json` 的 `files` 决定了 `npm pack` 时**哪些文件真的进包**。漏一件，装的人就缺东西：

```
lib / test / cordis.patch.yml / install.ps1 / enable.ps1 /
README.md / CHANGELOG.md / LICENSE / locale/*.json / icon.svg
```

**新增文件时先问：它需要进包吗？** 要进就往 `files` 里加；不要进（比如 `.github/`、开发用的临时脚本）就别加。
`locale\*.json` 和 `icon.svg` 尤其别漏 —— 漏了管理器就读不到中文名和图标。

同理，`exports` 里的 `"./locale/*.json"` 与 `"./icon"` **别删**（管理器靠它们取资源）。

### 3. `cordis.patch.yml` **故意不带任何 config 键**

⛔ **别「顺手」给它加 `config`。**

原因（踩过的）：导出普通对象 `Config`（而非 Standard Schema）会让宿主在 profile 启动时报
`reading 'validate'` 崩掉。文件里已写明这条注释，**保留它**。

同理，插件**不暴露配置项**：Hub 端口写死在 `lib/index.js` 顶部，换端口 = 改那一行 + 发新版。

## 目录里各文件是干什么的

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半边：三步 MCP 只读握手 + 同源路由 |
| `lib/client.js` | 浏览器半边：右侧栏页签 + 面板 |
| `cordis.patch.yml` | bundle 装配补丁（无 config 键，见上） |
| `locale\{zh,en}.json` | 插件名本地化（「Hub 状态」/ 「Hub Status」） |
| `icon.svg` | 原创图标 64×64 |
| `install.ps1` | 一键安装（清旧 junction → `dsh plugin add file:` → 补 bundles） |
| `enable.ps1` | 只补 `dsh.profile.bundles`，幂等 |
| `test/hub-fetch.test.mjs` | 活体测试 |

## 提交规范

- 一个提交一个主题；commit message 用祈使句
- 改了行为就同步 `CHANGELOG.md`（Keep a Changelog 体例）与 `README.md` 的「已知边界」节
- 版本号口径：`package.json` 是唯一权威；`CHANGELOG.md` / `README.md` 里的版本是副本，**改了 `package.json` 就要全查**

## 环境坑（Windows）

- `install.ps1` / `enable.ps1` 必须是 **UTF-8 with BOM** —— Windows PowerShell 5.1 按 GBK 读无 BOM 的中文字面量会乱码。
  如果你用会吃 BOM 的工具改过它们，跑之前先核前 3 字节是不是 `239,187,191`。
- 开发期 `node_modules\dsh-hub-status` 是一条 **Junction** 指向本目录 ⇒ 改源码即时到位，但**宿主要重启才重新加载组合**。
