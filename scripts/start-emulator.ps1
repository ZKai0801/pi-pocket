<#
.SYNOPSIS
  Boot the `test` AVD, install the debug APK and launch PocketShell.

.DESCRIPTION
  Task 5's acceptance runs against the packaged APK on an emulator, so this is
  the repeatable way to get there: resolve the toolchain the same way
  scripts/android-doctor.ps1 and scripts/build-android-debug.ps1 do, start the
  AVD if nothing is running, wait for `sys.boot_completed`, install the APK
  with -r, and launch MainActivity.

  Two rules this script deliberately keeps:

    * It never kills an emulator it did not start. A pre-existing `test`
      emulator is reused; a pre-existing emulator on another AVD is left alone
      and the script fails loudly instead of stealing it.
    * It does not report success it did not observe: every wait has a timeout
      and exits non-zero with the last `adb` state when the timeout expires.

.PARAMETER Apk
  APK to install. Default: android\app\build\outputs\apk\debug\app-debug.apk

.PARAMETER Cold
  Start the AVD with -no-snapshot (ignore the saved snapshot). Default on.

.PARAMETER Headless
  Start with -no-window (no visible screen). Screenshots still work through
  `adb exec-out screencap`, but Task 5's evidence wants the real window, so this
  is opt-in.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-emulator.ps1
#>
[CmdletBinding()]
param(
    [string]$Apk,
    [switch]$Cold = $true,
    [switch]$Headless
)

$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path (Join-Path $repoRoot '.local') 'toolchain.json'

function Fail {
    param([string]$Message)
    Write-Host ("FAIL: {0}" -f $Message) -ForegroundColor Red
    exit 1
}

function Get-Toolchain {
    $config = $null
    if (Test-Path $configPath) {
        try { $config = Get-Content -Raw -Path $configPath | ConvertFrom-Json } catch { $config = $null }
    }

    $sdkRoot = $null
    if ($config -and $config.sdkRoot) { $sdkRoot = $config.sdkRoot }
    elseif ($env:ANDROID_HOME) { $sdkRoot = $env:ANDROID_HOME }
    elseif ($env:ANDROID_SDK_ROOT) { $sdkRoot = $env:ANDROID_SDK_ROOT }

    $adb = $null
    if ($config -and $config.adb) { $adb = $config.adb }
    elseif ($sdkRoot) { $adb = Join-Path $sdkRoot 'platform-tools\adb.exe' }

    $emulator = $null
    if ($config -and $config.emulator) { $emulator = $config.emulator }
    elseif ($sdkRoot) { $emulator = Join-Path $sdkRoot 'emulator\emulator.exe' }

    $avd = 'test'
    if ($config -and $config.avdName) { $avd = $config.avdName }

    return [pscustomobject]@{ sdkRoot = $sdkRoot; adb = $adb; emulator = $emulator; avdName = $avd }
}

$tools = Get-Toolchain
if (-not $tools.adb -or -not (Test-Path $tools.adb)) {
    Fail 'adb not found. Run: powershell -File scripts/android-doctor.ps1'
}
if (-not $tools.emulator -or -not (Test-Path $tools.emulator)) {
    Fail 'the emulator binary was not found. Run: powershell -File scripts/android-doctor.ps1'
}

if (-not $Apk) { $Apk = Join-Path $repoRoot 'android\app\build\outputs\apk\debug\app-debug.apk' }
if (-not (Test-Path $Apk)) {
    Fail ("no APK at {0}; build it first: npm run build:android:debug:win" -f $Apk)
}

# AGP/Gradle are not needed here, but adb talks to the emulator on localhost and
# the emulator needs the SDK root to find its system image.
$env:ANDROID_HOME = $tools.sdkRoot
$env:ANDROID_SDK_ROOT = $tools.sdkRoot

function Get-AdbDevices {
    $lines = & $tools.adb 'devices' 2>&1
    return @($lines | Where-Object { $_ -match '^\S+\s+(device|offline|unauthorized)$' })
}

