[CmdletBinding()]
param(
  [string]$AppPath = ""
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") {
  Write-Output "SKIP: packaging smoke requires Windows 11 x64 and WebView2"
  exit 0
}
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "The packaging smoke requires a Windows 11 x64 runner (received $env:PROCESSOR_ARCHITECTURE)."
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
if ([string]::IsNullOrWhiteSpace($AppPath)) {
  $devBuild = Join-Path $repo "build"
  $candidate = Get-ChildItem -LiteralPath $devBuild -Filter "*.exe" -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -notlike "*uninstall*" -and
      $_.Name -notlike "*setup*" -and
      $_.Name -notlike "*supervisor*"
    } |
    Select-Object -First 1
  if ($null -eq $candidate) {
    throw "No Hutch dev runnable app executable found under $devBuild. Run bun run build:dev first."
  }
  $AppPath = $candidate.FullName
}
if ($AppPath -match "(?i)\.zip$") {
  throw "Packaging smoke accepts a Hutch dev runnable app executable, not a Setup ZIP. Stable installer execution is a separate release gate."
}
if (-not (Test-Path -LiteralPath $AppPath -PathType Leaf)) {
  throw "Hutch dev runnable app executable does not exist: $AppPath"
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("dsh-electrobun-packaging-" + [Guid]::NewGuid().ToString("N"))
$childPidFile = Join-Path $root "descendant.pid"
$markerFile = Join-Path $root "navigation-marker.txt"
$port = 43173
$readiness = "http://127.0.0.1:$port/health"
$oldFixturePort = $env:DSH_FIXTURE_PORT
$oldChildPidFile = $env:DSH_FIXTURE_CHILD_PID_FILE
$oldMarkerFile = $env:DSH_NAVIGATION_MARKER_FILE
$processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Restore-Environment {
  if ($null -eq $oldFixturePort) { Remove-Item Env:DSH_FIXTURE_PORT -ErrorAction SilentlyContinue } else { $env:DSH_FIXTURE_PORT = $oldFixturePort }
  if ($null -eq $oldChildPidFile) { Remove-Item Env:DSH_FIXTURE_CHILD_PID_FILE -ErrorAction SilentlyContinue } else { $env:DSH_FIXTURE_CHILD_PID_FILE = $oldChildPidFile }
  if ($null -eq $oldMarkerFile) { Remove-Item Env:DSH_NAVIGATION_MARKER_FILE -ErrorAction SilentlyContinue } else { $env:DSH_NAVIGATION_MARKER_FILE = $oldMarkerFile }
}

function Wait-NavigationMarker([System.Diagnostics.Process]$process, [int]$seconds = 20) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($process.HasExited) { throw "Hutch dev app exited before WebView2 navigation marker (code $($process.ExitCode))." }
    if (Test-Path -LiteralPath $markerFile -PathType Leaf) {
      $marker = (Get-Content -LiteralPath $markerFile -Raw).Trim()
      if ($marker -eq "reference-sidecar-ready") { return }
      throw "Unexpected WebView2 navigation marker: $marker"
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Hutch dev app did not emit the WebView2 navigation marker within $seconds seconds."
}

function Assert-PortClosed {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $readiness -TimeoutSec 1 | Out-Null
    throw "Fixture port $port is still serving after the host window closed."
  } catch {
    $message = $_.Exception.Message
    if ($message -match "refused|actively refused|could not establish|target machine") { return }
    throw
  }
}

function Assert-DescendantGone {
  if (-not (Test-Path -LiteralPath $childPidFile -PathType Leaf)) {
    throw "The fixture did not publish its descendant PID."
  }
  $childPid = [int](Get-Content -LiteralPath $childPidFile | Select-Object -First 1)
  if ($childPid -le 0) { throw "The fixture published an invalid descendant PID." }
  if (Get-Process -Id $childPid -ErrorAction SilentlyContinue) {
    throw "Fixture descendant (PID $childPid) survived host-window cleanup."
  }
}

function Close-HostWindow([System.Diagnostics.Process]$process, [string]$label) {
  if ($process.HasExited) { throw "$label Hutch dev app exited before the host-window close." }
  if (-not $process.CloseMainWindow()) { throw "$label could not send WM_CLOSE to the native host window." }
  if (-not $process.WaitForExit(10000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "$label did not exit after the real host-window close."
  }
  Assert-PortClosed
  Assert-DescendantGone
}

try {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $env:DSH_FIXTURE_PORT = $port.ToString()
  $env:DSH_FIXTURE_CHILD_PID_FILE = $childPidFile
  $env:DSH_NAVIGATION_MARKER_FILE = $markerFile

  for ($launch = 1; $launch -le 2; $launch += 1) {
    if (Test-Path -LiteralPath $markerFile) { Remove-Item -LiteralPath $markerFile -Force }
    if (Test-Path -LiteralPath $childPidFile) { Remove-Item -LiteralPath $childPidFile -Force }
    $process = Start-Process -FilePath $AppPath -PassThru -WindowStyle Normal
    $processes.Add($process)
    Wait-NavigationMarker $process
    Write-Output "PASS: launch $launch reached the sidecar through an actual WebView2 navigation callback"
    Close-HostWindow $process "Launch $launch"
  }

  Write-Output "PASS: real host-window close cleaned the process tree and port; the fixture port was reusable"
  Write-Output "Stable Setup ZIP installer execution is intentionally unrun and remains a separate release gate."
} finally {
  foreach ($process in $processes) {
    if ($null -ne $process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Restore-Environment
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
