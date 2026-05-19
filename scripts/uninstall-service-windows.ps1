<#
.SYNOPSIS
Uninstalls the CopilotDiscordBot Windows Service.

Run from an elevated PowerShell.
#>

[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$ServiceName = "CopilotDiscordBot",
  [string]$InstallDir = "C:\ProgramData\CopilotDiscordBot",
  [switch]$RemoveEnv,
  [switch]$RemoveFiles
)

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script must be run as Administrator."
  }
}

Assert-Admin

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "Stopping service ..."
  try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
  Write-Host "Deleting service ..."
  & sc.exe delete $ServiceName | Out-Host
} else {
  Write-Host "Service not found: $ServiceName"
}

if ($RemoveEnv) {
  Write-Host "Removing machine environment variables ..."
  [Environment]::SetEnvironmentVariable("DISCORD_BOT_TOKEN", $null, "Machine")
  [Environment]::SetEnvironmentVariable("REPOS_ROOT", $null, "Machine")
  [Environment]::SetEnvironmentVariable("DATA_DIR", $null, "Machine")
  [Environment]::SetEnvironmentVariable("OWNER_DISCORD_USER_ID", $null, "Machine")
  [Environment]::SetEnvironmentVariable("COPILOT_CLI_PATH", $null, "Machine")
  [Environment]::SetEnvironmentVariable("PORT", $null, "Machine")
  [Environment]::SetEnvironmentVariable("HOST", $null, "Machine")
}

if ($RemoveFiles -and (Test-Path $InstallDir)) {
  Write-Host "Removing files: $InstallDir"
  Remove-Item -Recurse -Force -LiteralPath $InstallDir
}

Write-Host "Done."
