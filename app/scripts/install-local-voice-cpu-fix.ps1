#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../server/meanvc-realtime.py'))
$installed = Join-Path $env:ProgramFiles 'Morphly Desktop/resources/morphlyvc/meanvc-realtime.py'
if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing source bridge: $source" }
if (!(Test-Path -LiteralPath $installed -PathType Leaf)) { throw "Morphly bridge was not found: $installed" }

$backupDirectory = Join-Path $env:LOCALAPPDATA 'Morphly Desktop/voice-cpu-backups'
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
$backup = Join-Path $backupDirectory ('meanvc-realtime-' + [guid]::NewGuid().ToString('N') + '.py.bak')
Copy-Item -LiteralPath $installed -Destination $backup
if ((Get-FileHash -LiteralPath $installed).Hash -ne (Get-FileHash -LiteralPath $backup).Hash) {
    throw 'Backup verification failed. The installed bridge has not been changed.'
}

try {
    Copy-Item -LiteralPath $source -Destination $installed -Force
    if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $installed).Hash) {
        throw 'Installed bridge verification failed.'
    }
} catch {
    Copy-Item -LiteralPath $backup -Destination $installed -Force
    throw
}
Write-Host "CPU voice fix installed and verified. Backup: $backup"
Write-Host 'Fully quit Morphly (including its tray icon), then reopen it to load the fix.'
