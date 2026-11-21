# Registers (or updates) the daily backup task for the current Windows user.
#
#   powershell -ExecutionPolicy Bypass -File scripts/register-backup-task.ps1 [-At 22:00]
#
# StartWhenAvailable: if the laptop was off or asleep at that time, the backup
# runs as soon as it is back on, instead of waiting a whole day.

param([string]$At = '22:00')

$script = Join-Path $PSScriptRoot 'scheduled-backup.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'Ustamiz DB backup' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Daily MongoDB backup of Ustamiz (server/backups, newest 14 kept).' `
  -Force | Out-Null

Get-ScheduledTask -TaskName 'Ustamiz DB backup' | Select-Object TaskName, State
(Get-ScheduledTaskInfo -TaskName 'Ustamiz DB backup').NextRunTime
