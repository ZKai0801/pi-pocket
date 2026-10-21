<#
.SYNOPSIS
  Run the JS unit gate on Windows without bash or pnpm.

.DESCRIPTION
  scripts/run-js-unit-gate.sh is the CI gate: it runs the whole configured
  Vitest suite, writes a JSON report, and has
  scripts/check-js-unit-results.py reject any file or test title that does not
  match scripts/js-unit-test-manifest.json exactly. The .sh needs bash, `pnpm`
  and `python3`, none of which exist on this checkout's Windows box — so the
  gate only ever ran in CI, which is how a red `main` goes unnoticed
  (Review Focus 3).

  This script is the same gate, same checker, same exit-code contract:
    * `npx vitest run` with a JSON report (no pnpm; the local install is used),
    * `python scripts/check-js-unit-results.py --report <path>`,
    * exit code = Vitest's, after the checker has run (the checker still runs
      when Vitest fails, so a red run names its failing tests).
  It fails closed: a missing node_modules, a missing Python, or a missing
  checker is an explicit failure, never a vacuous pass.

.PARAMETER Report
  Where to write the Vitest JSON report. Default:
  build/test-results/js-unit/vitest-results.json

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-js-unit-gate.ps1
#>
[CmdletBinding()]
param(
    [string]$Report = 'build/test-results/js-unit/vitest-results.json'
)

$ErrorActionPreference = 'Continue'

$rootDir = Split-Path -Parent $PSScriptRoot

function Fail {
    param([string]$Message)
    Write-Host ("FAIL: {0}" -f $Message) -ForegroundColor Red
    exit 1
}

function Invoke-Usage {
    @'
Usage: scripts/run-js-unit-gate.ps1 [-Report <path>]

Run every Vitest unit test, write its JSON result, and check the exact
registered file and test-title set in scripts/js-unit-test-manifest.json.
'@ | Write-Host
}

# --- preconditions (fail closed) ---------------------------------------------
$vitest = Join-Path $rootDir 'node_modules\.bin\vitest.cmd'
if (-not (Test-Path $vitest)) {
    Fail 'Vitest is not installed; run `npx vitest --version` once or `npm install`'
}
if (-not (Test-Path (Join-Path $rootDir 'scripts\check-js-unit-results.py'))) {
    Fail 'scripts/check-js-unit-results.py is missing; the gate cannot verify the manifest'
}

# The checker is the gate. Without Python there is no gate, so say so instead
# of skipping it — docs/ci-pitfalls.md calls the silent-skip the failure mode.
$python = $null
foreach ($candidate in @('python', 'python3', 'py')) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($command) {
        $probe = & $candidate '--version' 2>&1
        if ($LASTEXITCODE -eq 0 -and ("$probe" -match '^Python 3\.')) {
            $python = $candidate
            break
        }
    }
}
if (-not $python) {
    Fail 'no Python 3 on PATH; the manifest checker is required (install Python 3 and re-run)'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail 'node is required'
}

# tests/unit/sshKeySetup.test.ts stands in for a remote host's login shell by
# spawning `/bin/sh`, `bash` and `dash` and piping through `base64`. Those are
# POSIX paths: on Windows they only resolve if a MSYS tree is reachable, both as
# `/bin/sh` on the current drive and as `base64` on PATH. Without one, three
# tests fail with "the host could not add the key" — an environment gap wearing
# the costume of a product bug.
# Discovery: a Git for Windows install exposes <root>\usr\bin\{sh,base64}.exe.
$posixUsrBin = $null
$gitRoots = New-Object System.Collections.ArrayList
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($git) {
    $gitExeDir = Split-Path -Parent $git.Source
    [void]$gitRoots.Add((Split-Path -Parent $gitExeDir))
    [void]$gitRoots.Add($gitExeDir)
}
foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'Git'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Git'),
        'D:\software\Git',
        'C:\software\Git')) {
    if ($candidate) { [void]$gitRoots.Add($candidate) }
}
foreach ($root in $gitRoots) {
    $usrBin = Join-Path $root 'usr\bin'
    if ((Test-Path (Join-Path $usrBin 'sh.exe')) -and (Test-Path (Join-Path $usrBin 'base64.exe'))) {
        $posixUsrBin = $usrBin
        break
    }
}
if ($posixUsrBin) {
    $env:Path = $posixUsrBin + ';' + (Split-Path -Parent $posixUsrBin) + ';' + $env:Path
    Write-Host ("POSIX shell for the authorized-keys tests: {0}" -f (Join-Path $posixUsrBin 'sh.exe'))
} else {
    Write-Host 'WARNING: no Git-for-Windows usr\bin found; tests/unit/sshKeySetup.test.ts will fail on its /bin/sh spawns.' -ForegroundColor Yellow
    Write-Host 'WARNING: that is an environment gap, not a product defect: install Git for Windows (or run the gate on Linux).' -ForegroundColor Yellow
}

