$ErrorActionPreference = 'Stop'
$machine = Get-CimInstance Win32_ComputerSystem
if ($machine.Manufacturer -ne 'SAHM-QA-VM' -or $machine.Model -ne 'SAHM-QA-QEMU' -or !(Test-Path -LiteralPath 'C:\SahmLab\owned-vm.txt')) {
  throw 'This test may run only inside the dedicated SAHM QEMU guest.'
}
$media = @([IO.Directory]::GetLogicalDrives() | Where-Object { Test-Path -LiteralPath ($_ + 'SAHMVM.TAG') })[0]
$configurationPath = if ($media) { Join-Path $media 'test-phase.json' } else { $null }
$diskResults = (Test-Path -LiteralPath 'C:\SahmLab\phase.txt') -and $configurationPath -and (Test-Path -LiteralPath $configurationPath) -and ((Get-Content -LiteralPath $configurationPath -Raw -Encoding utf8 | ConvertFrom-Json).resultTransport -eq 'disk')
if ($diskResults) {
  $generation = (Get-Content -LiteralPath (Join-Path $media 'SAHMCHK.JSON') -Raw -Encoding utf8 | ConvertFrom-Json).generation
  $resultDrives = @([IO.Directory]::GetLogicalDrives() | Where-Object { (Test-Path -LiteralPath ($_ + 'SAHMRES.TAG')) -and (Get-Content -LiteralPath ($_ + 'SAHMRES.TAG') -Raw -Encoding utf8).Trim() -eq $generation })
  if ($resultDrives.Count -ne 1) { throw 'Exactly one owned VM result disk required.' }
  $serial = New-Object PSObject -Property @{ Path = (Join-Path $resultDrives[0] 'EVENTS.LOG'); Encoding = (New-Object Text.UTF8Encoding($false)) }
  $serial | Add-Member -MemberType ScriptMethod -Name WriteLine -Value {
    param([string]$message)
    $bytes = $this.Encoding.GetBytes($message + [Environment]::NewLine)
    $stream = [IO.File]::Open($this.Path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    try { [void]$stream.Seek(0, [IO.SeekOrigin]::End); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
  }
} else {
  $serial = New-Object IO.Ports.SerialPort 'COM1',115200
  $serial.WriteTimeout = 10000
  $serial.Encoding = New-Object Text.UTF8Encoding($false)
  $serial.Open()
}
function Emit($kind, $data) {
  $message = @{ event = $kind; data = $data; utc = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 12 -Compress
  $serial.WriteLine('SAHM_VM_EVENT ' + $message)
}
try {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Emit 'guest-ready' @{ os = (Get-CimInstance Win32_OperatingSystem).Caption; build = [Environment]::OSVersion.Version.ToString(); administrator = $isAdmin; machine = $machine.Model }
  if ($isAdmin) { throw 'Installer acceptance must run as a standard guest user.' }
  $phasePath = 'C:\SahmLab\phase.txt'
  if (!(Test-Path -LiteralPath $phasePath)) {
    'ready' | Set-Content -LiteralPath $phasePath -Encoding ascii
    Emit 'provisioned' @{ standardUser = $true; installerExecuted = $false }
  } else {
    $media = (Get-Content -LiteralPath 'C:\SahmLab\media.txt' -Raw).Trim()
    if (!(Test-Path -LiteralPath ($media + '\SAHMVM.TAG'))) {
      $media = @([IO.Directory]::GetLogicalDrives() | Where-Object { Test-Path -LiteralPath ($_ + 'SAHMVM.TAG') })[0]
    }
    $tests = Join-Path $media 'guest-tests.ps1'
    if (Test-Path -LiteralPath $tests) { & $tests -Serial $serial -Media $media }
    else { Emit 'awaiting-test-payload' @{ phase = (Get-Content -LiteralPath $phasePath -Raw).Trim() } }
  }
} catch {
  Emit 'failed' @{ message = $_.Exception.Message; stack = $_.ScriptStackTrace }
} finally {
  if ($serial -is [IO.Ports.SerialPort]) { $serial.Close() }
  & shutdown.exe /s /t 2
}
