# Daily database backup, run by Windows Task Scheduler (task "Ustamiz DB backup").
#
# Takes a backup with `npm run db:backup`, keeps the newest 14 and appends the
# outcome to backups/backup.log. Register it once with:
#
#   powershell -ExecutionPolicy Bypass -File scripts/register-backup-task.ps1
#
# The log never contains the connection string: db-backup prints the host only.

$ErrorActionPreference = 'Continue'
$server = Split-Path -Parent $PSScriptRoot
$backups = Join-Path $server 'backups'
$log = Join-Path $backups 'backup.log'
New-Item -ItemType Directory -Force $backups | Out-Null

# Keep the log small: past ~1 MB, keep only its last 2 000 lines.
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) {
  $tail = Get-Content $log -Tail 2000
  Set-Content -Path $log -Value $tail -Encoding utf8
}

Set-Location $server
Add-Content -Path $log -Value "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -Encoding utf8
# cmd does the redirection, so Node's warnings on stderr are logged rather than
# being turned into PowerShell errors.
cmd /c "npm run -s db:backup -- --keep 14 >> `"$log`" 2>&1"
$code = $LASTEXITCODE
Add-Content -Path $log -Value "exit code $code" -Encoding utf8
exit $code
