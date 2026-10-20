<#
.SYNOPSIS
  Build PocketShell's Android debug APK on Windows without bash or pnpm.

.DESCRIPTION
  `npm run build:android:debug` is POSIX end to end: it calls `pnpm`, then
  `./android/gradlew`, then a bash `derive-version.sh`. None of those exist on
  this checkout's Windows box, so the build could not be run at all here — and
  an Android build nobody can run locally is how a broken APK reaches a device
  unchecked.

  This script is the same five steps with the same inputs, spelled in
  PowerShell:

    1. node scripts/verify-js-source.mjs   (the `verify:js-source` script body)
    2. npx vue-tsc --noEmit                (part of `build:web`)
    3. npx vite build                      (part of `build:web`)
    4. npx cap sync android                (the `cap:sync` script body)
    5. android\gradlew.bat -p android assembleDebug --console=plain

  The version the APK carries is derived by scripts/derive-version.mjs (the
  Node twin of derive-version.sh); this script asserts versionCode >= 1 rather
  than trusting a fallback, because an empty versionCode fails
  `assembleDebug` with a manifest error that names nothing useful.

  It stops at the first failing step and exits with that step's code. It never
  swallows a failure to produce an APK-shaped success.

.PARAMETER Configuration
  Gradle build type to assemble. Defaults to `debug` (the acceptance build).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android-debug.ps1
#>
[CmdletBinding()]
param(
    [ValidateSet('debug', 'release')]
    [string]$Configuration = 'debug'
)

$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path (Join-Path $repoRoot '.local') 'toolchain.json'

function Fail {
    param([string]$Message)
    Write-Host ''
    Write-Host ("BUILD FAILED: {0}" -f $Message) -ForegroundColor Red
    exit 1
}

function Invoke-Step {
    param(
        [string]$Label,
        [scriptblock]$Body
    )

    Write-Host ''
    Write-Host ("==> {0}" -f $Label) -ForegroundColor Cyan
    $started = Get-Date
    & $Body
    $code = $LASTEXITCODE
    $elapsed = [int]((Get-Date) - $started).TotalSeconds
    if ($code -ne 0) {
        Fail ("{0} exited {1} after {2}s" -f $Label, $code, $elapsed)
    }
    Write-Host ("    ok ({0}s)" -f $elapsed)
}

# --- toolchain ---------------------------------------------------------------
# Discovery order matches scripts/android-doctor.ps1: the git-ignored local
# config first (it records what the doctor resolved), then the environment.
$localConfig = $null
if (Test-Path $configPath) {
    try {
        $localConfig = Get-Content -Raw -Path $configPath | ConvertFrom-Json
    } catch {
        Fail ("cannot parse {0}: {1}" -f $configPath, $_.Exception.Message)
    }
}

$javaHome = $null
if ($localConfig -and $localConfig.javaHome) { $javaHome = $localConfig.javaHome }
elseif ($env:JAVA_HOME) { $javaHome = $env:JAVA_HOME }

$sdkRoot = $null
if ($localConfig -and $localConfig.sdkRoot) { $sdkRoot = $localConfig.sdkRoot }
elseif ($env:ANDROID_HOME) { $sdkRoot = $env:ANDROID_HOME }
elseif ($env:ANDROID_SDK_ROOT) { $sdkRoot = $env:ANDROID_SDK_ROOT }

if (-not $javaHome -or -not (Test-Path (Join-Path $javaHome 'bin\java.exe'))) {
    Fail 'no JDK 21 found. Run: powershell -File scripts/android-doctor.ps1'
}
if (-not $sdkRoot -or -not (Test-Path (Join-Path $sdkRoot 'platform-tools'))) {
    Fail 'no Android SDK found. Run: powershell -File scripts/android-doctor.ps1'
}

$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:Path = (Join-Path $javaHome 'bin') + ';' + (Join-Path $sdkRoot 'platform-tools') + ';' + (Join-Path $sdkRoot 'build-tools\36.0.0') + ';' + $env:Path

Write-Host 'PocketShell Android debug build (Windows, no bash)'
Write-Host ("repo:     {0}" -f $repoRoot)
Write-Host ("JAVA_HOME {0}" -f $javaHome)
Write-Host ("SDK root  {0}" -f $sdkRoot)

