# dsh-hub-status 一键安装脚本
#
# 把 dsh-hub-status 装进 DSH profile，并补齐 dsh.profile.bundles，
# 让宿主半在重启后真正加载。装完请重启 DSH Desktop。
#
# 本插件是纯本地包（无 registry 发布），所以安装来源只有一个：本目录。
# 脚本自己算绝对路径，不依赖你在哪个目录执行。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Link
#      用 link: 装（源目录改动即时生效，适合边改边调；代价是升级时
#      pnpm 可能报 ERR_PNPM_EPERM，届时先 rmdir 掉链接再重装）
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -EnableOnly
#      只补 dsh.profile.bundles，不装包（包已经装好时用）
#
# 说明：本文件是 UTF-8 带 BOM 保存的。不带 BOM 时 Windows PowerShell 5.1
# 会按 GBK 读中文字面量，输出全是乱码。

param(
  [string]$Profile = 'desktop',
  [switch]$Link,
  [switch]$EnableOnly
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-hub-status'
$sourceDir = $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$pkgPath = Join-Path $profileDir 'package.json'

if (-not (Test-Path (Join-Path $sourceDir 'package.json'))) {
  throw "本脚本必须放在插件目录里执行；当前目录没有 package.json：$sourceDir"
}

function Find-DshCli {
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  # 桌面端默认装法：装到用户目录或 Program Files。别在这里写死某个开发机的路径 ——
  # 别人拿到这个脚本时那条路径一定不存在。
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

function Ensure-ObjectProperty($object, $name) {
  $property = $object.PSObject.Properties[$name]
  if ($null -eq $property) {
    $object | Add-Member -NotePropertyName $name -NotePropertyValue ([pscustomobject]@{}) -Force
  } elseif ($null -eq $property.Value) {
    $object.$name = [pscustomobject]@{}
  }
  return $object.$name
}

function Enable-Bundle($pluginName, $pkgPath) {
  $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $dsh = Ensure-ObjectProperty $pkg 'dsh'
  $profileConfig = Ensure-ObjectProperty $dsh 'profile'
  if ($null -eq $profileConfig.PSObject.Properties['bundles']) {
    $profileConfig | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
  }
  $bundles = @($profileConfig.bundles)
  if ($bundles -contains $pluginName) {
    Write-Host "[$pluginName] 已经在 dsh.profile.bundles 里。" -ForegroundColor Yellow
    return
  }
  $profileConfig.bundles = @($bundles + $pluginName)
  $backup = "$pkgPath.bak-$pluginName"
  Copy-Item $pkgPath $backup -Force
  $json = $pkg | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText($pkgPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[$pluginName] 已加入 dsh.profile.bundles（第 $($bundles.Count + 1) 项）。" -ForegroundColor Green
  Write-Host "原文件备份：$backup"
}

if (-not (Test-Path $pkgPath)) {
  Write-Host "[$pluginName] profile '$Profile' 还没初始化，交给 dsh CLI 创建。" -ForegroundColor Yellow
}

if ($EnableOnly) {
  if (-not (Test-Path $pkgPath)) { throw "profile 未初始化，无处写 bundles：$pkgPath" }
  Enable-Bundle $pluginName $pkgPath
  Write-Host ''
  Write-Host "[$pluginName] 完成。请重启 DSH。" -ForegroundColor Green
  exit 0
}

# 1) 移除旧的 junction（link: 安装残留），只删链接，不动源码目录
$linkTarget = Join-Path $profileDir "node_modules\$pluginName"
if (Test-Path $linkTarget) {
  $item = Get-Item $linkTarget -Force
  if ($item.LinkType -eq 'Junction') {
    Write-Host "[$pluginName] 检测到旧的 junction 链接，正在移除（源码目录不受影响）…" -ForegroundColor Yellow
    cmd /c rmdir "$linkTarget"
  }
}

# 2) 找 dsh CLI
$dshCli = Find-DshCli
if (-not $dshCli) {
  Write-Host "[$pluginName] 没有找到 dsh CLI。" -ForegroundColor Red
  Write-Host "改用手动方式：在 DSH 的「插件管理器 → 添加插件」里输入" -ForegroundColor Yellow
  Write-Host "  $sourceDir" -ForegroundColor Yellow
  Write-Host "装完之后运行同目录下的 enable.ps1，再重启 DSH。" -ForegroundColor Yellow
  exit 1
}

# 3) 安装
$spec = if ($Link) { "link:$sourceDir" } else { "file:$sourceDir" }
Write-Host "[$pluginName] 正在安装（$spec）…"
& $dshCli plugin --profile $Profile add $spec
if ($LASTEXITCODE -ne 0) {
  throw "[$pluginName] 安装失败（退出码 $LASTEXITCODE）。`n如果看到 ERR_PNPM_EPERM，先删掉 node_modules\$pluginName 链接再重试。"
}

# 4) 补 dsh.profile.bundles
Enable-Bundle $pluginName $pkgPath

Write-Host ''
Write-Host "[$pluginName] 安装完成。请重启 DSH Desktop 让插件生效。" -ForegroundColor Green
Write-Host "生效后：右侧栏引导页出现「Hub 状态」页签；宿主路由 GET /dsh-hub-status/status 可用。"
Write-Host "自检：node --check lib\index.js ; node --check lib\client.js ; node test\hub-fetch.test.mjs"
