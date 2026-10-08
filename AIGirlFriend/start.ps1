param(
    [int]$Port = 8000,
    [string]$BindAddress = "127.0.0.1",
    [switch]$LocalDev
)
$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "start-node.ps1") -Port $Port -BindAddress $BindAddress -LocalDev:$LocalDev
