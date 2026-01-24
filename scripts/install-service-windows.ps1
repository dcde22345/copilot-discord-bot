<#
.SYNOPSIS
Installs CopilotDiscordBot as a Windows Service (auto-start).

.DESCRIPTION
- Publishes the app into an install directory
- Sets machine-level environment variables for configuration
- Creates a Windows service that runs: dotnet CopilotDiscordBot.dll

Run from an elevated PowerShell.
#>

[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$ServiceName = "CopilotDiscordBot",
  [string]$DisplayName = "Copilot Discord Bot",
  [string]$InstallDir = "C:\ProgramData\CopilotDiscordBot",
  [string]$Urls = "http://127.0.0.1:5000",

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

$repoRoot = Prompt-IfMissing $ReposRoot "ReposRoot (absolute path, e.g. E:\\Git)"
$token = Prompt-IfMissing $DiscordBotToken "Discord bot token" -Secret

if ([string]::IsNullOrWhiteSpace($repoRoot)) { throw "ReposRoot is required." }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".."))
$appProject = Join-Path $projectRoot "src\CopilotDiscordBot\CopilotDiscordBot.csproj"
$appDir = Join-Path $InstallDir "app"
$dataDir = Join-Path $InstallDir "data"

New-Item -ItemType Directory -Force -Path $appDir | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Write-Host "Publishing to $appDir ..."
& dotnet publish $appProject -c Release -o $appDir | Out-Host
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }

$dll = Join-Path $appDir "CopilotDiscordBot.dll"
if (-not (Test-Path $dll)) { throw "Publish output missing: $dll" }

Write-Host "Setting machine environment variables ..."
[Environment]::SetEnvironmentVariable("Bot__DiscordBotToken", $token, "Machine")
[Environment]::SetEnvironmentVariable("Bot__ReposRoot", $repoRoot, "Machine")
[Environment]::SetEnvironmentVariable("Bot__DataDir", $dataDir, "Machine")
if ($OwnerDiscordUserId -ne 0) {
  [Environment]::SetEnvironmentVariable("Bot__OwnerDiscordUserId", $OwnerDiscordUserId.ToString(), "Machine")
}
if (-not [string]::IsNullOrWhiteSpace($CopilotCliPath)) {
  [Environment]::SetEnvironmentVariable("Bot__CopilotCliPath", $CopilotCliPath, "Machine")
}
if (-not [string]::IsNullOrWhiteSpace($GhToken)) {
  [Environment]::SetEnvironmentVariable("GH_TOKEN", $GhToken, "Machine")
}

$dotnet = (Get-Command dotnet).Source
$binPath = "\"$dotnet\" \"$dll\" --urls $Urls"

Write-Host "Creating service '$ServiceName' ..."
# Remove existing service if present
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Service exists; stopping and deleting ..."
  try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
  & sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 1
}

& sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "\"$DisplayName\"" | Out-Host
& sc.exe description $ServiceName "GitHub Copilot SDK + Discord bot (mobile-first UX)" | Out-Null

# Auto-restart on failure
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
& sc.exe failureflag $ServiceName 1 | Out-Null

Write-Host "Starting service ..."
& sc.exe start $ServiceName | Out-Host

Write-Host "Done. Health: $Urls/health"
Write-Host "Tip: if Copilot CLI isn't authenticated for services, set GH_TOKEN (machine env var) and restart the service."