# .nvmrc pins the Node major CI uses. A different local major means a green
# run here does not prove CI is green; warn loudly, and fail when strict.
$nvmrc = Join-Path $rootDir '.nvmrc'
if (-not (Test-Path $nvmrc)) { Fail '.nvmrc is missing' }
$pinnedNode = ((Get-Content -Raw -Path $nvmrc).Trim() -replace '^v', '') -replace '\..*$', ''
if ($pinnedNode -notmatch '^[0-9]+$') {
    Fail ('.nvmrc must hold a Node major version, found "{0}"' -f $pinnedNode)
}
$localNode = ((& node -p "process.versions.node") -split '\.')[0]
if ($localNode -ne $pinnedNode) {
    Write-Host ("WARNING: this gate is running on Node {0}, but CI runs Node {1} (.nvmrc)." -f $localNode, $pinnedNode) -ForegroundColor Yellow
    Write-Host ("WARNING: a green result here does not prove CI is green; syntax or APIs newer than Node {0} pass locally and fail in CI." -f $pinnedNode) -ForegroundColor Yellow
    if ($env:JS_UNIT_GATE_STRICT_NODE -eq '1') {
        Fail ("JS_UNIT_GATE_STRICT_NODE=1 requires Node {0}" -f $pinnedNode)
    }
}

# Node >= 25 turns on Web Storage by default, so `globalThis.localStorage`
# exists before jsdom installs its own — and without `--localstorage-file` it is
# a non-functional object (`getItem` is not a function). jsdom does not replace
# an existing global, so every jsdom test that reads localStorage would fail with
# a stack trace that looks like a product bug. Turn the built-in store off when
# the runtime knows the flag; jsdom then supplies its own, exactly as on Node 22.
$webStorageProbe = & node '--no-experimental-webstorage' '-p' '1' 2>$null
if ($LASTEXITCODE -eq 0 -and $env:NODE_OPTIONS -notmatch 'webstorage') {
    $env:NODE_OPTIONS = if ([string]::IsNullOrWhiteSpace($env:NODE_OPTIONS)) {
        '--no-experimental-webstorage'
    } else {
        "$($env:NODE_OPTIONS) --no-experimental-webstorage"
    }
    Write-Host 'Node Web Storage disabled for this run (jsdom owns localStorage).'
}

# --- report path -------------------------------------------------------------
if (-not [System.IO.Path]::IsPathRooted($Report)) {
    $Report = Join-Path $rootDir $Report
}
$reportDir = Split-Path -Parent $Report
if (-not (Test-Path $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}
# Truncate first: the checker must never read a stale report from a previous
# run when this one dies before writing (the .sh does the same).
Set-Content -Path $Report -Value '' -Encoding ASCII

Write-Host ("Running the complete Vitest suite with JSON results at {0}" -f $Report)

# --no-file-parallelism is load-bearing on Windows, not a speed knob: under
# parallel file execution the JSON reporter intermittently omits one test file
# from the report (observed on this box across repeated runs of the same tree).
# The checker then fails on a file that DID run — a false RED that teaches the
# operator to ignore the gate, which is worse than the minutes it costs.
Push-Location $rootDir
try {
    & $vitest 'run' '--no-file-parallelism' '--reporter=default' '--reporter=json' ("--outputFile.json={0}" -f $Report)
    $vitestStatus = $LASTEXITCODE
} finally {
    Pop-Location
}

# The checker runs even when Vitest failed (#3043), and its own exit code is
# discarded in favour of Vitest's — a manifest mismatch on a red run is noise
# beside the failing tests.
& $python (Join-Path $rootDir 'scripts\check-js-unit-results.py') '--report' $Report
$checkerStatus = $LASTEXITCODE

if ($vitestStatus -eq 0 -and $checkerStatus -ne 0) {
    Write-Host 'FAIL: the suite passed but the manifest check rejected it' -ForegroundColor Red
    exit $checkerStatus
}
if ($vitestStatus -ne 0) {
    Write-Host ("FAIL: vitest exited {0}" -f $vitestStatus) -ForegroundColor Red
    exit $vitestStatus
}

Write-Host 'JS unit gate: PASS' -ForegroundColor Green
exit 0
