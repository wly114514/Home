param(
    [int]$Port = 8000,
    [string]$BindAddress = "127.0.0.1",
    [switch]$LocalDev
)
$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
Set-Location -LiteralPath $ProjectDir
$NodeCommand = Get-Command node -ErrorAction Stop
$NodeVersion = (& $NodeCommand.Source -p "Number(process.versions.node.split('.')[0])").Trim()
if ([int]$NodeVersion -lt 24) { throw "请安装 Node.js 24 LTS，然后重新运行。" }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir ".env"))) { throw "缺少 .env，请复制 .env.example 并填写真实配置。" }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "端口 $Port 已被占用，请先停止原服务或使用 -Port 指定其他端口。" }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir "node_modules\sharp")) -or -not (Test-Path -LiteralPath (Join-Path $ProjectDir "node_modules\bcryptjs"))) {
    $NpmCommand = Get-Command npm.cmd -ErrorAction Stop
    if (Test-Path -LiteralPath (Join-Path $ProjectDir "package-lock.json")) { & $NpmCommand.Source ci --omit=dev } else { & $NpmCommand.Source install --omit=dev }
    if ($LASTEXITCODE -ne 0) { throw "Node.js 依赖安装失败，请检查上方错误。" }
}
$PreviousEnvironment = @{}
foreach ($Name in @("PORT", "HOST", "LOCAL_DEV", "ALLOW_MOCK_PAYMENT")) { $PreviousEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process") }
try {
    $env:PORT = "$Port"
    $env:HOST = $BindAddress
    $env:LOCAL_DEV = if ($LocalDev) { "1" } else { "0" }
    $env:ALLOW_MOCK_PAYMENT = "false"
    Write-Host "Node.js 服务：http://127.0.0.1:$Port/web/index.html" -ForegroundColor Green
    Write-Host "按 Ctrl+C 停止。日志直接显示在当前终端。"
    & $NodeCommand.Source (Join-Path $ProjectDir "backend-node\server.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Node.js 服务退出，错误代码：$LASTEXITCODE" }
} finally {
    foreach ($Name in $PreviousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($Name, $PreviousEnvironment[$Name], "Process") }
}
