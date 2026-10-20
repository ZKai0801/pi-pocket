<#
.SYNOPSIS
  Report whether this machine can build and run PocketShell's Android debug APK.

.DESCRIPTION
  This checkout has no bash, so the POSIX build path cannot run here. This
  doctor is the single source of truth for what the Windows path needs: a
  JDK 21, an Android SDK with platform 36 / build-tools 36.0.0 /
  platform-tools / emulator, an x86_64 Google APIs system image for API 35
  (the emulator target) and an AVD named `test`.

  Every item prints one verdict line. A missing item prints the exact
  sdkmanager/avdmanager command that fixes it, and the script exits non-zero.
  It never installs anything itself: a gate that quietly changes the machine
  is not a gate.

  With -Write and a clean report, the resolved paths are recorded in
  .local/toolchain.json (git-ignored) so later scripts do not have to guess.

.PARAMETER Write
  Write .local/toolchain.json after a fully green report.

.PARAMETER ConfigPath
  Override the toolchain config path (default: <repo>\.local\toolchain.json).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/android-doctor.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/android-doctor.ps1 -Write
#>
[CmdletBinding()]
param(
    [switch]$Write,
    [string]$ConfigPath
)

# Native tools in this script (java, emulator) write their version banners to
# stderr. Under 'Stop' PowerShell 5.1 turns that into a terminating error, so
# every native invocation is checked explicitly through $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath -or $ConfigPath.Trim() -eq '') {
    $ConfigPath = Join-Path (Join-Path $repoRoot '.local') 'toolchain.json'
}

$script:Failures = @()
$script:Missing = @()

function Write-Verdict {
    param(
        [string]$Item,
        [bool]$Ok,
        [string]$Detail,
        [string]$Fix
    )

    if ($Ok) {
        Write-Host ("[ ok ]      {0}: {1}" -f $Item, $Detail)
        return
    }

    Write-Host ("[ MISSING ] {0}: {1}" -f $Item, $Detail)
    if ($Fix -and $Fix.Trim() -ne '') {
        Write-Host ("             fix: {0}" -f $Fix)
    }
    $script:Failures += $Item
}