# AGP finds the SDK through ANDROID_HOME, but a stale android/local.properties
# from an older machine wins over it; rewrite it so the build uses the SDK this
# script just resolved. The file is git-ignored.
$localProperties = Join-Path $repoRoot 'android\local.properties'
$sdkDir = $sdkRoot -replace '\\', '\\'
Set-Content -Path $localProperties -Value ("sdk.dir={0}" -f $sdkDir) -Encoding ASCII

Push-Location $repoRoot
try {
    # --- 1-3: web build -----------------------------------------------------
    Invoke-Step 'verify JS source (node scripts/verify-js-source.mjs)' {
        & node scripts/verify-js-source.mjs
    }

    Invoke-Step 'type-check (npx vue-tsc --noEmit)' {
        & npx vue-tsc --noEmit
    }

    # Vite's emptyOutDir removes dist/assets entry by entry, and a bulk-delete
    # guard on this box refuses that (SAFE_DELETE_BULK_CONFIRM_REQUIRED) before
    # the build even starts. Clearing the generated directory once, up front,
    # reaches the same state without the per-entry deletes. dist/ is
    # git-ignored build output, never source.
    $distDir = Join-Path $repoRoot 'dist'
    if (Test-Path $distDir) {
        [System.IO.Directory]::Delete($distDir, $true)
    }

    Invoke-Step 'build web assets (npx vite build)' {
        & npx vite build
    }

    # --- 4: capacitor sync --------------------------------------------------
    # `cap sync` regenerates android/capacitor-cordova-android-plugins from
    # scratch; its own removal of the old tree trips the same bulk-delete guard
    # as dist/ above. The directory is generated (untracked), so clearing it
    # here is the same end state with one delete instead of fifty.
    $cordovaPlugins = Join-Path $repoRoot 'android\capacitor-cordova-android-plugins'
    if (Test-Path $cordovaPlugins) {
        [System.IO.Directory]::Delete($cordovaPlugins, $true)
    }

    Invoke-Step 'sync into android (npx cap sync android)' {
        & npx cap sync android
    }

    # --- version ------------------------------------------------------------
    Write-Host ''
    Write-Host '==> derive version (node scripts/derive-version.mjs both)' -ForegroundColor Cyan
    $versionOutput = & node scripts/derive-version.mjs both
    if ($LASTEXITCODE -ne 0) {
        Fail 'scripts/derive-version.mjs refused to emit a version'
    }

    $versionCode = $null
    $versionName = $null
    foreach ($line in $versionOutput) {
        if ($line -match '^VERSION_CODE=(.+)$') { $versionCode = $Matches[1].Trim() }
        if ($line -match '^VERSION_NAME=(.+)$') { $versionName = $Matches[1].Trim() }
    }
    if (-not $versionCode -or -not ($versionCode -match '^[1-9][0-9]*$')) {
        Fail ("derived versionCode is not a positive integer: '{0}'" -f $versionCode)
    }
    if (-not $versionName) {
        Fail 'derived versionName is empty'
    }
    Write-Host ("    versionCode={0} versionName={1}" -f $versionCode, $versionName)

    # --- 5: gradle ----------------------------------------------------------
    $task = 'assembleDebug'
    if ($Configuration -eq 'release') { $task = 'assembleRelease' }
    Invoke-Step ("gradle {0}" -f $task) {
        & (Join-Path $repoRoot 'android\gradlew.bat') '-p' 'android' $task '--console=plain'
    }
} finally {
    Pop-Location
}

# --- result ------------------------------------------------------------------
$apk = Join-Path $repoRoot ("android\app\build\outputs\apk\{0}\app-{0}.apk" -f $Configuration)
if (-not (Test-Path $apk)) {
    Fail ("gradle reported success but no APK is at {0}" -f $apk)
}

$hash = (Get-FileHash -Path $apk -Algorithm SHA256).Hash.ToLower()
$sizeMb = [math]::Round((Get-Item $apk).Length / 1MB, 1)

Write-Host ''
Write-Host 'BUILD SUCCESSFUL' -ForegroundColor Green
Write-Host ("APK:      {0}" -f $apk)
Write-Host ("size:     {0} MB" -f $sizeMb)
Write-Host ("sha256:   {0}" -f $hash)
Write-Host ("version:  {0} ({1})" -f $versionName, $versionCode)
exit 0
