# dsh-hub-status 一键启用脚本
#
# 用途：DSH 插件管理器安装后只写 dependencies，不一定会把插件加进
# `dsh.profile.bundles`；少了这一条，宿主半不加载，点「重试」或刷新面板
# 都只会拿到 HTTP 404（面板显示为错误态）。
#
# 这个脚本只做一件事：把 dsh-hub-status 补进指定 profile 的 bundles。
# 写之前备份 profile 的 package.json。它不装包、不改 node_modules、不重启。
#
# 用法（在插件目录里执行）：
#   powershell -ExecutionPolicy Bypass -File .\enable.ps1
#   powershell -ExecutionPolicy Bypass -File .\enable.ps1 -Profile desktop
# 然后重启 DSH（宿主半与客户端半都在启动时装配）。
#
# 说明：本文件是 UTF-8 带 BOM 保存的。不带 BOM 时 Windows PowerShell 5.1
# 会按 GBK 读中文字面量，输出全是乱码。

param(
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-hub-status'
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$pkgPath = Join-Path $profileDir 'package.json'

if (-not (Test-Path $pkgPath)) {
  throw "找不到 DSH profile 的 package.json：$pkgPath"
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

$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$dsh = Ensure-ObjectProperty $pkg 'dsh'
$profileConfig = Ensure-ObjectProperty $dsh 'profile'

if ($null -eq $profileConfig.PSObject.Properties['bundles']) {
  $profileConfig | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
}

$bundles = @($profileConfig.bundles)
if ($bundles -notcontains $pluginName) {
  $profileConfig.bundles = @($bundles + $pluginName)
  $backup = "$pkgPath.bak-$pluginName"
  Copy-Item $pkgPath $backup -Force
  $json = $pkg | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText($pkgPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[$pluginName] 已加入 dsh.profile.bundles（第 $($bundles.Count + 1) 项）。" -ForegroundColor Green
  Write-Host "原文件备份：$backup"
  Write-Host "请重启 DSH 让宿主半加载。"
} else {
  Write-Host "[$pluginName] 已经在 dsh.profile.bundles 里。" -ForegroundColor Yellow
  Write-Host "如果面板仍报 404，依次确认："
  Write-Host "  1) dependencies 里有 $pluginName"
  Write-Host "  2) node_modules\$pluginName 存在且指向对的位置"
  Write-Host "  3) 已重启 DSH（热装 bundle 不会立刻生效）"
}

# 额外提示：node_modules 里如果还是 junction，说明装的是 link 版本。
# 以后用插件管理器「升级」时可能报 ERR_PNPM_EPERM（界面显示为「没有写入权限」）。
$linkTarget = Join-Path $profileDir "node_modules\$pluginName"
if (Test-Path $linkTarget) {
  $item = Get-Item $linkTarget -Force
  if ($item.LinkType -eq 'Junction') {
    Write-Host ''
    Write-Host "[提示] node_modules\$pluginName 目前是 junction（link 安装）。" -ForegroundColor Yellow
    Write-Host "以后从插件管理器升级这个包时可能报「没有写入权限」（pnpm 的 ERR_PNPM_EPERM）。" -ForegroundColor Yellow
    Write-Host "遇到时先删掉这个链接再重装：cmd /c rmdir `"$linkTarget`"" -ForegroundColor Yellow
  }
  Write-Host "[提示] 目标：$($item.Target)" -ForegroundColor DarkGray
}
