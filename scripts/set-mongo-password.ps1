# Puts a new MongoDB Atlas password into server/.env and copies the full
# MONGO_URI to the clipboard, ready to paste into Render (ustauz-api -> Environment).
#
#   powershell -ExecutionPolicy Bypass -File scripts\set-mongo-password.ps1
#
# The password is typed hidden and is never printed. Change it in Atlas first
# (Database Access -> EDIT -> Edit Password -> Update User), then run this.

$ErrorActionPreference = 'Stop'
$envFile = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
$lines = Get-Content $envFile
$index = [Array]::FindIndex([string[]]$lines, [Predicate[string]] { param($l) $l -match '^MONGO_URI=' })
if ($index -lt 0) { throw "No MONGO_URI line in $envFile" }

$uri = $lines[$index].Substring('MONGO_URI='.Length).Trim().Trim('"')
if ($uri -notmatch '^(mongodb(?:\+srv)?://)([^:@/]+):([^@]*)@(.+)$') {
  throw 'MONGO_URI is not in the form mongodb://user:password@host/...'
}
$scheme, $user, $rest = $Matches[1], $Matches[2], $Matches[4]

$secure = Read-Host "New password for $user" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $plain) { throw 'No password entered; nothing changed.' }

# Characters such as @ : / ? # % must be percent-encoded inside a URI.
$newUri = "$scheme${user}:$([Uri]::EscapeDataString($plain))@$rest"

Copy-Item $envFile "$envFile.bak" -Force
$lines[$index] = "MONGO_URI=$newUri"
# UTF-8 without a byte-order mark: Windows PowerShell's -Encoding utf8 adds one,
# and it would end up glued to the first variable's name.
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
Set-Clipboard -Value $newUri

Write-Host 'server/.env updated (old copy kept as .env.bak).'
Write-Host 'The full MONGO_URI is on the clipboard: paste it into Render -> ustauz-api -> Environment -> MONGO_URI.'
