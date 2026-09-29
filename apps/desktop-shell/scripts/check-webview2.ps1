# One-shot detection for ADR pending-measurement item 1: WebView2 Runtime
# presence on THIS machine. Detection surface: the pv value under the fixed
# Evergreen Runtime GUID below, across the three standard install views
# (HKLM 32-bit view / HKLM native view / HKCU per-user). Any hit = present.
# Bootstrap (download/run the Evergreen Bootstrapper) is an EXTERNAL WRITE
# and intentionally out of scope here: see apps/desktop-shell/README.md
# (maintainer smoke checklist) for the manual steps.
#
# NOTE: kept ASCII-only on purpose - Windows PowerShell 5.1 reads BOM-less
# files as ANSI and UTF-8 Chinese comments break parsing (measured).
$runtimeGuid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$keys = @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$runtimeGuid",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$runtimeGuid",
  "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$runtimeGuid"
)
$found = $false
foreach ($key in $keys) {
  if (Test-Path $key) {
    $pv = (Get-ItemProperty -Path $key -Name pv -ErrorAction SilentlyContinue).pv
    if ($pv) {
      Write-Output "FOUND         $key  pv=$pv"
      $found = $true
    } else {
      Write-Output "PRESENT_NO_PV $key"
    }
  } else {
    Write-Output "ABSENT        $key"
  }
}
if ($found) {
  Write-Output 'RESULT: WebView2 Runtime IS present (see pv above)'
  exit 0
}
Write-Output 'RESULT: WebView2 Runtime NOT found in any standard install view'
exit 1