$devices = Get-AdbDevices
$bootedSerial = $null
foreach ($line in $devices) {
    $serial = ($line -split '\s+')[0]
    $produced = (& $tools.adb '-s' $serial 'shell' 'getprop' 'sys.boot_completed' 2>&1 | Out-String).Trim()
    if ($produced -eq '1') { $bootedSerial = $serial; break }
}

if ($bootedSerial) {
    Write-Host ("Reusing the already-running emulator {0} (this script never kills an emulator it did not start)." -f $bootedSerial)
} else {
    $running = @($devices | Where-Object { $_ -match '^\S+\s+device' })
    if ($running.Count -gt 0) {
        Fail ("an emulator is attached but not booted ({0}); refusing to start a second one" -f ($running -join '; '))
    }

    # Name conflicts: emulator refuses a second instance of the same AVD, which
    # is why the reuse branch above exists.
    Write-Host ("Starting AVD '{0}' ..." -f $tools.avdName)
    $emulatorArgs = @('-avd', $tools.avdName, '-gpu', 'swiftshader_indirect', '-no-boot-anim')
    if ($Cold) { $emulatorArgs += '-no-snapshot' }
    if ($Headless) { $emulatorArgs += '-no-window' }

    # Detached: the emulator outlives this script (evidence capture follows it).
    $started = Start-Process -FilePath $tools.emulator -ArgumentList $emulatorArgs -PassThru
    Write-Host ("emulator pid {0}" -f $started.Id)

    $deadline = (Get-Date).AddMinutes(6)
    $bootedSerial = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        foreach ($line in (Get-AdbDevices)) {
            $serial = ($line -split '\s+')[0]
            $produced = (& $tools.adb '-s' $serial 'shell' 'getprop' 'sys.boot_completed' 2>&1 | Out-String).Trim()
            if ($produced -eq '1') { $bootedSerial = $serial; break }
        }
        if ($bootedSerial) { break }
        Write-Host '  waiting for sys.boot_completed ...'
    }
    if (-not $bootedSerial) {
        Fail 'the AVD did not finish booting within 6 minutes; see `adb devices` and the emulator window'
    }
}

Write-Host ("emulator ready: {0}" -f $bootedSerial)

# Settle the window manager before the first screenshot: a launcher that is
# still animating produces evidence nobody can read.
& $tools.adb '-s' $bootedSerial 'shell' 'settings' 'put' 'global' 'window_animation_scale' '0' | Out-Null
& $tools.adb '-s' $bootedSerial 'shell' 'settings' 'put' 'global' 'transition_animation_scale' '0' | Out-Null
& $tools.adb '-s' $bootedSerial 'shell' 'settings' 'put' 'global' 'animator_duration_scale' '0' | Out-Null

Write-Host ("Installing {0}" -f $Apk)
$install = & $tools.adb '-s' $bootedSerial 'install' '-r' $Apk 2>&1 | Out-String
Write-Host $install.Trim()
if ($install -notmatch 'Success') {
    Fail 'adb install did not report Success'
}

& $tools.adb '-s' $bootedSerial 'shell' 'am' 'start' '-n' 'com.pocketshell.app/.MainActivity' 2>&1 | Out-String | Write-Host
Start-Sleep -Seconds 3

$focused = (& $tools.adb '-s' $bootedSerial 'shell' 'dumpsys' 'activity' 'activities' 2>&1 | Out-String)
if ($focused -match 'com\.pocketshell\.app/\.MainActivity') {
    Write-Host 'PocketShell is on screen.' -ForegroundColor Green
} else {
    Fail 'the activity did not come to the foreground; capture `adb shell dumpsys activity activities` for the report'
}

$hash = (Get-FileHash -Path $Apk -Algorithm SHA256).Hash.ToLower()
Write-Host ("installed sha256: {0}" -f $hash)
Write-Host ("serial: {0}" -f $bootedSerial)
exit 0
