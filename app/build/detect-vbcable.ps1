param([switch]$ExitCodeOnly)

$ErrorActionPreference = 'Stop'
try {
    # Configuration values under SOFTWARE\VB-Audio\Cable are not proof that
    # the driver is installed. Query Windows' actual audio device registrations.
    $devices = @(Get-CimInstance Win32_SoundDevice -Filter "Name = 'VB-Audio Virtual Cable'" -OperationTimeoutSec 8)
    $working = @($devices | Where-Object { $_.ConfigManagerErrorCode -eq 0 })
    $restart = @($devices | Where-Object { $_.ConfigManagerErrorCode -eq 14 })
    $result = @{
        installed = $working.Count -gt 0
        registered = $devices.Count -gt 0
        restartRequired = ($working.Count -eq 0 -and $restart.Count -gt 0)
        path = $null
    }
    if ($ExitCodeOnly) {
        if ($result.installed) { exit 0 }
        exit 1
    }
    $result | ConvertTo-Json -Compress
} catch {
    if ($ExitCodeOnly) { exit 2 }
    @{ installed = $false; path = $null; error = "Unable to check VB-CABLE: $($_.Exception.Message)" } | ConvertTo-Json -Compress
}
