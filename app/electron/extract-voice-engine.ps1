param([Parameter(Mandatory=$true)][string]$ArchivePath,[Parameter(Mandatory=$true)][string]$StagingPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function ExtendedPath([string]$value) {
    if ($value.StartsWith('\\?\')) { return $value }
    if ($value.StartsWith('\\')) { return '\\?\UNC\' + $value.Substring(2) }
    return '\\?\' + $value
}
$root = (ExtendedPath ([IO.Path]::GetFullPath($stagingPath))).TrimEnd('\') + '\'
[IO.Directory]::CreateDirectory($root) | Out-Null
$lock = $null
$archive = $null
try {
    # An extractor may outlive a closed desktop process. Wait for its lock,
    # then inspect its completed files instead of writing over it.
    while ($null -eq $lock) {
        try { $lock = [IO.File]::Open(($root + '.extract.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] {
            if (($_.Exception.HResult -band 65535) -notin @(32, 33)) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
    $archive = [IO.Compression.ZipFile]::OpenRead((ExtendedPath ([IO.Path]::GetFullPath($archivePath))))
    [long]$total = 0
    foreach ($entry in $archive.Entries) { $total += $entry.Length }
    $driveRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($stagingPath))
    if ($driveRoot -match '^[A-Za-z]:\\$') {
        [long]$remaining = 0
        foreach ($entry in $archive.Entries) {
            $relative = $entry.FullName.Replace('/', '\')
            if ($relative.TrimEnd('\') -eq 'runtime-40ms' -and $entry.Length -eq 0) { continue }
            if (!$relative.StartsWith('runtime-40ms\', [StringComparison]::OrdinalIgnoreCase) -or
                $relative.Contains(':') -or $relative.Split('\') -contains '..' -or $relative.Split('\') -contains '.') {
                throw 'The voice engine archive contains an unsafe path.'
            }
            if (!$relative.EndsWith('\')) {
                $existing = $root + $relative
                if (![IO.File]::Exists($existing) -or ([IO.FileInfo]$existing).Length -ne $entry.Length) { $remaining += $entry.Length }
            }
        }
        [long]$available = ([IO.DriveInfo]::new($driveRoot)).AvailableFreeSpace
        if ([IO.File]::Exists(($root + '.entry.tmp'))) { $available += ([IO.FileInfo]($root + '.entry.tmp')).Length }
        if ($remaining + 64MB -gt $available) {
            [Console]::Error.WriteLine(('VOICE_SETUP_SPACE ' + [Math]::Ceiling(($remaining + 64MB) / 1GB)))
            throw 'Not enough free disk space to unpack the voice engine.'
        }
    }
    [long]$completed = 0
    $lastPercent = -1
    $buffer = New-Object byte[] 1048576
    foreach ($entry in $archive.Entries) {
        $relative = $entry.FullName.Replace('/', '\')
        if ($relative.TrimEnd('\') -eq 'runtime-40ms' -and $entry.Length -eq 0) {
            [IO.Directory]::CreateDirectory(($root + 'runtime-40ms\')) | Out-Null
            continue
        }
        if (!$relative.StartsWith('runtime-40ms\', [StringComparison]::OrdinalIgnoreCase) -or
            $relative.Contains(':') -or $relative.Split('\') -contains '..' -or $relative.Split('\') -contains '.') {
            throw 'The voice engine archive contains an unsafe path.'
        }
        # Extended paths avoid Windows' legacy 260-character limit. Validate
        # relative components before joining; never normalize away traversal.
        $destination = $root + $relative
        if ($relative.EndsWith('\')) {
            [IO.Directory]::CreateDirectory($destination) | Out-Null
            continue
        }
        # Only finished files get their final name. A killed extraction leaves
        # one temporary file, which is overwritten on the next attempt.
        if (![IO.File]::Exists($destination) -or ([IO.FileInfo]$destination).Length -ne $entry.Length) {
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
            $source = $entry.Open()
            $output = $null
            try {
                $output = [IO.File]::Open(($root + '.entry.tmp'), 'Create', 'Write', 'None')
                [long]$copied = 0
                while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $output.Write($buffer, 0, $count)
                    $copied += $count
                    $percent = [Math]::Floor(($completed + $copied) * 100.0 / [Math]::Max(1, $total))
                    if ($percent -ne $lastPercent) {
                        $lastPercent = $percent
                        [Console]::WriteLine(('EXTRACT ' + $percent))
                    }
                }
                if ($output.Length -ne $entry.Length) { throw 'Incomplete voice engine file.' }
                $output.Flush()
            } finally {
                if ($null -ne $output) { $output.Dispose() }
                $source.Dispose()
            }
            if ([IO.File]::Exists($destination)) { [IO.File]::Delete($destination) }
            [IO.File]::Move(($root + '.entry.tmp'), $destination)
        }
        $completed += $entry.Length
        $percent = if ($total -gt 0) { [Math]::Floor($completed * 100.0 / $total) } else { 100 }
        if ($percent -ne $lastPercent) {
            $lastPercent = $percent
            [Console]::WriteLine(('EXTRACT ' + $percent))
        }
    }
} finally {
    if ($null -ne $archive) { $archive.Dispose() }
    if ($null -ne $lock) { $lock.Dispose() }
}
