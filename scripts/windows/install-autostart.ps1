# Starts Nuvio Web (backend and app) when you sign in to Windows, hidden and without admin rights.
# Remove it again with: .\scripts\windows\install-autostart.ps1 -Remove
param([switch]$Remove)

$taskName = "Nuvio Web"
if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'selfhost\.mjs|web-serve\.mjs|server\\scripts\\dev\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Output "Removed the '$taskName' sign-in task and stopped Nuvio Web."
  return
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$node = (Get-Command node -ErrorAction Stop).Source
$launcher = Join-Path $PSScriptRoot "start-hidden.vbs"

# wscript runs the launcher without a console window.
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$launcher`" `"$node`" `"$(Join-Path $root 'scripts\selfhost.mjs')`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Runs the Nuvio Web backend and app for this user." -Force | Out-Null
Write-Output "Installed the '$taskName' sign-in task."
