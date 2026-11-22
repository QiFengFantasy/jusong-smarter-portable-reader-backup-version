<#
  沮诵 · 一键启动 Tauri 桌面开发窗口（Windows PowerShell 5.1+）

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch-dev.ps1
    或双击桌面快捷方式「沮诵（一键启动）」

  行为：
    - 没有 node_modules 时先自动 pnpm install；
    - 运行 `pnpm tauri dev`：启动 Vite devUrl + Tauri 窗口；
    - 关闭 Tauri 窗口/控制台窗口即停止。

  参数：
    -NoPause  失败时不等待回车（脚本/自动化测试用）

  说明：浏览器调试仍可手动 `pnpm dev`，但浏览器存储路径已冻结，不作为产品形态。
#>
[CmdletBinding()]
param(
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Stop-WithMessage {
    param([string]$Message, [string]$Color = 'Red')

    Write-Host ''
    Write-Host "  $Message" -ForegroundColor $Color
    Write-Host ''
    if (-not $NoPause -and $Host.Name -eq 'ConsoleHost') {
        [void](Read-Host '按回车关闭窗口')
    }
    exit 1
}

try {
    $Host.UI.RawUI.WindowTitle = '沮诵 · Tauri 开发窗口（关闭即停止）'
} catch {
    # 非控制台宿主（job/CI）里设置标题会失败，忽略。
}

Set-Location -LiteralPath $root

$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) { $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source }
if (-not $pnpm) {
    Stop-WithMessage '没有找到 pnpm：请先安装 Node.js 与 pnpm（npm i -g pnpm）。'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-WithMessage '没有找到 Node.js：请先安装 Node.js 20+。'
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
    if (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe')) {
        $env:PATH = "$cargoBin;$env:PATH"
    } else {
        Stop-WithMessage '没有找到 Rust（cargo）：请先安装 Rust stable（https://rustup.rs）。'
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\.pnpm'))) {
    Write-Host '  首次运行：正在安装依赖（pnpm install）…' -ForegroundColor Yellow
    $env:CI = 'true'
    & $pnpm install
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage "依赖安装失败（pnpm install 退出码 $LASTEXITCODE），请查看上方输出。"
    }
}

Write-Host ''
Write-Host '  沮诵 · Tauri 开发' -ForegroundColor Red
Write-Host '  窗口关闭即停止；首次启动会编译 Rust（约 1–2 分钟）。'
Write-Host ''

$exitCode = 0
try {
    & $pnpm tauri dev
    $exitCode = $LASTEXITCODE
} catch {
    Write-Host ''
    Write-Host "  启动失败：$($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
}

if ($exitCode -ne 0 -and $exitCode -ne 3221225786) {  # 3221225786 = Ctrl+C 正常中断
    Stop-WithMessage "Tauri 开发窗口异常退出（退出码 $exitCode）。"
}
