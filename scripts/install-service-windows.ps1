<#
.SYNOPSIS
Installs CopilotDiscordBot as a Windows Service (auto-start).

.DESCRIPTION
- Runs npm ci + npm run build to compile the TypeScript source
- Copies the output into an install directory
- Sets machine-level environment variables for configuration
- Creates a Windows service that runs: node dist/index.js

Run from an elevated PowerShell.
#>

[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$ServiceName = "CopilotDiscordBot",
  [string]$DisplayName = "Copilot Discord Bot",
  [string]$InstallDir = "C:\ProgramData\CopilotDiscordBot",
  [string]$Port = "5000",
  [string]$Host = "127.0.0.1",

  [string]$ReposRoot,
  [string]$DiscordBotToken,
  [UInt64]$OwnerDiscordUserId = 0,

  [string]$CopilotCliPath,

  # Optional: token-based auth for Copilot CLI (recommended for services)
  [string]$GhToken
)

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script must be run as Administrator."
  }
}

function Prompt-IfMissing([string]$value, [string]$prompt, [switch]$Secret) {
  if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  if ($Secret) {
    $ss = Read-Host $prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
  return (Read-Host $prompt)
}

Assert-Admin

$repoRoot = Prompt-IfMissing $ReposRoot "ReposRoot (absolute path, e.g. E:\Git)"
$token = Prompt-IfMissing $DiscordBotToken "Discord bot token" -Secret

if ([string]::IsNullOrWhiteSpace($repoRoot)) { throw "ReposRoot is required." }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".."))
$appDir = Join-Path $InstallDir "app"
$dataDir = Join-Path $InstallDir "data"

New-Item -ItemType Directory -Force -Path $appDir | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Write-Host "Installing dependencies and building ..."
Push-Location $projectRoot
& npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
& npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed ($LASTEXITCODE)" }
Pop-Location

Write-Host "Copying build output to $appDir ..."
Copy-Item -Recurse -Force (Join-Path $projectRoot "dist") $appDir
Copy-Item -Force (Join-Path $projectRoot "package.json") $appDir
Copy-Item -Force (Join-Path $projectRoot "package-lock.json") $appDir -ErrorAction SilentlyContinue

Push-Location $appDir
& npm ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw "npm ci (production) failed ($LASTEXITCODE)" }
Pop-Location

$entry = Join-Path $appDir "dist\index.js"
if (-not (Test-Path $entry)) { throw "Build output missing: $entry" }

Write-Host "Setting machine environment variables ..."
[Environment]::SetEnvironmentVariable("DISCORD_BOT_TOKEN", $token, "Machine")
[Environment]::SetEnvironmentVariable("REPOS_ROOT", $repoRoot, "Machine")
[Environment]::SetEnvironmentVariable("DATA_DIR", $dataDir, "Machine")
[Environment]::SetEnvironmentVariable("PORT", $Port, "Machine")
[Environment]::SetEnvironmentVariable("HOST", $Host, "Machine")
if ($OwnerDiscordUserId -ne 0) {
  [Environment]::SetEnvironmentVariable("OWNER_DISCORD_USER_ID", $OwnerDiscordUserId.ToString(), "Machine")
}
if (-not [string]::IsNullOrWhiteSpace($CopilotCliPath)) {
  [Environment]::SetEnvironmentVariable("COPILOT_CLI_PATH", $CopilotCliPath, "Machine")
}
if (-not [string]::IsNullOrWhiteSpace($GhToken)) {
  [Environment]::SetEnvironmentVariable("GH_TOKEN", $GhToken, "Machine")
}

$nodePath = (Get-Command node).Source
$binPath = "`"$nodePath`" `"$entry`""

Write-Host "Creating service '$ServiceName' ..."
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Service exists; stopping and deleting ..."
  try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
  & sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 1
}

& sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "`"$DisplayName`"" | Out-Host
& sc.exe description $ServiceName "GitHub Copilot SDK + Discord bot (TypeScript)" | Out-Null

# Auto-restart on failure
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
& sc.exe failureflag $ServiceName 1 | Out-Null

Write-Host "Starting service ..."
& sc.exe start $ServiceName | Out-Host

Write-Host "Done. Health: http://$($Host):$($Port)/health"
Write-Host "Tip: if Copilot CLI is not authenticated for services, set GH_TOKEN (machine env var) and restart the service."