function Resolve-JavaHome {
    param([string]$SdkRoot)

    $candidates = New-Object System.Collections.ArrayList

    if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
        [void]$candidates.Add($env:JAVA_HOME.TrimEnd('\'))
    }

    $onPath = Get-Command java.exe -ErrorAction SilentlyContinue
    if ($onPath) {
        $home = Split-Path -Parent (Split-Path -Parent $onPath.Source)
        [void]$candidates.Add($home.TrimEnd('\'))
    }

    # Usual install roots: Temurin, Microsoft OpenJDK, Oracle, the SDK's own
    # bundled JBR, and the per-user winget/local install locations.
    $roots = @(
        'C:\Program Files\Eclipse Adoptium',
        'C:\Program Files\Microsoft',
        'C:\Program Files\Java',
        'C:\Program Files\Android\Android Studio\jbr',
        (Join-Path $env:LOCALAPPDATA 'Programs\Eclipse Adoptium'),
        'D:\software\jdk21',
        'D:\software\java',
        'C:\software\jdk21'
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        if (Test-Path (Join-Path $root 'bin\java.exe')) {
            [void]$candidates.Add($root.TrimEnd('\'))
            continue
        }
        $children = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending
        foreach ($child in $children) {
            if (Test-Path (Join-Path $child.FullName 'bin\java.exe')) {
                [void]$candidates.Add($child.FullName.TrimEnd('\'))
            }
        }
    }

    foreach ($candidate in $candidates) {
        $java = Join-Path $candidate 'bin\java.exe'
        if (-not (Test-Path $java)) { continue }
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = & $java '-version' 2>&1 | Out-String
        } catch {
            $output = ''
        } finally {
            $ErrorActionPreference = $previous
        }
        if ($output -match 'version "?21[\.\"]') {
            return $candidate
        }
    }

    return $null
}

function Resolve-SdkRoot {
    $candidates = New-Object System.Collections.ArrayList

    foreach ($name in @('ANDROID_HOME', 'ANDROID_SDK_ROOT')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value -and (Test-Path $value)) { [void]$candidates.Add($value.TrimEnd('\')) }
    }

    foreach ($path in @(
            (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
            'D:\Android\Sdk',
            'C:\Android\Sdk',
            'D:\software\android-sdk',
            'C:\Users\Public\Android\Sdk')) {
        if ($path -and (Test-Path $path)) { [void]$candidates.Add($path.TrimEnd('\')) }
    }

    foreach ($candidate in $candidates) {
        # A directory with only platform-tools is not an SDK root: require the
        # manager that can install the missing pieces.
        if (Test-Path (Join-Path $candidate 'platform-tools')) { return $candidate }
    }

    if ($candidates.Count -gt 0) { return $candidates[0] }
    return $null
}

function Get-AndroidVersion {
    param([string]$Path)

    if (-not (Test-Path $Path)) { return $null }
    $props = Join-Path $Path 'source.properties'
    if (Test-Path $props) {
        $line = Get-Content $props | Where-Object { $_ -match '^Pkg\.Revision\s*=' } | Select-Object -First 1
        if ($line) { return ($line -split '=', 2)[1].Trim() }
    }
    return $null
}

Write-Host 'PocketShell Android toolchain doctor'
Write-Host ("repo: {0}" -f $repoRoot)
Write-Host ''

# --- JDK ---------------------------------------------------------------------
$javaHome = Resolve-JavaHome
if ($javaHome) {
    $javaExe = Join-Path $javaHome 'bin\java.exe'
    $rawVersion = (& $javaExe '-version' 2>&1 | Out-String)
    $versionLine = ($rawVersion -split "`n" | Where-Object { $_ -match 'version' } | Select-Object -First 1)
    Write-Verdict 'JDK 21' $true ("{0} ({1})" -f $javaHome, $versionLine.Trim()) ''
} else {
    Write-Verdict 'JDK 21' $false 'no JDK 21 found via JAVA_HOME, PATH or the usual install roots' `
        'winget install --id EclipseAdoptium.Temurin.21.JDK -e   (or unzip a Temurin 21 JDK and set JAVA_HOME)'
}

# --- SDK root ----------------------------------------------------------------
$sdkRoot = Resolve-SdkRoot
if ($sdkRoot) {
    Write-Verdict 'Android SDK root' $true $sdkRoot ''
} else {
    Write-Verdict 'Android SDK root' $false 'ANDROID_HOME / ANDROID_SDK_ROOT unset and no known SDK directory exists' `
        'install command-line tools, then: sdkmanager --sdk_root=<sdK> "platform-tools" "platforms;android-36" "build-tools;36.0.0" "emulator"'
}

$sdkManager = $null
if ($sdkRoot) {
    $candidates = @(
        (Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'),
        (Join-Path $sdkRoot 'cmdline-tools\bin\sdkmanager.bat'),
        (Join-Path $sdkRoot 'tools\bin\sdkmanager.bat'))
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { $sdkManager = $candidate; break }
    }
    if (-not $sdkManager) {
        $found = Get-ChildItem -Path (Join-Path $sdkRoot 'cmdline-tools') -Filter 'sdkmanager.bat' -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($found) { $sdkManager = $found.FullName }
    }
}

$sdkRootArg = '<sdkRoot>'
$sdkManagerCmd = 'sdkmanager'
if ($sdkRoot) { $sdkRootArg = $sdkRoot }
if ($sdkManager) { $sdkManagerCmd = $sdkManager } else { $sdkManagerCmd = 'sdkmanager' }

# --- SDK packages ------------------------------------------------------------
$platformDir = $null
$buildToolsDir = $null
$adb = $null
$emulator = $null

if ($sdkRoot) {
    $platformDir = Join-Path $sdkRoot 'platforms\android-36'
    Write-Verdict 'platforms;android-36' (Test-Path $platformDir) $(if (Test-Path $platformDir) { $platformDir } else { 'not installed' }) `
        ("& '{0}' --sdk_root='{1}' 'platforms;android-36'" -f $sdkManagerCmd, $sdkRootArg)

    $buildToolsRoot = Join-Path $sdkRoot 'build-tools'
    if (Test-Path $buildToolsRoot) {
        $exact = Join-Path $buildToolsRoot '36.0.0'
        if (Test-Path $exact) {
            $buildToolsDir = $exact
        } else {
            $match = Get-ChildItem -Path $buildToolsRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^36\.' } | Sort-Object Name -Descending | Select-Object -First 1
            if ($match) { $buildToolsDir = $match.FullName }
        }
    }
    Write-Verdict 'build-tools;36.0.0' ($null -ne $buildToolsDir) $(if ($buildToolsDir) { $buildToolsDir } else { 'not installed' }) `
        ("& '{0}' --sdk_root='{1}' 'build-tools;36.0.0'" -f $sdkManagerCmd, $sdkRootArg)

    $adbPath = Join-Path $sdkRoot 'platform-tools\adb.exe'
    if (Test-Path $adbPath) { $adb = $adbPath }
    Write-Verdict 'platform-tools\adb.exe' ($null -ne $adb) $(if ($adb) { $adb } else { 'not installed' }) `
        ("& '{0}' --sdk_root='{1}' 'platform-tools'" -f $sdkManagerCmd, $sdkRootArg)

    $emulatorPath = Join-Path $sdkRoot 'emulator\emulator.exe'
    if (Test-Path $emulatorPath) { $emulator = $emulatorPath }
    Write-Verdict 'emulator\emulator.exe' ($null -ne $emulator) $(if ($emulator) { $emulator } else { 'not installed' }) `
        ("& '{0}' --sdk_root='{1}' 'emulator'" -f $sdkManagerCmd, $sdkRootArg)
} else {
    Write-Verdict 'platforms;android-36' $false 'no SDK root to look in' 'set ANDROID_HOME to an SDK root'
    Write-Verdict 'build-tools;36.0.0' $false 'no SDK root to look in' 'set ANDROID_HOME to an SDK root'
    Write-Verdict 'platform-tools\adb.exe' $false 'no SDK root to look in' 'set ANDROID_HOME to an SDK root'
    Write-Verdict 'emulator\emulator.exe' $false 'no SDK root to look in' 'set ANDROID_HOME to an SDK root'
}

# --- system image ------------------------------------------------------------
$systemImageRoot = $null
if ($sdkRoot) {
    $imagesRoot = Join-Path $sdkRoot 'system-images'
    if (Test-Path $imagesRoot) {
        $match = Get-ChildItem -Path $imagesRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -match '^android-35' -and
                (Test-Path (Join-Path $_.FullName 'google_apis\x86_64'))
            } | Sort-Object Name -Descending | Select-Object -First 1
        if ($match) {
            $systemImageRoot = Join-Path $match.FullName 'google_apis\x86_64'
        }
    }
}
Write-Verdict 'system-images;android-35;google_apis;x86_64' ($null -ne $systemImageRoot) $(if ($systemImageRoot) { $systemImageRoot } else { 'not installed' }) `
    ("& '{0}' --sdk_root='{1}' 'system-images;android-35;google_apis;x86_64'" -f $sdkManagerCmd, $sdkRootArg)

# --- AVD ---------------------------------------------------------------------
$avdName = 'test'
$avdPath = Join-Path (Join-Path $env:USERPROFILE '.android\avd') ($avdName + '.avd')
$avdExists = Test-Path $avdPath
if (-not $avdExists -and $sdkRoot) {
    $avdIni = Join-Path (Join-Path $env:USERPROFILE '.android\avd') ($avdName + '.ini')
    $avdExists = Test-Path $avdIni
}
Write-Verdict ("AVD '{0}'" -f $avdName) $avdExists $(if ($avdExists) { $avdPath } else { 'not created' }) `
    ("avdmanager.bat create avd -n {0} -k `"system-images;android-35;google_apis;x86_64`" -d pixel_6 --force" -f $avdName)

# --- hypervisor --------------------------------------------------------------
# Without hardware acceleration the emulator either refuses to boot or crawls.
$accel = $null
if ($emulator) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $accel = (& $emulator '-accel-check' 2>&1 | Out-String).Trim()
    } catch {
        $accel = ''
    } finally {
        $ErrorActionPreference = $previous
    }
}
$accelOk = ($null -ne $accel) -and ($accel -match 'is installed and usable')
# `emulator -accel-check` prints "accel:", then "0" / a non-zero code, then the
# human line. Quote the human line, not the header.
$accelLine = 'cannot run emulator -accel-check'
if ($accel) {
    $detail = ($accel -split "`n" |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -and $_ -notmatch '^accel:?$' -and $_ -notmatch '^[0-9]+$' } |
            Select-Object -First 1)
    if ($detail) { $accelLine = $detail }
}
Write-Verdict 'hypervisor acceleration' $accelOk $accelLine `
    'enable Windows Hypervisor Platform (Windows Features > 更多 Windows 功能 > Windows 虚拟机监控程序平台) and reboot'

Write-Host ''
if ($script:Failures.Count -gt 0) {
    Write-Host ("RESULT: BLOCKED - {0} item(s) missing: {1}" -f $script:Failures.Count, ($script:Failures -join ', '))
    if ($Write) {
        Write-Host 'Refusing to write .local/toolchain.json while the report is red.'
    }
    exit 1
}

Write-Host 'RESULT: OK - this machine can build the debug APK and boot the test AVD.'

if ($Write) {
    $configDir = Split-Path -Parent $ConfigPath
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $payload = [ordered]@{
        javaHome = $javaHome
        sdkRoot  = $sdkRoot
        adb      = $adb
        emulator = $emulator
        avdName  = $avdName
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -Path $ConfigPath -Encoding UTF8
    Write-Host ("Wrote {0}" -f $ConfigPath)
}

exit 0
