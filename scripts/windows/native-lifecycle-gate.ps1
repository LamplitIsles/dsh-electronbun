[CmdletBinding()]
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  Write-Output "SKIP: native lifecycle gate requires Windows 11 x64"
  exit 0
}
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "The native lifecycle gate requires a Windows 11 x64 runner (received $env:PROCESSOR_ARCHITECTURE)."
}

$zigCommand = Get-Command zig -ErrorAction SilentlyContinue
if ($null -eq $zigCommand) {
  throw "Zig 0.16.0 is required for the native lifecycle gate."
}
$zigVersion = (& $zigCommand.Source version).Trim()
if ($zigVersion -ne "0.16.0") {
  throw "The native lifecycle gate requires Zig 0.16.0 (found $zigVersion)."
}

$bunCommand = Get-Command bun.exe -ErrorAction SilentlyContinue
if ($null -eq $bunCommand) {
  throw "Bun 1.4.0 is required for the native lifecycle gate; install it separately."
}
$bunVersion = (& $bunCommand.Source --version).Trim()
if ($bunVersion -ne "1.4.0") {
  throw "The native lifecycle gate requires Bun 1.4.0 (found $bunVersion)."
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ("dsh-electronbun-native-" + [Guid]::NewGuid().ToString("N"))
$fixtureSidecarRoot = Join-Path $buildRoot "payload/sidecar"
$sidecar = Join-Path $fixtureSidecarRoot "reference-sidecar.ts"
$supervisor = Join-Path $buildRoot "bin/dsh-sidecar-supervisor.exe"
$childPidFile = Join-Path $buildRoot "descendant.pid"
$port = 43173
$readiness = "http://127.0.0.1:$port/health"

$parents = [System.Collections.Generic.List[object]]::new()
$supervisors = [System.Collections.Generic.List[object]]::new()

function Quote-ProcessArgument([string]$value) {
  if ($value -notmatch '[\s"]') { return $value }
  return '"' + $value + '"'
}

function Start-TestParent {
  $powershell = Join-Path $PSHOME "pwsh.exe"
  if (-not (Test-Path -LiteralPath $powershell)) {
    $powershell = Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0/powershell.exe"
  }
  return Start-Process -FilePath $powershell -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    (Quote-ProcessArgument (Join-Path $repo "scripts/windows/parent-harness.ps1"))
  ) -PassThru -WindowStyle Hidden
}

function Start-TestSupervisor([System.Diagnostics.Process]$parent) {
  $supervisorArgs = @(
    "--parent-pid", $parent.Id.ToString(),
    "--bun", (Quote-ProcessArgument $bunCommand.Source),
    "--entrypoint", (Quote-ProcessArgument $sidecar),
    "--"
  )
  return Start-Process -FilePath $supervisor -ArgumentList $supervisorArgs -PassThru -WindowStyle Hidden
}

function Wait-Ready {
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $readiness -TimeoutSec 1
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return }
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  throw "Fixture sidecar did not become ready within 10 seconds."
}

function Assert-PortClosed {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $readiness -TimeoutSec 1 | Out-Null
    throw "Fixture port $port is still serving after supervisor cleanup."
  } catch {
    # PowerShell 5 and 7 wrap connection refusal in different exception types;
    # only those expected transport failures are accepted. Preserve an
    # intentional assertion failure or another network error.
    $message = $_.Exception.Message
    if ($message -match "refused|actively refused|could not establish|target machine") { return }
    throw
  }
}

function Assert-ProcessGone([int]$pid, [string]$label) {
  if ($pid -le 0) { throw "$label did not publish a valid PID." }
  if (Get-Process -Id $pid -ErrorAction SilentlyContinue) {
    throw "$label (PID $pid) survived Job cleanup."
  }
}

function Stop-AndVerify([System.Diagnostics.Process]$parent, [System.Diagnostics.Process]$supervisorProcess, [string]$mode) {
  if (-not $supervisorProcess.HasExited) {
    Stop-Process -Id $supervisorProcess.Id -Force
  }
  if (-not $supervisorProcess.WaitForExit(5000)) {
    throw "$mode supervisor did not exit within the cleanup bound."
  }
  $childPid = [int](Get-Content -LiteralPath $childPidFile -ErrorAction Stop | Select-Object -First 1)
  Assert-PortClosed
  Assert-ProcessGone $childPid "$mode fixture descendant"
  if (-not $parent.HasExited) {
    Stop-Process -Id $parent.Id -Force
  }
}

try {
  New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $fixtureSidecarRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo "payload/sidecar/reference-sidecar.ts") -Destination $sidecar -Force
  Copy-Item -LiteralPath (Join-Path $repo "payload/sidecar/descendant.ts") -Destination (Join-Path $fixtureSidecarRoot "descendant.ts") -Force
  if (-not $SkipBuild) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $supervisor) -Force | Out-Null
    & $zigCommand.Source build-exe (Join-Path $repo "supervisor/src/main.zig") `
      -target x86_64-windows-msvc -O ReleaseSafe ("-femit-bin=$supervisor")
    if ($LASTEXITCODE -ne 0) { throw "Zig supervisor build failed with exit code $LASTEXITCODE." }
  } else {
    $prebuilt = Join-Path $repo "supervisor/bin/dsh-sidecar-supervisor.exe"
    if (-not (Test-Path -LiteralPath $prebuilt -PathType Leaf)) { throw "Prebuilt supervisor is missing: $prebuilt" }
    Copy-Item -LiteralPath $prebuilt -Destination $supervisor -Force
  }
  if (-not (Test-Path -LiteralPath $supervisor)) { throw "Supervisor executable is missing: $supervisor" }

  $env:DSH_FIXTURE_PORT = $port.ToString()
  $env:DSH_FIXTURE_CHILD_PID_FILE = $childPidFile

  # Normal supervisor termination closes the Job and removes the full tree.
  $parent = Start-TestParent
  $supervisorProcess = Start-TestSupervisor $parent
  $parents.Add($parent); $supervisors.Add($supervisorProcess)
  Wait-Ready
  Stop-AndVerify $parent $supervisorProcess "normal-close"

  # Abrupt parent death is observed through the supervisor's parent handle.
  $parent = Start-TestParent
  $supervisorProcess = Start-TestSupervisor $parent
  $parents.Add($parent); $supervisors.Add($supervisorProcess)
  Wait-Ready
  Stop-Process -Id $parent.Id -Force
  if (-not $supervisorProcess.WaitForExit(5000)) { throw "Supervisor did not observe forced desktop-parent termination." }
  $childPid = [int](Get-Content -LiteralPath $childPidFile | Select-Object -First 1)
  Assert-PortClosed
  Assert-ProcessGone $childPid "forced-parent fixture descendant"

  # The same port is reusable after both cleanup paths.
  $parent = Start-TestParent
  $supervisorProcess = Start-TestSupervisor $parent
  $parents.Add($parent); $supervisors.Add($supervisorProcess)
  Wait-Ready
  Stop-AndVerify $parent $supervisorProcess "second-launch"

  Write-Output "PASS: normal close, forced parent termination, descendant cleanup, bounded port release, and second launch"
} finally {
  foreach ($process in $supervisors) {
    if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
  foreach ($process in $parents) {
    if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $buildRoot -Recurse -Force -ErrorAction SilentlyContinue
}
