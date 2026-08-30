[CmdletBinding()]
param(
  [string]$Artifact = ""
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") {
  Write-Output "SKIP: packaging smoke requires Windows x64 and WebView2"
  exit 0
}
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "The packaging smoke requires an x64 Windows runner (received $env:PROCESSOR_ARCHITECTURE)."
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
if ([string]::IsNullOrWhiteSpace($Artifact)) {
  $artifactDirectory = Join-Path $repo "artifacts"
  $artifact = Get-ChildItem -LiteralPath $artifactDirectory -Filter "*Setup.zip" -File | Select-Object -First 1
  if ($null -eq $artifact) { throw "No Hutch Setup ZIP found under $artifactDirectory. Run hutch run build:stable first." }
  $Artifact = $artifact.FullName
}
if (-not (Test-Path -LiteralPath $Artifact -PathType Leaf)) { throw "Setup ZIP does not exist: $Artifact" }

$root = Join-Path ([IO.Path]::GetTempPath()) ("dsh-electronbun-packaging-" + [Guid]::NewGuid().ToString("N"))
$process = $null
try {
  Expand-Archive -LiteralPath $Artifact -DestinationPath $root -Force
  $executable = Get-ChildItem -LiteralPath $root -Filter "*.exe" -File -Recurse |
    Where-Object {
      $_.Name -notlike "*uninstall*" -and
      $_.Name -notlike "*setup*" -and
      $_.Name -notlike "*supervisor*"
    } |
    Select-Object -First 1
  if ($null -eq $executable) { throw "Setup ZIP contains no application executable." }

  $process = Start-Process -FilePath $executable.FullName -PassThru -WindowStyle Normal
  # The native WebView2 window is initially the packaged loading view. The
  # fixture's HTTP endpoint is the observable hand-off target after readiness.
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:43173/health" -TimeoutSec 1
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        $ui = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:43173/" -TimeoutSec 1
        if ($ui.StatusCode -lt 200 -or $ui.StatusCode -ge 300 -or $ui.Content -notmatch 'data-ready="true"') {
          throw "Fixture UI endpoint did not expose its ready marker."
        }
        Write-Output "PASS: packaged host reached the fixture readiness endpoint through native WebView2 startup"
        exit 0
      }
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  throw "Packaged host did not reach the fixture readiness endpoint within 15 seconds."
} finally {
  if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
