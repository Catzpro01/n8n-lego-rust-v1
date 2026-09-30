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

# CI must never turn a missing local image into an implicit network pull.
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

$lfCommand = [regex]::Replace($Command, "
?", ([char]10).ToString())
[System.IO.File]::WriteAllText(
  $scriptPath,
  $lfCommand + [char]10,
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Linux container image: $Image"
Write-Host "Workspace: $resolved"
Write-Host "Runner: $runnerName"
Write-Host "Cargo target volume: $cargoTargetVolume"
Write-Host "Cargo home volume: $cargoHomeVolume"
Write-Host "Command script: $scriptPath"

try {
  docker run --pull=never --rm --mount "type=bind,source=$resolved,target=/workspace" --mount "type=volume,source=$cargoTargetVolume,target=/workspace/target" --mount "type=volume,source=$cargoHomeVolume,target=/cargo" --env CARGO_HOME=/cargo --env CARGO_TARGET_DIR=/workspace/target --mount "type=bind,source=$scriptPath,target=/tmp/arena-command.sh,readonly" --workdir /workspace $Image bash /tmp/arena-command.sh
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
}
