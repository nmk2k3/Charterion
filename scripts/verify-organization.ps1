# Validate the complete Organization runtime after all patches are pulled.
# This script does not edit repository content or call paid AI APIs.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $repo
try {
    Write-Host '== Charterion Organization verification ==' -ForegroundColor Cyan

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js is not available in PATH'
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm is not available in PATH'
    }

    if (-not (Test-Path 'node_modules')) {
        Write-Host '[setup] Installing locked dependencies'
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    }

    function Invoke-Checked {
        param([string]$Tool, [string[]]$Arguments)
        Write-Host ("[run] {0} {1}" -f $Tool, ($Arguments -join ' ')) -ForegroundColor Cyan
        & $Tool @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw ("Verification failed: {0} {1} (exit {2})" -f $Tool, ($Arguments -join ' '), $LASTEXITCODE)
        }
    }

    Invoke-Checked -Tool 'npm' -Arguments @('run', 'check:control')
    Invoke-Checked -Tool 'npm' -Arguments @('run', 'build:control')
    Invoke-Checked -Tool 'npx' -Arguments @(
        'vitest', 'run',
        'control/tests/organizationRetryLifecycle.test.ts',
        'control/tests/organizationReviewGate.test.ts',
        'control/tests/organizationPostTestRelease.test.ts',
        'control/tests/organizationTesterVerificationGate.test.ts',
        '--pool=forks', '--fileParallelism=false'
    )
    Invoke-Checked -Tool 'npm' -Arguments @('run', 'check')
    Invoke-Checked -Tool 'npm' -Arguments @('run', 'check:architecture')
    Invoke-Checked -Tool 'npm' -Arguments @('test')
    Invoke-Checked -Tool 'npm' -Arguments @('run', 'build')

    & git diff --check
    if ($LASTEXITCODE -ne 0) { throw 'git diff --check failed' }
    Write-Host 'CHARTERION_ORGANIZATION_VERIFICATION_PASS' -ForegroundColor Green
} finally {
    Pop-Location
}
