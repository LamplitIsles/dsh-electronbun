# A disposable desktop-parent stand-in for the native lifecycle gate. The
# supervisor watches this process handle; ending it exercises abrupt parent
# termination without placing the parent itself in the Job Object.
$ErrorActionPreference = "Stop"
while ($true) {
  Start-Sleep -Seconds 1
}
