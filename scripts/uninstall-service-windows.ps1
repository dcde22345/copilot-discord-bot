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
  [Environment]::SetEnvironmentVariable("Bot__DiscordBotToken", $null, "Machine")
  [Environment]::SetEnvironmentVariable("Bot__ReposRoot", $null, "Machine")
  [Environment]::SetEnvironmentVariable("Bot__DataDir", $null, "Machine")
  [Environment]::SetEnvironmentVariable("Bot__OwnerDiscordUserId", $null, "Machine")
  [Environment]::SetEnvironmentVariable("Bot__CopilotCliPath", $null, "Machine")
}

if ($RemoveFiles -and (Test-Path $InstallDir)) {
  Write-Host "Removing files: $InstallDir"
  Remove-Item -Recurse -Force -LiteralPath $InstallDir
}

Write-Host "Done."
