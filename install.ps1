# Run from PowerShell: .\install.ps1
$ErrorActionPreference = 'Stop'

Push-Location -LiteralPath $PSScriptRoot
try {
    foreach ($tool in @('node', 'npm.cmd', 'herdr-app', 'hc')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "Missing required command: $tool. Install it and rerun .\install.ps1."
        }
    }

    $versionText = & node --version
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $nodeVersion = [version]($versionText.Trim().TrimStart('v').Split('-')[0])
    if (-not (($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 21) -or
              ($nodeVersion.Major -eq 24 -and $nodeVersion.Minor -ge 5) -or
              $nodeVersion.Major -gt 24)) {
        throw 'Node.js 22.21+ (22.x) or 24.5+ is required.'
    }

    & herdr-app status | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Start Herdr App, then rerun .\install.ps1.'
    }

    Write-Host 'Installing dependencies...'
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & node scripts/setup.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
finally {
    Pop-Location
}
