# Runs "npm run watch" in the background with Windows Task Scheduler.
#   Install:   npm run background:install     (from an Administrator PowerShell)
#   Remove:    npm run background:uninstall   (from an Administrator PowerShell)
#
# The task runs whether or not you are signed in (no console window), starts at boot,
# and is re-launched within 5 minutes if it ever stops. A second copy is never started.
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'UpworkJobAlertLite'
$ProjectDir = Split-Path -Parent $PSScriptRoot

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host 'Please run this from an Administrator PowerShell (Start menu > PowerShell > Run as administrator).' -ForegroundColor Yellow
    exit 1
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed background task '$TaskName'. Alerts stop until you install it again."
    } else {
        Write-Host "No background task '$TaskName' is installed."
    }
    exit 0
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe was not found on PATH. Install Node.js 22.18+ first.' }
if (-not (Test-Path (Join-Path $ProjectDir '.env'))) { throw "No .env in $ProjectDir. Set it up first (see README)." }
if (-not (Test-Path (Join-Path $ProjectDir 'data\discovery.json'))) { throw 'Upwork is not connected yet. Run "npm run connect" and "npm run discover" first.' }

$action = New-ScheduledTaskAction -Execute $node -Argument '--disable-warning=ExperimentalWarning src\cli.ts watch' -WorkingDirectory $ProjectDir
$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    # Watchdog: every 5 minutes; ignored while the watcher is running, restarts it if it stopped.
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
# S4U = "run whether user is logged on or not" without storing your password; it has no console window.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
    -Description 'Upwork Job Alert Lite: searches saved Upwork filters and sends Telegram alerts (npm run watch).' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started background task '$TaskName'."
Write-Host '  Dashboard: http://127.0.0.1:5174/   Log: data\app.log'
Write-Host '  Check:     Get-ScheduledTask UpworkJobAlertLite | Get-ScheduledTaskInfo'
Write-Host '  Remove:    npm run background:uninstall'
