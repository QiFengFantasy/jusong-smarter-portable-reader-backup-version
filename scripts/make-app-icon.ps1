# 生成「沮诵」品牌图标（跨端，方案 E）

# 参考图为 scripts/app-icon-source.png；先生成 1024 源图与 Android 自适应前景/背景，
# 再调用 Tauri CLI 生成 Windows/macOS/Android/iOS 全量图标。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-app-icon.ps1
#
# 依赖：Python 3（Pillow + numpy）、pnpm、@tauri-apps/cli。

[CmdletBinding()]
param(
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

Write-Host '== 1/3 从参考图生成 1024 源图与 Android 自适应素材 =='
& $Python scripts\build-icons.py
if ($LASTEXITCODE -ne 0) { throw 'build-icons.py 执行失败' }

Write-Host '== 2/3 Tauri 生成各端图标 =='
& pnpm tauri icon scripts\app-icon.manifest.json
if ($LASTEXITCODE -ne 0) { throw 'pnpm tauri icon 执行失败' }

Write-Host '== 3/3 同步浏览器图标 =='
Copy-Item src-tauri\icons\icon.ico public\favicon.ico -Force
Copy-Item src-tauri\icons\128x128@2x.png public\app-icon.png -Force
Write-Host '图标已更新：src-tauri/icons、gen/android res、public/'
