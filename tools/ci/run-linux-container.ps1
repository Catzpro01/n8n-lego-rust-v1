[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Command,

  [string]$Image = "n8n-rust-runner:latest",

  [string]$Workspace = $env:GITHUB_WORKSPACE
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  throw "GITHUB_WORKSPACE is required"
}

if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
  throw "docker.exe is required for Linux-container jobs on the Windows runner"
}

docker version --format "{{.Server.Version}}" | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "Docker daemon is not available"
}

# Never turn a missing local CI image into an implicit network pull.
docker image inspect $Image *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Required Linux runner image '$Image' is not present on this runner"
}

$resolved = (Resolve-Path -LiteralPath $Workspace).Path
$runnerName = if ([string]::IsNullOrWhiteSpace($env:RUNNER_NAME)) { "default" } else { $env:RUNNER_NAME }
$volumeSuffix = $runnerName.ToLowerInvariant() -replace '[^a-z0-9_.-]', '-'
$cargoTargetVolume = "n8n-rust-runner-cargo-target-$volumeSuffix"
$cargoHomeVolume = "n8n-rust-runner-cargo-home-$volumeSuffix"
$scriptPath = Join-Path $env:RUNNER_TEMP ("arena-linux-command-" + [guid]::NewGuid().ToString("N") + ".sh")

# Keep the command script Linux-native regardless of PowerShell line endings.
$lfCommand = [regex]::Replace($Command, "
?", ([char]10).ToString())
[System.IO.File]::WriteAllText(
  $scriptPath,
  $lfCommand + [char]10,
  [System.Text.UTF8Encoding]::new($false)
)

# Reserve two logical host CPUs for Windows/Docker Desktop responsiveness.
# This changes only the CI process parallelism; no Windows settings are modified.
$hostLogicalCores = [Environment]::ProcessorCount
$cargoJobs = [Math]::Max(1, $hostLogicalCores - 2)

Write-Host "Linux container image: $Image"
Write-Host "Workspace: $resolved"
Write-Host "Runner: $runnerName"
Write-Host "Cargo target volume: $cargoTargetVolume"
Write-Host "Cargo home volume: $cargoHomeVolume"
Write-Host "Cargo build jobs: $cargoJobs (host logical CPUs: $hostLogicalCores; reserved: 2)"
Write-Host "Command script: $scriptPath"

# ── Performance telemetry (lightweight, no secrets) ──────────────────────────
$ciStart = [System.Diagnostics.Stopwatch]::StartNew()
Write-Host "::group::CI Telemetry"
Write-Host "[CI_TELEMETRY] CONTAINER_START $(Get-Date -Format 'o')"

try {
  docker run --pull=never --rm --mount "type=bind,source=$resolved,target=/workspace" --mount "type=volume,source=$cargoTargetVolume,target=/workspace/target" --mount "type=volume,source=$cargoHomeVolume,target=/cargo" --env CARGO_HOME=/cargo --env CARGO_TARGET_DIR=/workspace/target --env CARGO_BUILD_JOBS=$cargoJobs --mount "type=bind,source=$scriptPath,target=/tmp/arena-command.sh,readonly" --workdir /workspace $Image bash /tmp/arena-command.sh
  $dockerExit = $LASTEXITCODE
}
finally {
  $ciStart.Stop()
  $durationMs = $ciStart.ElapsedMilliseconds
  $durationSec = [Math]::Round($durationMs / 1000, 1)
  Write-Host "[CI_TELEMETRY] CONTAINER_DONE $(Get-Date -Format 'o') duration_ms=$durationMs duration_sec=$durationSec exit=$dockerExit"
  Write-Host "::endgroup::"
  Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
}

if ($dockerExit -ne 0) {
  exit $dockerExit
}
